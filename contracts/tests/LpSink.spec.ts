// TON PRIMES — U4: the LP SINK. LOCKED DEPTH, AND NOTHING ELSE.
// CONCEPT.md §3.4 / §5 / §6 point 3 / §8; DECISIONS.md D-100 points 4 and 9;
// invariant TR-6; TREASURY_PLAN.md U4.
//
// WHAT THIS FILE EXISTS TO PROVE, in the order D-100 point 4 states them:
//
//   1. LP GOES IN AND THE COUNTER TALLIES IT. Three deposits, three events, one
//      sum — `getLocked()` and `getEvents()` are the two numbers the liquidity
//      panel reads and there is nothing else to read.
//   2. ONLY THE SINK'S OWN LP WALLET IS BELIEVED. A notification from anywhere
//      else throws 1171, and one that arrives before the one-shot bootstrap
//      throws 1170. Nothing is at risk either way — a contract that cannot send
//      cannot be robbed — but `getLocked()` would stop being an audit if any
//      address could inflate it, and an inflatable "locked depth" on a public
//      panel is exactly the sort of number §9.1 exists to forbid.
//   3. NOTHING CAN EVER COME OUT. Not "the withdraw path is guarded" — there is
//      no send to guard. The compiled code cell contains no `SENDRAWMSG`, which
//      is asserted here against the built bytecode rather than argued from the
//      source. See `hasSendInstruction` below for exactly what that proves and
//      what it does not, and for the positive control that keeps the check from
//      passing vacuously.
//
// WHAT THIS FILE DELIBERATELY DOES NOT ASSERT: anything relating locked depth to
// `T`, `S` or `p_f`. There is no relation — that is D-100 point 4's copy
// constraint, and the reason it is a constraint rather than a comment is that a
// pool's TON/PRIMES composition moves with every trade, so an LP-derived term is
// non-monotonic and would void §5's ratchet theorem. The floor and liquidity are
// two guarantees on two panels. A test tying them together would be the bug.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesLpSink, LpSinkOpcodes } from '../wrappers/PrimesLpSink';
import { ERRORS, LP_SINK } from '../../shared/opcodes';

/** Comfortable margin — CLAUDE.md: a real sender never sends the exact figure. */
const FORWARD = toNano('0.05');

/**
 * TVM instruction encodings, as bit strings.
 *
 * `SENDRAWMSG` (0xFB00) is the ONLY instruction that appends an outbound message
 * to the action list, so its absence from a contract's code is the absence of
 * every send. `SENDMSG` (0xFB08) is checked alongside it because in mode 128+ it
 * both estimates a fee and sends; nothing else in the 0xFBxx family emits a
 * message (0xFB02 `RAWRESERVE` reserves, 0xFB04 `SETCODE` replaces code).
 */
const SENDRAWMSG = '1111101100000000';
const SENDMSG = '1111101100001000';

function bitsOf(cell: Cell): string {
    const bits = cell.bits;
    let s = '';
    for (let i = 0; i < bits.length; i++) s += bits.at(i) ? '1' : '0';
    return s;
}

/**
 * Does this code cell tree contain a send instruction's encoding, at ANY bit
 * offset in any cell?
 *
 * WHAT IT PROVES. The scan is offset-agnostic: it looks for the 16-bit pattern
 * starting at every bit position, not only at byte boundaries. So a `false`
 * result is CONCLUSIVE in the direction that matters — if the bits are nowhere
 * in the code, no execution path can decode them as an instruction, and the
 * contract cannot enqueue an outbound message no matter what is sent to it. That
 * is the permanence claim, and it holds without reading a line of the source.
 *
 * WHAT IT DOES NOT PROVE. The converse is not sound: the same sixteen bits can
 * occur inside an integer literal, a string, or the tail of a longer
 * instruction, so a `true` result is only a REASON TO LOOK, not proof of a send.
 * That asymmetry is why the check is used one way round here — `expect(false)`
 * for the sink, `expect(true)` for a contract that genuinely sends, the latter
 * only as a control that the scanner works at all. It also says nothing about
 * whether a handler is reachable or what a send would do; that is
 * `NoAdminWithdraw.spec.ts`'s lexical pass over `createMessage` sites, which
 * covers the fifteen contracts that DO send. This one needs neither, because the
 * set it enumerates is empty.
 */
function hasSendInstruction(root: Cell): boolean {
    const seen = new Set<string>();
    const stack: Cell[] = [root];
    while (stack.length > 0) {
        const cell = stack.pop()!;
        const key = cell.hash().toString('hex');
        if (seen.has(key)) continue;
        seen.add(key);
        const bits = bitsOf(cell);
        if (bits.includes(SENDRAWMSG) || bits.includes(SENDMSG)) return true;
        for (const ref of cell.refs) stack.push(ref);
    }
    return false;
}

describe('U4 — the LP sink (D-100 points 4 and 9, TR-6)', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let stranger: SandboxContract<TreasuryContract>;
    let provider: SandboxContract<TreasuryContract>;
    /** stands in for the sink's own DeDust LP jetton wallet */
    let lpWallet: SandboxContract<TreasuryContract>;

    let lpSinkCode: Cell;
    /** positive control for the bytecode scan — a contract that does send */
    let positiveControlCode: Cell;

    beforeAll(async () => {
        lpSinkCode = await compile('PrimesLpSink');
        // D-212 deleted the burn sink this used to be; the registrar refunds and
        // pays, so its code carries sends just the same.
        positiveControlCode = await compile('PrimesRegistrar');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        stranger = await blockchain.treasury('stranger');
        provider = await blockchain.treasury('provider');
        lpWallet = await blockchain.treasury('lpWallet');
    });

    async function deploySink(opts: { wire?: boolean } = {}) {
        const s = blockchain.openContract(
            PrimesLpSink.createFromConfig({ genesisScriptAddr: genesisScript.address }, lpSinkCode)
        );
        await s.sendDeploy(deployer.getSender(), toNano('1'));
        if (opts.wire !== false) {
            await s.sendSetWallet(genesisScript.getSender(), {
                lpJettonWalletAddr: lpWallet.address,
                value: FORWARD,
            });
        }
        return s;
    }

    // -----------------------------------------------------------------------
    // 1 — LP in, counters up
    // -----------------------------------------------------------------------

    it('three deposits tally into getLocked() and getEvents()', async () => {
        const sink = await deploySink();
        expect(await sink.getLocked()).toBe(0n);
        expect(await sink.getEvents()).toBe(0);

        const amounts = [toNano('12.5'), toNano('0.000000001'), toNano('7')];
        for (const amount of amounts) {
            const res = await sink.sendTransferNotification(lpWallet.getSender(), {
                amount,
                from: provider.address,
                value: FORWARD,
            });
            expect(res.transactions).toHaveTransaction({
                to: sink.address,
                success: true,
                // THE PROPERTY, OBSERVED RATHER THAN ARGUED: the deposit produces
                // no outbound message. Not a receipt, not an excess-value hop,
                // not an acknowledgement — the sink has no message type to send
                // one with.
                outMessagesCount: 0,
            });
        }

        expect(await sink.getLocked()).toBe(amounts.reduce((a, b) => a + b, 0n));
        expect(await sink.getEvents()).toBe(3);
    });

    it('a deposit whose forward payload rides as a ref is accepted too', async () => {
        // TEP-74 encodes `forward_payload` as `(Either Cell ^Cell)` and the LP
        // wallet is DeDust's, not ours, carrying whatever a stranger composed —
        // so BOTH encodings must parse. The test above covers the inline case
        // (no payload at all); this covers the ref. The contract reads neither:
        // it has exactly one thing it can do with a deposit.
        const sink = await deploySink();
        await sink.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('3'),
            from: provider.address,
            value: FORWARD,
            forwardPayload: beginCell().storeUint(0xdeadbeef, 32).endCell(),
        });
        expect(await sink.getLocked()).toBe(toNano('3'));
        expect(await sink.getEvents()).toBe(1);
    });

    // -----------------------------------------------------------------------
    // 2 — only this contract's own LP wallet is believed
    // -----------------------------------------------------------------------

    it('a notification from a wallet that is not the sink’s own is refused (1171)', async () => {
        const sink = await deploySink();
        const res = await sink.sendTransferNotification(stranger.getSender(), {
            amount: toNano('1000'),
            from: stranger.address,
            value: FORWARD,
        });
        expect(res.transactions).toHaveTransaction({
            to: sink.address,
            success: false,
            exitCode: ERRORS.lp_sink_wrong_wallet,
        });
        expect(await sink.getLocked()).toBe(0n);
        expect(await sink.getEvents()).toBe(0);
    });

    it('a notification before set_wallet is refused (1170)', async () => {
        // Checked BEFORE the address comparison, so the unbootstrapped
        // placeholder in init data can never be impersonated into authority.
        const sink = await deploySink({ wire: false });
        expect((await sink.getLpSinkConfig()).walletSet).toBe(0);

        const res = await sink.sendTransferNotification(lpWallet.getSender(), {
            amount: toNano('1000'),
            from: provider.address,
            value: FORWARD,
        });
        expect(res.transactions).toHaveTransaction({
            to: sink.address,
            success: false,
            exitCode: ERRORS.lp_sink_wallet_unset,
        });
        expect(await sink.getLocked()).toBe(0n);
    });

    it('set_wallet is one-shot and genesis-only', async () => {
        const sink = await deploySink({ wire: false });

        const fromStranger = await sink.sendSetWallet(stranger.getSender(), {
            lpJettonWalletAddr: stranger.address,
            value: FORWARD,
        });
        expect(fromStranger.transactions).toHaveTransaction({
            to: sink.address,
            exitCode: 100, // wrong_sender
        });

        await sink.sendSetWallet(genesisScript.getSender(), {
            lpJettonWalletAddr: lpWallet.address,
            value: FORWARD,
        });
        const cfg = await sink.getLpSinkConfig();
        expect(cfg.walletSet).toBe(1);
        expect(cfg.lpJettonWalletAddr.toString()).toBe(lpWallet.address.toString());
        expect(cfg.genesisScriptAddr.toString()).toBe(genesisScript.address.toString());

        const again = await sink.sendSetWallet(genesisScript.getSender(), {
            lpJettonWalletAddr: stranger.address,
            value: FORWARD,
        });
        expect(again.transactions).toHaveTransaction({
            to: sink.address,
            exitCode: 104, // already_processed
        });
        // The genesis script is NOT an owner: after the one shot it has no
        // privilege here, and the wallet it named is the wallet forever.
        expect((await sink.getLpSinkConfig()).lpJettonWalletAddr.toString()).toBe(
            lpWallet.address.toString()
        );
    });

    it('an unknown opcode is refused; an empty body (deploy, rent top-up) is not', async () => {
        const sink = await deploySink();
        const junk = await deployer.send({
            to: sink.address,
            value: toNano('0.05'),
            body: beginCell().storeUint(0x97000099, 32).storeUint(0, 64).endCell(),
        });
        expect(junk.transactions).toHaveTransaction({
            to: sink.address,
            success: false,
            exitCode: 101, // wrong_opcode
        });

        // TON with an empty body is accepted — and, exactly like the LP, it can
        // never leave. That is rent, not a liability: the contract declares none
        // and appears in no §3.4 reconciliation row.
        const rent = await deployer.send({
            to: sink.address,
            value: toNano('0.5'),
            body: beginCell().endCell(),
        });
        expect(rent.transactions).toHaveTransaction({
            to: sink.address,
            success: true,
            outMessagesCount: 0,
        });
        expect(await sink.getLocked()).toBe(0n);
    });

    // -----------------------------------------------------------------------
    // 3 — the cheapest possible proof of permanence (TR-6)
    // -----------------------------------------------------------------------

    it('the compiled code contains no send instruction — nothing can ever come out', () => {
        // POSITIVE CONTROL FIRST, so this file cannot pass by scanning nothing:
        // the registrar refunds and pays a fee on, so its code MUST contain the pattern.
        // If this line ever goes green-by-accident the assertion below is
        // worthless, which is the failure mode a bytecode scan is prone to.
        expect(hasSendInstruction(positiveControlCode)).toBe(true);

        expect(hasSendInstruction(lpSinkCode)).toBe(false);
    });

    it('the opcode table declares no outbound opcode for this contract', () => {
        // The source-level half of the same claim, kept honest against
        // `shared/opcodes.ts`: two inbound opcodes, and no third key of any
        // kind. A future outbound entry fails here before anyone compiles it.
        expect(Object.keys(LP_SINK).sort()).toEqual(['set_wallet', 'transfer_notification']);
        expect(LP_SINK.set_wallet).toBe(LpSinkOpcodes.SetWallet);
        expect(LP_SINK.transfer_notification).toBe(LpSinkOpcodes.TransferNotification);
    });
});
