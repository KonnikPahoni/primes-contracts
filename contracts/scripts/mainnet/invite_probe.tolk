tolk 1.4

// TON PRIMES — TELEGRAM_INVITES_PLAN.md Phase 0: the invite probe.
//
// Not a protocol contract (it lives under scripts/, outside contracts/contracts,
// so no audit or test scans it). It exists to answer one question before the
// ledger is changed: does a text comment sent by a CONTRACT — not a wallet — show
// as text in a Telegram wallet? It sends exactly what `primes_ledger.tolk`'s
// invite line sends: 0.1 GRAM, NoBounce, mode REGULAR, the comment cell it was
// deployed with. Once, on the first message it receives (its deploy).

struct Storage {
    target: address
    comment: cell     // op 0 + the text, built by shared/invites.ts `inviteCommentCell`
    value: coins      // 0.1 GRAM = primes_ledger.tolk INVITE_TRANSFER_VALUE
    exact: uint1      // 1 (default): pays the forward fee on top, as the ledger does since D-215; 0: fee out of `value`
    sent: uint1
}

fun onInternalMessage(in: InMessage) {
    var st = Storage.fromCell(contract.getData());
    if (st.sent == 1) { return; }
    createMessage({
        bounce: BounceMode.NoBounce,
        value: st.value,
        dest: st.target,
        body: st.comment,
    }).send(st.exact == 1 ? SEND_MODE_REGULAR | SEND_MODE_PAY_FEES_SEPARATELY : SEND_MODE_REGULAR);
    st.sent = 1;
    contract.setData(st.toCell());
}
