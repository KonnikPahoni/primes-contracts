tolk 1.4

// ============================================================================
// TON PRIMES — MOCK Tonstakers liquid-staking pool. TEST-ONLY. D-151 / §4.3.2.
//
// This is NOT a protocol contract. It exists so the staked-reserve specs can
// drive `primes_ratchet.tolk`'s `stake`/`unstake`/`harvest` legs against a
// counterparty that actually PARSES the messages the way the real pool does,
// instead of a plain treasury stand-in that accepts any payload unconditionally
// and so proves nothing about wire-format correctness. `@ton/sandbox` is its
// primary home and the only place its economics are proved.
//
// IT IS ALSO DEPLOYED TO TESTNET, and only to testnet (P4). There is no
// Tonstakers pool on testnet and there cannot be a useful one — the tsTON rate
// only moves when a Controller lends to an Approver-approved validator that wins
// a testnet election (D-151 P0 point 1) — so a testnet genesis points all five of
// §4.3.2's addresses at this contract and thereby proves the WIRING: the two
// one-shot wallet bootstraps, the venue in the ratchet's init data, the timelock
// queue. It proves nothing about the rate, which is why the sandbox specs remain
// the primary surface. It therefore DOES get an entry in
// docs/testnet-deployment.md.
//
// IT MUST NEVER REACH MAINNET, and that is enforced by the network and not by a
// config value: `deployGenesis.ts`'s `resolveStakingVenue` only constructs it
// when the host network is testnet, and its `--skew-safe` sender refuses
// to run at all off its hardwired testnet endpoint. Its knobs are unauthenticated
// (see below) and it would take real TON out of `pending` and never give it back.
//
// It stands in for THREE upstream contracts at once:
//
//   1. the LIQUID-STAKING POOL (`contracts/pool.func`) — takes `deposit#47d54391`,
//      skims the flat fee, and answers withdrawals;
//   2. the POOL-JETTON MINTER — the tsTON supply the pool mints and re-mints; and
//   3. the RATCHET'S OWN tsTON JETTON WALLET — the contract that receives the
//      TEP-74 `burn#595f07bc` that IS a withdrawal request.
//
// The same collapse `mock_dedust_vault.tolk` performs when it doubles as the
// ratchet's PRIMES wallet, and for the same reason: the property under test is
// "does the ratchet's staking round-trip parse against the real wire format",
// not Tonstakers' internal contract topology. One consequence to keep in mind
// when reading a trace: the burn's sender and the withdrawal's destination are
// the ratchet itself, because there is no wallet hop in between.
//
// "Pay the burn's sender" is faithful to the real pool, not a shortcut. The
// real pool pays `from_address`, the owner of the burning wallet, and ignores
// the burn's `response_address` (`pool::withdraw`, "response will be
// ignored"). With the wallet hop collapsed, the sender IS that owner. So a
// stranger's burn that names the ratchet as its response address pays the
// stranger, here as on chain.
//
// Every wire value it handles is read from `shared/opcodes.ts`'s RATCHET
// namespace, which sourced them from `ton-blockchain/liquid-staking-contract`
// @ main on 2026-09-20 — file and line are on each entry there. The three
// behaviours below mirror, in order:
//
//   - DEPOSIT, `pool.func:288-301` — flat `DEPOSIT_FEE`, mint at the pool rate,
//     reply with a `transfer_notification` AND an `excesses`. The ratchet learns
//     the tsTON rate from this leg and from nothing else (D-151), so the notified
//     `amount` is the one number in this mock that matters most.
//   - BURN, `pool.func:190-240` — the three withdrawal outcomes: an immediate
//     fill out of the pool's free-TON buffer, a `fill_or_kill` bounce-back that
//     RE-MINTS the jettons, and a payout-bill NFT for the ~36 h round-end exit.
//   - BILL SETTLEMENT, `payout_nft/nft-collection.func:262-268` — the bill's TON
//     share, arriving as `payout_distributed_asset`.
//
//   - NON-OPTIMISTIC DEPOSITS, `pool.func:291-301` with `optimistic_deposit`
//     off (governor-settable, `:269-272`): the deposit becomes a payout BILL
//     (`pool_mint_helpers.func:35-67`), announced by `ownership_assigned` alone,
//     and the tsTON arrives at round end as a jetton TRANSFER from the payout
//     collection's wallet (`payout_nft/nft-collection.func:239-258`) — so its
//     `from` is the collection, NEVER `addr_none` (audit H2). `SetOptimistic`
//     flips the mode and names the collection; `SettleDepositBill` pays the bill.
//
// The knobs (`SetRate`, `SetBuffer`, `SettleBill`, `SetDedustTon`,
// `SetOptimistic`, `SettleDepositBill`) are UNAUTHENTICATED. This is a
// sandbox double, not a contract with an owner: any sender may turn any of them,
// exactly as `mock_dedust_vault.tolk`'s `SetPrice` is owner-checked only because
// that mock happens to carry an owner field. Do not read the absence of a check
// here as a pattern for a real contract.
// ============================================================================

// `pool.func:79`. A FLAT fee off the top of every deposit, not a percentage —
// which is why the ratchet's stake minimum is an economic parameter and not a
// dust guard.
const DEPOSIT_FEE: coins = 1000000000;                 // 1 TON

// `pool.func:288-301`'s `TRANSFER_NOTIFICATION_AMOUNT`.
const TRANSFER_NOTIFICATION_AMOUNT: coins = 100000000; // 0.1 TON

// The slice of the deposit fee this mock leaves unreserved so the trailing
// `excesses` has something to carry. Upstream's own `excesses` carries whatever
// its `raw_reserve` left, which is dust of an unpredictable size; pinning a
// figure here keeps a sandbox assertion reproducible without changing the shape
// (reserve, then CARRY_ALL_BALANCE) the ratchet has to survive.
const EXCESSES_BUDGET: coins = 50000000;               // 0.05 TON

// `payout_nft/nft-collection.func:19`, `jetton_transfer_notification_value`:
// the forward a bill payout's transfer carries, so the notification the
// ratchet's tsTON handler runs on has exactly this much gas.
const BILL_NOTIFICATION_VALUE: coins = 10000000;       // 0.01 TON
// `payout_nft/op-codes.func:15`, `op::distributed_asset`.
const PAYOUT_DISTRIBUTED_ASSET_OP: int = 0xdb3b8abd;

// D-151 leg 2. The mock stands in for ONE MORE upstream contract than its header
// originally listed: DeDust's tsTON jetton vault and the native vault that pays
// a jetton -> TON swap out. It has to, because the ratchet's leg-2 swap is a
// TEP-74 `transfer` sent to its OWN tsTON wallet — and this contract IS that
// wallet, so the swap cannot reach a separate DeDust double without a wallet hop
// that does not exist here. Same collapse, same reason as the other three.
const DEDUST_SWAP_JETTON_OP: int = 0xe3a0d482;

// Five `coins` plus an address is 1142 bits at the compiler's worst case and
// ~500 in any sandbox run — a mock never holds nanoton counts anywhere near
// 2^124. Suppressed rather than split into a ref cell, which would add a hop to
// a test double for no gain.
@overflow1023_policy("suppress")
struct Storage {
    // tsTON per TON, as a fraction: `rateNum` TON buys `rateDen` tsTON.
    // "1 tsTON = 1.05 TON" is rateNum = 1.05 TON, rateDen = 1 TON.
    //
    // Seeded 0/1 by the wrapper's default so this mock CANNOT MINT BY ACCIDENT —
    // the same idea as `mock_dedust_vault.tolk`'s price: a test that forgets to
    // set a rate gets a hard `assert(minted > 0)` failure, not a silent zero-tsTON
    // deposit that looks like a fill.
    rateNum: coins
    rateDen: coins
    // The immediate-withdrawal buffer. A burn fills out of this or it does not
    // fill at all; `SetBuffer` is how a test chooses which of the three
    // withdrawal legs the ratchet takes.
    freeTon: coins
    // tsTON this pool has minted to its depositors and not yet burned. The burn
    // path asserts against it, so a test cannot withdraw a position it never
    // opened.
    tstonSupplyOwed: coins
    // TON owed on an unfilled withdrawal — 0 when there is no bill outstanding.
    // Upstream this is an NFT with its own address; here it is two fields,
    // because the ratchet only ever sees the two messages a bill sends.
    pendingBill: coins
    // `any_address`, not `address`: addr_none until the first bill is minted.
    billOwner: any_address
    // Leg 2's DEX depth, kept SEPARATE from `freeTon` on purpose: the case the
    // exit machine exists for is "the pool cannot fill immediately but the DEX
    // can", and one shared buffer cannot express it.
    dedustTon: coins
    // `pool.func:291` `optimistic_deposit`. The wrapper defaults it ON, which is
    // the live pool's setting and what every spec before audit H2 assumed.
    optimistic: bool
    // A non-optimistic deposit's bill: TON credited, awaiting round end. One
    // slot — no spec holds two deposit bills open at once.
    depositBill: coins
    depositBillOwner: any_address
    // The payout collection whose tsTON wallet pays the bill — the `from` the
    // ratchet sees. MUST NOT be this mock's own address: the mock is also
    // DeDust's tsTON vault, and leg 2's refusal is told apart by `from`.
    billCollection: address?
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// `contracts/op-codes.func:41`, `contracts/interaction.tlb:52`. The header and
// nothing else — the deposited amount IS the message value.
struct (0x47d54391) TonstakersDeposit {
    queryId: uint64
}

// TEP-74's burn, which on the pool jetton IS the withdrawal request. The two
// flags ride in `custom_payload` as two bare bits; see the handler.
struct (0x595f07bc) TstonBurn {
    queryId: uint64
    amount: coins
    responseAddr: address
    customPayload: cell?
}

// `contracts/op-codes.func:43`. NOTE THE SHAPE: the body carries NO amount. The
// filled TON appears only as the message VALUE, mixed with whatever is left of
// the burner's own attached gas. That is the single most important fact this
// mock exists to reproduce — a ratchet that tries to read an amount out of this
// body underflows, and a ratchet that treats the value as pure withdrawal
// over-counts.
struct (0x0a77535c) TonstakersWithdrawal {
    queryId: uint64
}

// TEP-74, as the pool jetton's minter sends it: on a fresh mint and again on a
// `fill_or_kill` re-mint.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address?
    // TEP-74 `forward_payload:(Either Cell ^Cell)`. One zero bit — Either-left,
    // empty inline payload — which is the standard's own encoding of "none" and
    // what `primes_ratchet.tolk` reads as `RemainingBitsAndRefs`. Not a `cell`
    // field: that would serialise a bare ref with no discriminator in front of
    // it, which is the R20 misparse.
    forwardPayload: uint1
}

// The bill payout as the ratchet's tsTON wallet delivers it: `from` = the
// payout collection (`jetton-wallet.func:103`, `:177`), and the forward payload
// is the collection's own `op::distributed_asset` written INLINE
// (`nft-collection.func:254-255`) — Either-left, then the 32-bit op.
struct (0x7362d09c) BillPayoutNotification {
    queryId: uint64
    amount: coins
    sender: address?
    forwardPayloadInline: uint1
    distributedAsset: uint32
}

struct (0xd53276db) Excesses {
    queryId: uint64
}

// `payout_nft/nft-item.func:193-197`, byte for byte: the freshly minted bill
// announcing itself to its owner. `prevOwner` is addr_none (two zero bits) and
// the forward payload is one zero bit, because the bill has no previous owner
// and nothing to forward.
struct (0x05138d91) PayoutOwnershipAssigned {
    queryId: uint64
    prevOwner: any_address
    forwardPayload: uint1
}

// `payout_nft/nft-collection.func:262-268`: the bill's TON share at round end.
struct (0xdb3b8abd) PayoutDistributedAsset {
    queryId: uint64
}

// --- harness knobs, unauthenticated (see the header) -------------------------

struct (0x92000030) SetRate {
    queryId: uint64
    rateNum: coins
    rateDen: coins
}

struct (0x92000031) SetBuffer {
    queryId: uint64
    freeTon: coins
}

// Drives the ~36 h round-end payout without waiting for it. No upstream
// counterpart — upstream this is a governance round closing.
struct (0x92000032) SettleBill {
    queryId: uint64
}

struct (0x92000033) SetDedustTon {
    queryId: uint64
    dedustTon: coins
}

// `governor::set_deposit_settings` (`pool.func:269-272`), plus the payout
// collection a non-optimistic bill will be paid from.
struct (0x92000034) SetOptimistic {
    queryId: uint64
    optimistic: bool
    collection: address
}

// Round end for a NON-OPTIMISTIC deposit: mint at the CURRENT rate and pay the
// bill the way the collection does. Upstream this is a round closing.
struct (0x92000035) SettleDepositBill {
    queryId: uint64
}

// TEP-74's transfer, as the ratchet's own tsTON wallet receives it. Two callers
// and the forward payload tells them apart: leg 2 carries DeDust's
// `swap#e3a0d482`, `harvest()` carries nothing.
struct (0x0f8a7ea5) Transfer {
    queryId: uint64
    amount: coins
    destination: address
    responseAddr: address?
    customPayload: cell?
    forwardTonAmount: coins
    forwardPayload: RemainingBitsAndRefs
}

// DeDust's NATIVE-vault swap, which this mock also answers for -- see the note
// on `DEDUST_SWAP_JETTON_OP`. It exists so ONE address can be the ratchet's
// `dedustNativeVault` in a spec that needs both a `flush()` (to spend `pending`
// below the reserve, which is the only way `unstake` ever becomes callable) and
// leg 2's payout, whose sender check is that same address.
//
// IT SWALLOWS THE TON AND REPLIES WITH NOTHING, which is what a FILLED swap looks
// like from the ratchet's side: the TON leaves for the venue and the PRIMES come
// back later, from the ratchet's PRIMES wallet, as the `transfer_notification`
// that is the only fill signal there is (GAUNTLET B2.1). A spec drives that half
// itself, from whatever address it wired as the burn wallet.
struct (0xea06185d) DedustSwap {
    queryId: uint64
    rest: RemainingBitsAndRefs
}

// `payout#474f86cf` as DeDust's NATIVE vault pays a filled jetton -> TON swap:
// the TON is the message value and `payload` is the sender's own
// `reject_payload` echoed back, which the ratchet sends as `none`.
struct (0x474f86cf) DedustPayout {
    queryId: uint64
    payload: uint1
}

type AllowedMessage = TonstakersDeposit | TstonBurn | SettleBill | SetRate | SetBuffer | SetDedustTon | Transfer | DedustSwap
    | SetOptimistic | SettleDepositBill;

// The mint (and re-mint) reply pair. Upstream sends BOTH on a deposit and both
// on a `fill_or_kill` revert, and the ratchet must survive both — `excesses`
// arriving at a contract whose catch-all throws 101 is the 2026-09-17 failure
// class in MISTAKES.md, which is exactly what this pair is here to catch.
fun sendMintPair(queryId: int, to: address, amount: coins, keepOnBalance: coins, from: address?) {
    reserveToncoinsOnBalance(keepOnBalance, RESERVE_MODE_AT_MOST);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: TRANSFER_NOTIFICATION_AMOUNT,
        dest: to,
        body: (TransferNotification {
            queryId: queryId,
            amount: amount,
            // Upstream's minter writes `from = addr_none` on every mint and
            // re-mint (`jetton-minter.func:123-131`); leg 2's refund comes from
            // DeDust's tsTON vault, which this mock also is. The ratchet
            // authenticates on exactly this field.
            sender: from,
            forwardPayload: 0,
        }).toCell(),
    }).send(SEND_MODE_REGULAR);
    createMessage({
        bounce: BounceMode.NoBounce,
        value: 0,
        dest: to,
        body: (Excesses { queryId: queryId }).toCell(),
    }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
}

fun onInternalMessage(in: InMessage) {
    val msg = lazy AllowedMessage.fromSlice(in.body);
    var storage = lazy Storage.load();

    match (msg) {
        SetRate => {
            storage.rateNum = msg.rateNum;
            storage.rateDen = msg.rateDen;
            storage.save();
        }

        SetBuffer => {
            storage.freeTon = msg.freeTon;
            storage.save();
        }

        DedustSwap => {
            // Swallowed. See the struct's note.
        }

        SetDedustTon => {
            storage.dedustTon = msg.dedustTon;
            storage.save();
        }

        SetOptimistic => {
            storage.optimistic = msg.optimistic;
            storage.billCollection = msg.collection;
            storage.save();
        }

        SettleDepositBill => {
            assert (storage.depositBill > 0) throw 1306;        // no_bill_outstanding
            assert (storage.billCollection != null) throw 1308; // collection_unset
            val minted = (storage.depositBill * storage.rateDen / storage.rateNum) as coins;
            assert (minted > 0) throw 1303;                      // mint_rounds_to_zero
            val owner = storage.depositBillOwner as address;
            storage.tstonSupplyOwed += minted;
            storage.depositBill = 0;
            storage.save();

            // `nft-collection.func:239-258`: a jetton TRANSFER from the
            // collection's wallet with forward_ton 0.01 TON
            // (`jetton_transfer_notification_value`, :19/:253) and response =
            // the burner, i.e. the bill's owner (:250-251).
            createMessage({
                bounce: BounceMode.NoBounce,
                value: BILL_NOTIFICATION_VALUE,
                dest: owner,
                body: (BillPayoutNotification {
                    queryId: msg.queryId,
                    amount: minted,
                    sender: storage.billCollection,
                    forwardPayloadInline: 0,
                    distributedAsset: PAYOUT_DISTRIBUTED_ASSET_OP,
                }).toCell(),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: BILL_NOTIFICATION_VALUE,
                dest: owner,
                body: (Excesses { queryId: msg.queryId }).toCell(),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        Transfer => {
            // LEG 2, and `harvest()`. A real wallet would hop to the
            // destination's own wallet; this one resolves the trade or delivers
            // the notification directly, because there is no second wallet in a
            // mock that already is three contracts.
            assert (msg.amount <= storage.tstonSupplyOwed) throw 1307; // transfer_exceeds_position
            val balanceBefore = contract.getOriginalBalance() - in.valueCoins;

            // `(Either Cell ^Cell)`, normalised the way primes_jetton_wallet.tolk
            // normalises it — a sender may write either shape and the ratchet
            // writes the ref one.
            var fwd = msg.forwardPayload;
            val fwdRef: cell = fwd.remainingBitsCount() >= 1 && fwd.loadBool()
                ? fwd.loadRef()
                : beginCell().storeSlice(fwd).endCell();
            var fs = fwdRef.beginParse();

            if (fs.remainingBitsCount() >= 32 && fs.preloadUint(32) == DEDUST_SWAP_JETTON_OP) {
                fs.loadUint(32);      // op
                fs.loadAddress();     // SwapStep: pool_addr
                fs.loadUint(1);       // SwapStepParams: kind = given_in$0
                val limit = fs.loadCoins();   // SwapStepParams: limit — the ratchet's own floor
                val tonOut = (msg.amount * storage.rateNum / storage.rateDen) as coins;

                if (tonOut >= limit && tonOut > 0 && tonOut <= storage.dedustTon) {
                    storage.dedustTon -= tonOut;
                    storage.tstonSupplyOwed -= msg.amount;
                    storage.save();
                    val keep = balanceBefore - tonOut;
                    assert (keep >= 0) throw 1305; // mock_under_funded
                    reserveToncoinsOnBalance(keep, RESERVE_MODE_AT_MOST);
                    createMessage({
                        bounce: BounceMode.NoBounce,
                        value: 0,
                        dest: in.senderAddress,
                        body: (DedustPayout { queryId: msg.queryId, payload: 0 }).toCell(),
                    }).send(SEND_MODE_CARRY_ALL_BALANCE);
                    return;
                }

                // REFUSED — the quote could not meet `limit`, or the book is too
                // thin. DeDust pays the INPUT back, which on the jetton side is a
                // transfer home and therefore a notification. `tstonSupplyOwed` is
                // deliberately untouched: nothing was sold.
                sendMintPair(msg.queryId, in.senderAddress, msg.amount, balanceBefore, contract.getAddress());
                return;
            }

            // A plain transfer — `harvest()`. Delivered as a real wallet hop
            // delivers it (`jetton-wallet.func:169-188`): the destination is
            // NOTIFIED ONLY WHEN `forward_ton_amount > 0`, and the notification
            // carries exactly that; the rest goes back as `excesses` to the
            // response address. A forward of 0 is a SILENT transfer — the
            // receiver's balance moves and its code never runs (audit M1).
            storage.tstonSupplyOwed -= msg.amount;
            storage.save();
            if (msg.forwardTonAmount > 0) {
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: msg.forwardTonAmount,
                    dest: msg.destination,
                    body: (TransferNotification {
                        queryId: msg.queryId,
                        amount: msg.amount,
                        sender: in.senderAddress,
                        forwardPayload: 0,
                    }).toCell(),
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            }
            val resp = msg.responseAddr;
            if (resp != null) {
                reserveToncoinsOnBalance(balanceBefore, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: resp,
                    body: (Excesses { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
            }
        }

        TonstakersDeposit => {
            // `pool.func:288-290`: the fee comes off the top, and what is left
            // must be positive — a deposit that cannot pay the fee is refused,
            // not credited at zero.
            assert (in.valueCoins - DEPOSIT_FEE > 0) throw 1301; // deposit_below_fee

            val credited = (in.valueCoins - DEPOSIT_FEE) as coins;
            if (!storage.optimistic) {
                // `pool.func:291-301` -> `request_to_mint_deposit`: a BILL, not
                // tsTON. The bill item announces itself with `ownership_assigned`
                // (`nft-item.func:183-198`: prev_owner none, the deposit's
                // query_id) and nothing else — no mint pair, no excesses.
                storage.depositBill += credited;
                storage.depositBillOwner = in.senderAddress as any_address;
                storage.save();
                reserveToncoinsOnBalance(contract.getOriginalBalance() - EXCESSES_BUDGET, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: in.senderAddress,
                    body: (PayoutOwnershipAssigned {
                        queryId: msg.queryId,
                        prevOwner: createAddressNone(),
                        forwardPayload: 0,
                    }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
                return;
            }
            // DIRECTION: `rateNum` TON buys `rateDen` tsTON, so TON in is
            // MULTIPLIED by `rateDen` and DIVIDED by `rateNum`. At "1 tsTON =
            // 1.05 TON" (rateNum = 1.05e9, rateDen = 1e9) a 10.5 TON credit
            // mints 10 tsTON, not 11.025.
            assert (storage.rateNum > 0) throw 1302;            // rate_unset
            val minted = (credited * storage.rateDen / storage.rateNum) as coins;
            assert (minted > 0) throw 1303;                     // mint_rounds_to_zero

            storage.freeTon += credited;
            storage.tstonSupplyOwed += minted;
            storage.save();

            // Keep the credited TON and the fee; the fee is what pays for the
            // two replies below.
            sendMintPair(msg.queryId, in.senderAddress, minted,
                         contract.getOriginalBalance() - TRANSFER_NOTIFICATION_AMOUNT - EXCESSES_BUDGET, null);
        }

        TstonBurn => {
            assert (msg.amount <= storage.tstonSupplyOwed) throw 1304; // burn_exceeds_position

            // `wrappers/JettonWallet.ts:17-19`: bit 0 `wait_till_round_end`,
            // bit 1 `fill_or_kill`, as two BARE BITS in the custom payload.
            var waitTillRoundEnd = 0;
            var fillOrKill = 0;
            var payloadShort = true;
            val cp = msg.customPayload;
            if (cp != null) {
                var p = cp.beginParse();
                if (p.remainingBitsCount() >= 2) {
                    waitTillRoundEnd = p.loadUint(1);
                    fillOrKill = p.loadUint(1);
                    payloadShort = false;
                }
            }

            val tonOut = (msg.amount * storage.rateNum / storage.rateDen) as coins;
            val balanceBefore = contract.getOriginalBalance() - in.valueCoins;

            if (payloadShort) {
                // `pool.func:190-240`: an absent or short payload is NOT a
                // no-op and NOT a default of zero. The pool's `load_bool`
                // underflows inside its own try/catch and the whole burn is
                // reverted by re-minting the jettons. A spec must be able to
                // prove our ratchet never takes this branch — that is why the
                // mock reproduces it instead of tidying it away.
                sendMintPair(msg.queryId, in.senderAddress, msg.amount, balanceBefore, null);
                return;
            }

            // `pool.func:197-200`: the immediate fill exists only in optimistic
            // mode; otherwise a `fill_or_kill` burn is re-minted (`:197-214`).
            if (storage.optimistic && waitTillRoundEnd == 0 && tonOut > 0 && tonOut <= storage.freeTon) {
                // LEG 1 — immediate fill out of the buffer.
                storage.freeTon -= tonOut;
                storage.tstonSupplyOwed -= msg.amount;
                storage.save();

                val keep = balanceBefore - tonOut;
                assert (keep >= 0) throw 1305; // mock_under_funded
                reserveToncoinsOnBalance(keep, RESERVE_MODE_AT_MOST);
                createMessage({
                    bounce: BounceMode.NoBounce,
                    value: 0,
                    dest: in.senderAddress,
                    body: (TonstakersWithdrawal { queryId: msg.queryId }).toCell(),
                }).send(SEND_MODE_CARRY_ALL_BALANCE);
                return;
            }

            if (fillOrKill == 1) {
                // LEG 2 — cannot fill and the burner said all-or-nothing, so the
                // position is restored exactly as it was and no TON leaves
                // beyond gas. `tstonSupplyOwed` deliberately unchanged.
                sendMintPair(msg.queryId, in.senderAddress, msg.amount, balanceBefore, null);
                return;
            }

            // LEG 3 — the ~36 h exit. The position converts to a bill; the TON
            // arrives later, on `SettleBill`.
            storage.tstonSupplyOwed -= msg.amount;
            storage.pendingBill = tonOut;
            storage.billOwner = in.senderAddress as any_address;
            storage.save();

            reserveToncoinsOnBalance(balanceBefore, RESERVE_MODE_AT_MOST);
            createMessage({
                bounce: BounceMode.NoBounce,
                value: 0,
                dest: in.senderAddress,
                body: (PayoutOwnershipAssigned {
                    queryId: msg.queryId,
                    prevOwner: createAddressNone(),
                    forwardPayload: 0,
                }).toCell(),
            }).send(SEND_MODE_CARRY_ALL_BALANCE | SEND_MODE_IGNORE_ERRORS);
        }

        SettleBill => {
            assert (storage.pendingBill > 0) throw 1306; // no_bill_outstanding
            val owed = storage.pendingBill;
            val owner = storage.billOwner as address;
            storage.pendingBill = 0;
            storage.save();

            createMessage({
                bounce: BounceMode.NoBounce,
                value: owed,
                dest: owner,
                body: (PayoutDistributedAsset { queryId: msg.queryId }).toCell(),
            }).send(SEND_MODE_PAY_FEES_SEPARATELY);
        }

        else => {
            assert (in.body.isEmpty()) throw 101; // wrong_opcode
        }
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // Every message this mock sends is NoBounce — the three legs above and the
    // mint pair all model non-bounceable upstream sends — so nothing can arrive
    // here, and there is no position of its own to restore if something did.
}

get fun getMockPoolConfig(): (int, int, int, int, int, int) {
    val storage = lazy Storage.load();
    return (storage.rateNum, storage.rateDen, storage.freeTon, storage.tstonSupplyOwed,
            storage.pendingBill, storage.dedustTon);
}
