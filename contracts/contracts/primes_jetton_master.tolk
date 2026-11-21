tolk 1.4

// ============================================================================
// TON PRIMES — PRIMES jetton master (TEP-74, mint authority = ledger).
// Phase 3, IMPLEMENTATION_PLAN.md §3 build step 2.
// Storage / trust edges: docs/engineering-spec.md §4.4, §6.
// ============================================================================

struct Storage {
    totalSupply: coins
    ledgerAddr: address
    genesisScriptAddr: address
    genesisSealed: uint8
    walletCode: cell
    ledgerSet: uint8   // D7 (primes_collection.tolk header comment): same circular-address
                       // bootstrap fix, same one-shot pattern as seal_authority.
    // TEP-64 metadata, returned verbatim by `get_jetton_data`. Deployment config, not
    // protocol state: nothing in this contract reads it and no message can change it.
    // Empty is a legal value and is what every test and rehearsal constructs; the genesis
    // deploy is expected to supply the real thing, because a jetton with no content cell
    // renders in wallets as an unnamed token with no decimals.
    content: cell
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Must byte-for-byte match primes_jetton_wallet.tolk's `Storage` layout —
// documented duplication (see primes_item.tolk / primes_collection.tolk
// header comments for the same accepted pattern).
struct WalletStorage {
    balance: coins
    owner: address
    jettonMaster: address
}

fun walletInitData(owner: address, jettonMaster: address): cell {
    return (WalletStorage { balance: 0, owner: owner, jettonMaster: jettonMaster }).toCell();
}

struct (0x178d4519) InternalTransfer {
    queryId: uint64
    amount: coins
    from: address
    responseAddr: address
    forwardTonAmount: coins
    forwardPayload: cell
}

struct (0xd0000001) MintOp {
    queryId: uint64
    to: address
    amount: coins
    forwardTonAmount: coins
}

struct (0xd0000002) MintGenesis {
    queryId: uint64
    to: address
    amount: coins
}

struct (0xd0000003) SealAuthority {
    queryId: uint64
}

struct (0xd0000004) SetLedger {
    queryId: uint64
    ledgerAddr: address
}

struct (0x7bdd97de) BurnNotification {
    queryId: uint64
    amount: coins
    owner: address
    // `address?`, not `address`, since B28 gave this field a reader. TEP-74's
    // `response_destination:MsgAddress` admits `addr_none`, which is a real
    // answer — "keep the change" — and the non-null type cannot represent it.
    // The wallet forwards whatever the burner sent (`primes_jetton_wallet.tolk:256`).
    responseAddr: address?
}

// ============================================================================
// TEP-74's excess return, COMING HOME. `deployAndCredit` names THIS CONTRACT as
// `responseAddr` — the master pays the 0.012 TON wallet-deploy reserve out of
// the value the ledger attached, so the change is the master's and must come
// back to it or the mint path bleeds gas into every wallet it deploys. The
// freshly deployed wallet obliges with `excesses#d53276db`, and until this arm
// existed that message landed in `else => assert (in.body.isEmpty())` and threw
// 101 on EVERY mint.
//
// Measured on testnet 2026-09-17, trace 8c354845…d724a: the 1 TON mint itself
// was exit 0 all the way down — item, jetton, splitter, ratchet, bounty — and
// the trace still reads FAILED in Tonviewer, because a trace is red if any
// transaction in it aborted. Same false alarm shape as the TEP-89 gap above,
// and the same cost: nothing is broken, everything looks broken.
//
// The TON was never at risk (the wallet sends this NoBounce, so the credit
// phase had already landed it here before the compute phase threw), which is
// exactly why it went unnoticed — same reasoning as primes_ratchet.tolk's
// the "A REFUSED DEDUST SWAP DOES NOT BOUNCE" note.
// ============================================================================
struct (0xd53276db) Excesses {
    queryId: uint64
}

// ============================================================================
// TEP-89 — on-chain jetton wallet discovery. THE ONLY WAY A DEX CAN LIST PRIMES.
//
// The TEP-74 get-method block at the bottom of this file already explains why a
// venue that cannot read this jetton cannot list it, and adds `get_jetton_data`
// / `get_wallet_address` for that reason. That fixed the OFF-CHAIN half only. A
// get-method is a read against a snapshot; a CONTRACT cannot call one. When a
// DEX deploys a vault for a jetton, the vault must learn its own wallet address
// on chain, and TEP-89 is the message pair it uses to ask.
//
// Without these two structs, the master answered `provide_wallet_address` with
// `else => assert (in.body.isEmpty()) throw 101`. Measured on testnet
// 2026-09-16: DeDust's factory accepted `create_vault#21cfe02b`, the vault
// deployed and sent `provide_wallet_address#2c76b973` with 0.1464 TON, this
// master threw 101 with `aborted: true`, the message bounced, and the vault
// never reached `is_ready` — it stayed uninit at 0 TON with its stake returned.
// No DeDust pool for PRIMES can ever hold liquidity in that state, which makes
// the ratchet's flush leg (§4.3) unsellable on BOTH networks. The failure is
// silent from the sending side: `create_vault` itself succeeds.
//
// The reply is non-bounceable and carries the request's remaining value (TEP-89
// requires mode 64): the asker paid for the round trip, and a reply that could
// bounce would hand the master back TON it has no handler for.
// ============================================================================
struct (0x2c76b973) ProvideWalletAddress {
    queryId: uint64
    ownerAddress: address
    includeAddress: bool
}

// `ownerAddress` is `(Maybe ^MsgAddress)` — a MAYBE REF, not an inline address,
// and it echoes the request's `includeAddress` flag rather than always being
// present. Same shape note as primes_bounty_vault.tolk's `cell?` fields.
struct (0xd1735400) TakeWalletAddress {
    queryId: uint64
    walletAddress: address
    ownerAddress: cell?
}

type AllowedMessage = MintOp | MintGenesis | SealAuthority | SetLedger | BurnNotification | ProvideWalletAddress
                    | Excesses

// Sized against the measured cost of this send plus the recipient wallet's
// deploy (gas-baseline.json: jetton_master.mint ~5.4k gas, the wallet deploy
// itself ~1.5k gas + storage). The first pass used 0.03 TON here while the
// BANK attaches only 0.02 TON to `mint` — so every rebate mint failed in the
// action phase and bounced, silently delivering no PRIMES at all. Caught by the
// gas-regression suite asserting a non-zero recipient balance
// (docs/phase3-report.md); the value now fits inside what the ledger attaches.
fun deployAndCredit(to: address, amount: coins, forwardTonAmount: coins, walletCode: cell) {
    createMessage({
        bounce: BounceMode.RichBounce,
        // 0.010, down from 0.012 when `forwardTonAmount` stopped being zero on
        // every mint (the TEP-74 notification without which no wallet shows the
        // rebate at all — `MINT_NOTIFY_TON` in primes_ledger.tolk). Both sides
        // moved together so the ledger's hop could shrink 0.02 -> 0.018 rather
        // than grow: §4.1's gas & ops line has no headroom to hand out.
        value: ton("0.010") + forwardTonAmount,
        dest: AutoDeployAddress {
            workchain: 0,
            stateInit: ContractState { code: walletCode, data: walletInitData(to, contract.getAddress()) },
        },
        body: (InternalTransfer {
            queryId: 0,
            amount: amount,
            from: contract.getAddress(),
            responseAddr: contract.getAddress(),
            forwardTonAmount: forwardTonAmount,
            forwardPayload: beginCell().endCell(),
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetLedger => {
            assert (in.senderAddress == storage.genesisScriptAddr) throw 100; // wrong_sender
            assert (storage.ledgerSet == 0) throw 104; // already_processed
            storage.ledgerAddr = msg.ledgerAddr;
            storage.ledgerSet = 1;
            storage.save();
        }

        MintOp => {
            assert (storage.genesisSealed == 1) throw 400; // jetton_authority_sealed (mint only live post-seal)
            assert (in.senderAddress == storage.ledgerAddr) throw 401; // jetton_not_minter
            storage.totalSupply += msg.amount;
            storage.save();
            deployAndCredit(msg.to, msg.amount, msg.forwardTonAmount, storage.walletCode);
        }

        MintGenesis => {
            assert (storage.genesisSealed == 0) throw 400; // jetton_authority_sealed
            assert (in.senderAddress == storage.genesisScriptAddr) throw 401; // jetton_not_minter
            storage.totalSupply += msg.amount;
            storage.save();
            deployAndCredit(msg.to, msg.amount, 0, storage.walletCode);
        }

        SealAuthority => {
            assert (in.senderAddress == storage.genesisScriptAddr) throw 401; // jetton_not_minter
            assert (storage.genesisSealed == 0) throw 104; // already_processed
            // The seal is only final once `ledgerAddr` is the ledger. Genesis deploys
            // it as a placeholder, so a silently failed `SetLedger` would leave the
            // post-seal `MintOp` gate open to the placeholder. `SetLedger` is
            // one-shot, so after this nothing can re-point it.
            assert (storage.ledgerSet == 1) throw 402; // jetton_ledger_unset
            storage.genesisSealed = 1;
            storage.save();
        }

        BurnNotification => {
            // sender must be a wallet this master itself deployed for `owner`.
            val expected = (AutoDeployAddress {
                workchain: 0,
                stateInit: ContractState { code: storage.walletCode, data: walletInitData(msg.owner, contract.getAddress()) },
            }).calculateAddress();
            assert (in.senderAddress == expected) throw 100; // wrong_sender
            storage.totalSupply -= msg.amount;
            storage.save();

            // GAUNTLET.md B28 — TEP-74's excess return, going OUT. The wallet
            // carries the burner's `response_destination` faithfully down to
            // here (`primes_jetton_wallet.tolk:256`) and this arm used to drop
            // it, so every PRIMES burn's remaining value stayed with a contract
            // that HAS NO WITHDRAW PATH (§8). Not a leak to anyone — nobody can
            // take it — but a slow one-way transfer out of the burner's gas
            // budget into the master's, and a standard message the master
            // silently failed to answer.
            //
            // `addr_none` is a real and correct answer, not a missing value: a
            // burner that names nobody is saying it does not want the change
            // (`primes_jetton_wallet.tolk:188-196` reads it the same way on the
            // transfer leg). Then the value stays here, which is the behaviour
            // every burn had before this arm existed.
            val respondTo = msg.responseAddr;
            if (respondTo != null) {
                createMessage({
                    // NoBounce: TEP-74's excess return is fire-and-forget, and a
                    // bounce would land the value back here with nothing to do
                    // about it. IGNORE_ERRORS for the same reason — a burner
                    // that cannot accept its own change must not be able to fail
                    // the burn that already happened above.
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: respondTo,
                    body: (Excesses { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        ProvideWalletAddress => {
            // Permissionless by design: this is public, derivable information —
            // the same value `get_wallet_address` already returns to anyone, and
            // the same computation `deployAndCredit` does at mint. Gating it
            // would gate listing, not abuse.
            val wallet = (AutoDeployAddress {
                workchain: 0,
                stateInit: ContractState { code: storage.walletCode, data: walletInitData(msg.ownerAddress, contract.getAddress()) },
            }).calculateAddress();
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: (TakeWalletAddress {
                    queryId: msg.queryId,
                    walletAddress: wallet,
                    ownerAddress: msg.includeAddress
                        ? beginCell().storeAddress(msg.ownerAddress).endCell()
                        : null,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
        }

        Excesses => {
            // Accept and keep, deliberately without a sender gate. There is no
            // state to move: the value is credited before this code runs, and
            // this is the master's own change walking back one hop. A gate
            // would buy nothing — the worst an impostor can do is donate TON to
            // the contract that pays for wallet deploys.
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // A bounced mint (wallet deploy failed) rolls back totalSupply — standard
    // TEP-74 "mint either fully lands or doesn't" (engineering-spec §5 row 12).
    var storage = lazy Storage.load();
    val rich = lazy RichBounceBody.fromSlice(in.bouncedBody);
    val opcode = rich.originalBody.beginParse().loadUint(32);
    if (opcode == 0x178d4519) {
        val original = lazy InternalTransfer.fromCell(rich.originalBody);
        storage.totalSupply -= original.amount;
        storage.save();
    }
}

get fun getJettonData(): (int, int, address, cell) {
    val storage = lazy Storage.load();
    return (storage.totalSupply, storage.genesisSealed, storage.ledgerAddr, storage.walletCode);
}

get fun getWalletAddress(ownerAddr: slice): slice {
    val storage = lazy Storage.load();
    val owner = ownerAddr.loadAddress();
    val addr = (AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState { code: storage.walletCode, data: walletInitData(owner, contract.getAddress()) },
    }).calculateAddress();
    return beginCell().storeAddress(addr).endCell().beginParse();
}

// ============================================================================
// TEP-74 standard surface
//
// Same reasoning as the TEP-62 block in primes_collection.tolk: method IDs are
// derived from the exact name string, so `getJettonData` above is invisible to
// every wallet, explorer and DEX on TON — they call `get_jetton_data` and
// nothing else. The camelCase getters stay (the ledger, ratchet, read-proxy and
// webapp resolve them by name); these are added alongside.
//
// This is load-bearing rather than cosmetic. PRIMES is half of the ratchet's
// DeDust pair (§4.3): a jetton that a venue cannot read is a jetton that cannot
// be listed, and the flush leg has nowhere to sell into.
// ============================================================================

// (total_supply, mintable, admin_address, jetton_content, jetton_wallet_code).
//
// `mintable` is -1 unconditionally, and that is the honest answer rather than a
// convenient one. `SealAuthority` retires the GENESIS mint path only: after the
// seal, `MintOp` from `ledgerAddr` stays live forever, because that is how every
// composite mint's rebate is emitted (§5). Reporting 0 here would tell a reader
// the supply is fixed, which is the opposite of what the ratchet does.
//
// `admin_address` is the ledger, for the same reason — TEP-74's "admin" is
// defined as the address that may mint, and that is exactly `ledgerAddr`. It is
// worth being precise about what this does and does not concede to §8: the
// ledger is a contract with no owner and no withdraw path, so naming it here
// says "the minter is this code", not "a person holds a key". Returning
// `addr_none` would read as a stronger claim while actually being false.
get fun get_jetton_data(): (int, int, slice, cell, cell) {
    val storage = lazy Storage.load();
    return (
        storage.totalSupply,
        -1, // mintable: the ledger's rebate emission never closes
        beginCell().storeAddress(storage.ledgerAddr).endCell().beginParse(),
        storage.content,
        storage.walletCode
    );
}

get fun get_wallet_address(ownerAddress: slice): slice {
    val storage = lazy Storage.load();
    val owner = ownerAddress.loadAddress();
    val addr = (AutoDeployAddress {
        workchain: 0,
        stateInit: ContractState { code: storage.walletCode, data: walletInitData(owner, contract.getAddress()) },
    }).calculateAddress();
    return beginCell().storeAddress(addr).endCell().beginParse();
}
