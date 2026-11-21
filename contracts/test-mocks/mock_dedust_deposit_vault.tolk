tolk 1.4

// ============================================================================
// TON PRIMES — MOCK DeDust native-vault DEPOSIT_LIQUIDITY. TEST-ONLY.
// GAUNTLET.md R13.
//
// This is NOT a protocol contract. No production contract in this repo builds
// a deposit_liquidity message — R13 exists precisely because the
// donate -> pair -> lock sequence (CONCEPT.md §6 point 3, §5.5.4) is done by a
// human, by hand, on DeDust's own UI, and this mock's only job is to let a
// sandbox test prove the WIRE FORMAT (not our own production code, which does
// not exist yet) is internally consistent with DeDust v2's own published
// schema before anyone builds against it — the same bar V2/V2.1 set for the
// swap leg (`mock_dedust_vault.tolk`).
//
// Every field below is parsed per DeDust v2's own published schema
// (docs.dedust.io/reference/tlb-schemes, cross-checked against a second,
// independent fetch of the same page on 2026-09-12 — both agree byte-for-byte
// on the opcode and field list):
//
//   deposit_liquidity#d55e4686 query_id:uint64 amount:Coins
//                              pool_params:PoolParams
//                              ^[ min_lp_amount:Coins
//                                 asset0_target_balance:Coins
//                                 asset1_target_balance:Coins ]
//                              fulfill_payload:(Maybe ^Cell)
//                              reject_payload:(Maybe ^Cell) = InMsgBody;
//
// NOTE THE `^[ ... ]`: the doc page prints those three fields INLINE and the
// SDK's own builder writes them as a REF. They cannot both be right, and the
// SDK is what mainnet accepts, so this mock follows the SDK. See the parse
// below for the citation.
//   pool_params#_ pool_type:PoolType asset0:Asset asset1:Asset = PoolParams;
//   native$0000 = Asset;
//   jetton$0001 workchain_id:int8 address:uint256 = Asset;
//
// THE FINDING THIS MOCK EXISTS TO CHECK: unlike swap#ea06185d, which carries
// an explicit `recipient_addr` inside `SwapStep.swap_params` (so a caller can
// route proceeds anywhere), deposit_liquidity#d55e4686 has NO recipient field
// anywhere in its schema. There is nothing to parse into a "responseAddr" —
// the LP position that DeDust mints can only ever go to `in.senderAddress`,
// the account that sent this exact message. A contract wanting the LP receipt
// for itself (so it can forward it to `primes_lp_sink.tolk` in the same
// transaction chain) would therefore have to be the one SENDING this message,
// not some address it names inside the payload. This mock's FILL path proves
// that by construction: it never reads a recipient out of the body at all, it
// replies to `in.senderAddress` unconditionally.
//
// This mock only models the NATIVE vault's half of a deposit. DeDust v2 splits
// a two-asset deposit into two independent messages — one to the native vault
// (this schema) and one to the jetton vault (deposit_liquidity#40e108d6,
// carried as a jetton-transfer forward payload, no query_id/amount fields of
// its own since those come from the jetton transfer envelope) — and the pool
// only mints LP once both sides' target balances are met. Modelling the
// jetton-vault half and the two-sided settlement is out of scope for this
// item (research, not a build item); it is the natural R13-follow-up if the
// owner signs off on building the atomic path.
//
// Two outcomes, matching what DeDust's own docs describe (not a bounce
// convention we invented): FILL — minted LP notionally meets min_lp_amount,
// so a TransferNotification-shaped reply stands in for the LP jetton mint.
// REFUND — minted LP would fall short, so DeDust's documented behaviour is a
// graceful refund of the deposited amount, NOT a thrown/bounced transaction
// the way a swap's slippage failure is. This mock models that distinction
// deliberately: REFUND is a normal outbound message, not a `throw`.
// ============================================================================

const DEDUST_DEPOSIT_OP: int = 0xd55e4686;
const SET_LP_RATE_OP: int = 0x92000020;

struct Storage {
    owner: address        // may reconfigure the simulated LP output at any time
    lpNum: coins            // simulated minted LP = amount * lpNum / lpDen
    lpDen: coins
}

fun Storage.load() {
    return Storage.fromCell(contract.getData())
}

fun Storage.save(self) {
    contract.setData(self.toCell())
}

// Mirrors primes_ratchet.tolk's own TransferNotification struct exactly —
// same opcode, same field order, same wire format (TEP-74) — standing in for
// the LP jetton's mint notification the way `mock_dedust_vault.tolk` uses it
// to stand in for a swap fill.
struct (0x7362d09c) TransferNotification {
    queryId: uint64
    amount: coins
    sender: address
    forwardPayload: cell
}

// Not a real DeDust opcode — this mock's own signal for the REFUND outcome, so
// a test can tell "deposit accepted but under-filled, TON returned" apart from
// "deposit filled" without inventing a throw code DeDust itself does not use.
struct (0x92000021) DepositRefunded {
    queryId: uint64
    amount: coins
}

// The inbound shapes are read by hand rather than via Tolk's `struct`/`lazy`
// match, because DeDust's `Asset` is a variable-width union
// (native$0000 = 4 bits; jetton$0001 workchain_id:int8 address:uint256 = 44
// bits) that Tolk's declarative struct parser cannot express — the same
// reason `mock_dedust_vault.tolk`'s `SwapStep`/`SwapParams` ARE plain structs
// (DeDust's swap schema has no such union) while this file cannot follow that
// pattern for `PoolParams.asset0`/`asset1`.
fun onInternalMessage(in: InMessage) {
    var s = in.body;
    val opcode = s.loadUint(32);
    var storage = lazy Storage.load();

    if (opcode == SET_LP_RATE_OP) {
        assert (in.senderAddress == storage.owner) throw 100; // wrong_sender
        s.loadUint(64); // queryId, unused by the mock's own reconfiguration op
        storage.lpNum = s.loadCoins();
        storage.lpDen = s.loadCoins();
        storage.save();
        return;
    }

    assert (opcode == DEDUST_DEPOSIT_OP) throw 101; // wrong_opcode

    val queryId = s.loadUint(64);
    val amount = s.loadCoins();

    // pool_params:PoolParams = pool_type:PoolType asset0:Asset asset1:Asset
    val poolType = s.loadUint(1);
    assert (poolType == 0 || poolType == 1) throw 1302; // bad_pool_type

    val asset0Tag = s.loadUint(4);
    assert (asset0Tag == 0) throw 1301; // asset_not_native — this mock only models the native leg
    val asset1Tag = s.loadUint(4);
    if (asset1Tag == 1) { s.loadInt(8); s.loadUint(256); } // jetton$0001 workchain_id:int8 address:uint256
    if (asset1Tag == 2) { s.loadInt(32); } // extra_currency$0010 currency_id:int32 — not modelled beyond shape

    // `min_lp_amount` AND BOTH TARGET BALANCES RIDE IN A REF, NOT INLINE, and
    // this mock read them inline until 2026-09-16. The docs' TL-B page prints
    // them inline; `@dedust/sdk`'s own `VaultNative.sendDepositLiquidity`
    // builder writes them with `.storeRef(beginCell().storeCoins(minimalLPAmount)
    // .storeCoins(targetBalances[0]).storeCoins(targetBalances[1]).endCell())`.
    // The SDK is what mainnet accepts in practice, so the SDK wins and the doc
    // page is the thing that is wrong. Nothing in this repo BUILDS a deposit
    // (D-100 R1-2 keeps that leg manual), so this was never a live defect —
    // but it was a wire-format claim the test suite certified as true, which is
    // worse than no claim at all if anyone ever builds against it.
    var targets = s.loadRef().beginParse();
    val minLpAmount = targets.loadCoins();
    val asset0TargetBalance = targets.loadCoins();
    val asset1TargetBalance = targets.loadCoins();
    assert (targets.remainingBitsCount() == 0 && targets.remainingRefsCount() == 0) throw 1303; // trailing_data
    val hasFulfill = s.loadUint(1);
    if (hasFulfill == 1) { s.loadRef(); }
    val hasReject = s.loadUint(1);
    if (hasReject == 1) { s.loadRef(); }
    assert (s.remainingBitsCount() == 0 && s.remainingRefsCount() == 0) throw 1303; // trailing_data

    val mintedLp = storage.lpDen > 0 ? amount * storage.lpNum / storage.lpDen : 0;

    // THE FINDING: no recipient is read from the body anywhere above. The
    // reply always targets `in.senderAddress` — the schema gives a caller no
    // other choice.
    if (mintedLp >= minLpAmount) {
        createMessage({
            bounce: BounceMode.NoBounce,
            value: 0,
            dest: in.senderAddress,
            body: (TransferNotification {
                queryId: queryId,
                amount: mintedLp as coins,
                sender: contract.getAddress(),
                forwardPayload: beginCell().endCell(),
            }).toCell(),
        }).send(SEND_MODE_CARRY_ALL_REMAINING_MESSAGE_VALUE);
    } else {
        // Per DeDust's own docs: under-fill is a graceful refund, not a
        // slippage throw — deliberately NOT a `throw`/bounce, unlike the swap
        // mock's REJECT path.
        createMessage({
            bounce: BounceMode.NoBounce,
            value: amount,
            dest: in.senderAddress,
            body: (DepositRefunded { queryId: queryId, amount: amount }).toCell(),
        }).send(SEND_MODE_PAY_FEES_SEPARATELY);
    }
}

fun onBouncedMessage(in: InMessageBounced) {
    // This mock owes nobody anything and holds no position.
}

get fun getMockDepositVaultConfig(): (slice, int, int) {
    val storage = lazy Storage.load();
    return (beginCell().storeAddress(storage.owner).endCell().beginParse(), storage.lpNum, storage.lpDen);
}
