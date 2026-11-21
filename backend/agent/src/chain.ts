/**
 * The live half: get-methods read straight off the chain, and the wallet that signs.
 *
 * CONCEPT.md §9.1 — "the index is for browsing; a number you are about to spend against
 * comes from the chain". Every read here is a `runMethod` against the deployed contract,
 * which is what `act.*` checks itself against before it opens a wallet.
 *
 * The key never leaves this process. There is no service in this project that holds one
 * (D-131.2), and the SDK adds none: a mnemonic goes in, `@ton/crypto` derives the key
 * pair, and the signature is produced locally by `@ton/ton`'s wallet contract.
 */
import { Address, Cell, TonClient, WalletContractV4, internal } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { SendMode, type StateInit } from "@ton/core";
import { factorsCell } from "@ton-primes/shared/factors";
import { factorize, isProbablePrime } from "@ton-primes/shared/primality";

export interface ContractAddresses {
  ledger: string;
  market: string;
  ratchet: string;
  registrar: string;
  /** The main NFT collection — D-212's `name_number` door and `getNaming()`. Only `name()` needs it. */
  collection?: string;
}

export interface LotState {
  found: boolean;
  closed: boolean;
  /** 0 = ascending (composites), 2 = descending buy-now (primes). */
  mode: number;
  p0Nanoton: bigint;
  standingPriceNanoton: bigint;
  minNextBidNanoton: bigint;
}

export class PrimesChain {
  constructor(readonly client: TonClient, readonly addresses: ContractAddresses) {}

  /** `getHead()` on the ledger — the value a mint is checked against on arrival. */
  async head(): Promise<bigint> {
    const res = await this.client.runMethod(Address.parse(this.addresses.ledger), "getHead");
    return res.stack.readBigNumber();
  }

  /** `isKnownPrime(n)` on the ledger. */
  async isKnownPrime(n: bigint): Promise<boolean> {
    const res = await this.client.runMethod(Address.parse(this.addresses.ledger), "isKnownPrime", [
      { type: "int", value: n },
    ]);
    return res.stack.readBigNumber() !== 0n;
  }

  /**
   * `getLot(n)` on the market, reduced to what a bid has to decide on.
   *
   * `minPayment` is the figure a bid must clear, and it is read HERE rather than computed:
   * on the ascending lane it is `high + max(1 TON, 5% · high)` and on the descending one it
   * is the standing price plus `RES_GAS`, both moving without a message.
   */
  async lot(n: bigint): Promise<LotState> {
    const res = await this.client.runMethod(Address.parse(this.addresses.market), "getLot", [
      { type: "int", value: n },
    ]);
    const s = res.stack;
    const found = s.readBigNumber() === 1n;
    if (!found) {
      return { found: false, closed: false, mode: 0, p0Nanoton: 0n, standingPriceNanoton: 0n, minNextBidNanoton: 0n };
    }
    const mode = Number(s.readBigNumber());
    const p0Nanoton = s.readBigNumber();
    const standingPriceNanoton = s.readBigNumber();
    const minNextBidNanoton = s.readBigNumber();
    s.readBigNumber(); // highBid
    s.readAddress(); // highBidder
    s.readBigNumber(); // openedAt
    s.readBigNumber(); // closesAt
    const closed = s.readBigNumber() === 1n;
    return { found: true, closed, mode, p0Nanoton, standingPriceNanoton, minNextBidNanoton };
  }

  /**
   * D-45's bit: has a lot ever claimed `n`? The ledger answers 1/0 below its import frontier
   * and -1 beyond it (D-196), where the mark lives on the block's lot block —
   * `getLotBlockAddress((n - 2) >> 8)`, bit `(n - 2) & 255` of `getWords().claimed` (the
   * ledger's own bitmap indexing). An undeployed lot
   * block is a block no lot has touched.
   */
  async isOffHead(n: bigint): Promise<boolean> {
    const ledger = Address.parse(this.addresses.ledger);
    const local = (await this.client.runMethod(ledger, "isNumberOffHead", [{ type: "int", value: n }])).stack.readBigNumber();
    if (local !== -1n) return local === 1n;
    const block = (await this.client.runMethod(ledger, "getLotBlockAddress", [{ type: "int", value: (n - 2n) >> 8n }])).stack.readAddress();
    if ((await this.client.getContractState(block)).state !== "active") return false;
    const claimed = (await this.client.runMethod(block, "getWords")).stack.readBigNumber();
    return ((claimed >> ((n - 2n) & 255n)) & 1n) === 1n;
  }

  /** `getItemAddress(n)` on the ledger — where `n`'s own NFT item lives. */
  async itemAddress(n: bigint): Promise<string> {
    const res = await this.client.runMethod(Address.parse(this.addresses.ledger), "getItemAddress", [
      { type: "int", value: n },
    ]);
    return res.stack.readAddress().toString();
  }

  /** `getNumberData()` on one item — who owns `n`, and whether the ledger calls it prime. */
  async numberData(itemAddress: string): Promise<{ n: bigint; owner: string; isPrime: boolean }> {
    const res = await this.client.runMethod(Address.parse(itemAddress), "getNumberData");
    return {
      n: res.stack.readBigNumber(),
      owner: res.stack.readAddress().toString(),
      isPrime: res.stack.readBigNumber() === 1n,
    };
  }

  /** `getOwed()` on one item — the §4.1 divisor share standing to its owner, in nanoTON. */
  async owed(itemAddress: string): Promise<bigint> {
    const res = await this.client.runMethod(Address.parse(itemAddress), "getOwed");
    return res.stack.readBigNumber();
  }

  /** Who may name `n` (D-212): item(n)'s `getNamer()`, its CURRENT OWNER. `null` = unminted. */
  async namer(n: bigint): Promise<string | null> {
    const res = await this.itemGet(n, "getNamer");
    const a = res?.stack.readAddressOpt();
    return a ? a.toString() : null;
  }

  /** How many names have been written on `n`: item(n)'s `getAnnotation()` count. */
  async annotationCount(n: bigint): Promise<number> {
    const res = await this.itemGet(n, "getAnnotation");
    return res ? res.stack.readNumber() : 0;
  }

  /** `getNaming()` on the collection — D-212's first-naming and rename fees, nanoTON. */
  async namingFees(): Promise<{ nameFee: bigint; renameFee: bigint }> {
    if (!this.addresses.collection) throw new Error("no collection address; pass addresses.collection");
    const res = await this.client.runMethod(Address.parse(this.addresses.collection), "getNaming");
    return { nameFee: res.stack.readBigNumber(), renameFee: res.stack.readBigNumber() };
  }

  /** How many engravings an era trophy carries: the registrar's `getTrophyAnnotation(n)` count. */
  async trophyAnnotationCount(n: bigint): Promise<number> {
    const res = await this.client.runMethod(Address.parse(this.addresses.registrar), "getTrophyAnnotation", [
      { type: "int", value: n },
    ]);
    return res.stack.readNumber();
  }

  /** `getTrophyRenameFee()` on the registrar — what every engraving after the first costs, nanoTON. */
  async trophyRenameFee(): Promise<bigint> {
    const res = await this.client.runMethod(Address.parse(this.addresses.registrar), "getTrophyRenameFee");
    return res.stack.readBigNumber();
  }

  /** A get-method on item(n); `null` when the item is not deployed (the number is unminted). */
  private async itemGet(n: bigint, method: string) {
    try {
      return await this.client.runMethod(Address.parse(await this.itemAddress(n)), method);
    } catch (err) {
      if (/exit_code:\s*-13\b|non-?active|uninit/i.test(String((err as Error)?.message ?? err))) return null;
      throw err;
    }
  }

  /** `getTrophy(n)` (D-14, §4.7). `transferable` is true iff `n` is one of §7's eight
   *  primorials; `holder` is null while the era is open or nobody recruited during it. */
  async trophy(n: bigint): Promise<{ holder: string | null; transferable: boolean }> {
    const res = await this.client.runMethod(Address.parse(this.addresses.registrar), "getTrophy", [
      { type: "int", value: n },
    ]);
    const holder = res.stack.readAddressOpt();
    return { holder: holder ? holder.toString() : null, transferable: res.stack.readNumber() !== 0 };
  }

  /** `getPending()` on the ratchet — TON waiting for the next `flush()` (§4.3). */
  async pending(): Promise<bigint> {
    const res = await this.client.runMethod(Address.parse(this.addresses.ratchet), "getPending");
    return res.stack.readBigNumber();
  }

  /**
   * `getFlushStatus()` on the ratchet — §4.3.1's floor guard, and the 24h cooldown.
   *
   * `null` when the get-method is not on the deployed contract. `runMethod` answers an
   * absent selector with exit code 11, which is indistinguishable from a real failure in
   * the thrown error, so the caller gets `null` and decides — a missing status must not
   * be read as "no cooldown", which is why `flush()` below only refuses on a POSITIVE one.
   */
  async flushStatus(): Promise<{
    lastAttemptTime: bigint;
    outcome: "never" | "filled" | "bounced";
    amountNanoton: bigint;
    cooldownRemainingSeconds: bigint;
  } | null> {
    const OUTCOMES = ["never", "filled", "bounced"] as const;
    try {
      const res = await this.client.runMethod(Address.parse(this.addresses.ratchet), "getFlushStatus");
      const s = res.stack;
      const lastAttemptTime = s.readBigNumber();
      const outcome = OUTCOMES[Number(s.readBigNumber())] ?? "never";
      return {
        lastAttemptTime,
        outcome,
        amountNanoton: s.readBigNumber(),
        cooldownRemainingSeconds: s.readBigNumber(),
      };
    } catch {
      return null;
    }
  }

  /**
   * `getFloorCache()` on the ratchet — the (T, S) pair the FLOOR GUARD prices against.
   *
   * Not `floor()`'s pair. The ledger's T and S are authoritative and move on every mint;
   * the ratchet holds a mirror pushed with each `PoolInject`, and `computeMinOut` reads the
   * mirror. Anything sizing a flush has to read this one. `null` on a ratchet too old to
   * answer, exactly like `flushStatus()` above, and for the same reason: an absent selector
   * must not be read as a zero floor.
   */
  async floorCache(): Promise<{ tCacheNanoton: bigint; sCacheNanoPrimes: bigint } | null> {
    try {
      const res = await this.client.runMethod(Address.parse(this.addresses.ratchet), "getFloorCache");
      return { tCacheNanoton: res.stack.readBigNumber(), sCacheNanoPrimes: res.stack.readBigNumber() };
    } catch {
      return null;
    }
  }

  /**
   * `getLotPriceFrom(n, factorize(n))` — what `open_lot` will charge for a lot that does not
   * exist yet. F65: a composite is priced on its FACTORED score, and the from-`n`
   * `getLotPrice(n)` is only a lower bound on it (§9.6) — opening at that figure is refused
   * 1003. A prime carries no list, which the contract reads as exactly `getLotPrice(n)`.
   */
  async lotPrice(n: bigint): Promise<bigint> {
    // No list for a prime: call `getLotPrice(n)` itself. A TVM null (the empty map) is a
    // stack item TonClient's v2 serializer refuses outright (G93 run, /trophy/price 500s).
    const res =
      n < 4n || isProbablePrime(n)
        ? await this.client.runMethod(Address.parse(this.addresses.market), "getLotPrice", [{ type: "int", value: n }])
        : await this.client.runMethod(Address.parse(this.addresses.market), "getLotPriceFrom", [
            { type: "int", value: n },
            { type: "cell", cell: factorsCell(factorize(n))! },
          ]);
    return res.stack.readBigNumber();
  }
}

/** A locally-signing wallet. Nothing in this module sends a key anywhere. */
export class LocalWallet {
  private constructor(
    private readonly client: TonClient,
    private readonly wallet: WalletContractV4,
    private readonly secretKey: Buffer,
  ) {}

  static async fromMnemonic(client: TonClient, mnemonic: string): Promise<LocalWallet> {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) {
      throw new Error(`a TON mnemonic is 24 words (got ${words.length}). Fund a DEDICATED wallet for an agent.`);
    }
    const key = await mnemonicToPrivateKey(words);
    return new LocalWallet(client, WalletContractV4.create({ workchain: 0, publicKey: key.publicKey }), key.secretKey);
  }

  get address(): Address {
    return this.wallet.address;
  }

  /**
   * Send one internal message and wait for the wallet's seqno to advance.
   *
   * Both halves matter, for the reason `backend/keeper/src/chain.ts` documents: a wallet
   * transfer is authenticated against a seqno, and `getSeqno()` reports a new value only
   * once the previous message has been included — firing without waiting drops the second
   * message of any pair.
   */
  async send(to: string, body: Cell, value: bigint, timeoutMs = 45_000, init?: StateInit): Promise<{ seqno: number }> {
    const contract = this.client.open(this.wallet);
    const seqno = await contract.getSeqno();
    await contract.sendTransfer({
      seqno,
      secretKey: this.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY,
      // `init` deploys the destination if it is not yet (D-191 point 1: a mint deploys the
      // beneficiary's minter card on the first mint that wallet is part of).
      messages: [internal({ to: Address.parse(to), value, body, bounce: true, init })],
    });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      if ((await contract.getSeqno()) > seqno) return { seqno };
    }
    throw new Error(`wallet seqno did not advance within ${timeoutMs}ms — the message may still land`);
  }
}
