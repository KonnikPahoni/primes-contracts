// TON PRIMES — §4.1's invite line as plain text transfers (DECISIONS.md D-202, D-215).
//
// A mint may name up to the live `Config.inviteCount` (genesis 3) recipients. Each named
// slot gets one NoBounce transfer of the live `Config.inviteValue` (genesis 0.1 GRAM) from
// the LEDGER, fees paid on top so it arrives whole, carrying the comment `inviteComment(n)`
// (D-211: operator-set words, then the ledger's own link). The line costs value +
// INVITE_SEND_FEE per transfer sent; an unnamed slot is never sent and never deducted, so
// it stays in β. Every test also asserts the trace shape: nothing aborted.
import { SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell } from '@ton/core';
import { inviteTextCell as cellOf } from '../../shared/invites';
import '@ton/test-utils';
import { randomBytes } from 'crypto';
import { deployStack, factorize, MINT_PRICE, Stack } from './helpers/stack';
import { seedMinterCard } from './helpers/minterCard';
import { PrimesMinterCard } from '../wrappers/PrimesMinterCard';
import { minterCardAddress } from '../../shared/minterCard';
import {
    INVITE_COUNT_CEILING,
    INVITE_GENESIS_COUNT,
    INVITE_GENESIS_VALUE_NANOTON,
    INVITE_LINE_CAP_NANOTON,
    INVITE_SEND_FEE_NANOTON,
    inviteCommentCell,
    inviteCommentText,
    INVITE_TEXT_GENESIS,
    INVITE_TEXT_MAX_BYTES,
} from '../../shared/invites';
import { ERRORS, LEDGER } from '../../shared/opcodes';
import { FEE_MARGIN_NANOTON } from '../../shared/values';

const V = INVITE_GENESIS_VALUE_NANOTON;
const FEE = INVITE_SEND_FEE_NANOTON;
/** What `getInviteSpend` reads after `sent` transfers of `value` from `funded` declared slots. */
const spend = (funded: number, sent: number, value = V) => ({
    slotsFunded: BigInt(funded),
    transfersSent: BigInt(sent),
    slotsToPool: BigInt(funded - sent),
    valueDelivered: BigInt(sent) * value,
    linePaid: BigInt(sent) * (value + FEE),
});

describe('D-202/D-215 — the invite line is plain text transfers from the ledger, on operator-set terms', () => {
    let s: Stack;

    beforeEach(async () => {
        s = await deployStack();
    });

    /** Mint the head from `minter`, naming `slots` (slot -> address) under a declared `count`. */
    async function mintHead(
        minter: SandboxContract<TreasuryContract>,
        count: number,
        slots: [number, Address][],
        beneficiary: Address | null = null,
        value: bigint = MINT_PRICE
    ) {
        const n = await s.ledger.getHead();
        const r = await s.ledger.sendMint(minter.getSender(), {
            n,
            kind: 0,
            factors: factorize(n),
            referralKey: 0,
            beneficiary,
            invites: count === 0 && slots.length === 0 ? null : { count, addresses: new Map(slots) },
            value,
        });
        return { n, r };
    }

    /** Every message the ledger sent to `to` in `r`. */
    function fromLedgerTo(r: any, to: Address) {
        return r.transactions.filter(
            (t: any) => t.inMessage?.info?.src?.equals?.(s.ledger.address) && t.inMessage?.info?.dest?.equals?.(to)
        );
    }

    it('publishes its live terms, its bounds and its comment on get-methods (§9.1)', async () => {
        const terms = await s.ledger.getInviteTerms();
        expect(terms).toEqual({
            count: INVITE_GENESIS_COUNT,
            value: V,
            sendFee: FEE,
            lineCap: INVITE_LINE_CAP_NANOTON,
            countCeiling: INVITE_COUNT_CEILING,
        });
        expect(INVITE_GENESIS_COUNT).toBe(3);
        expect(V).toBe(100_000_000n);
        expect(INVITE_LINE_CAP_NANOTON).toBe(310_000_000n);
        expect(INVITE_COUNT_CEILING).toBe(100);
        const c: Cell = await s.ledger.getInviteComment();
        expect(c.hash().equals(inviteCommentCell().hash())).toBe(true);
        const p = c.beginParse();
        expect(p.loadUint(32)).toBe(0); // a plain text comment
        expect(p.loadStringTail()).toBe(inviteCommentText());
    });

    it('0 slots: an uninvited mint sends nothing and counts nothing', async () => {
        const { r } = await mintHead(s.alice, 0, []);
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getInviteSpend()).toEqual(spend(0, 0));
    });

    for (const count of [1, 2, 3]) {
        it(`${count} declared and named: ${count} transfer(s) of exactly 0.1 GRAM, NoBounce, carrying the comment`, async () => {
            const invitees = await Promise.all(
                Array.from({ length: count }, (_, i) => s.blockchain.treasury(`invitee${count}_${i}`))
            );
            const { r } = await mintHead(s.alice, count, invitees.map((t, i) => [i + 1, t.address]));
            expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
            expect(r.transactions).not.toHaveTransaction({ aborted: true });
            for (const t of invitees) {
                const got = fromLedgerTo(r, t.address);
                expect(got.length).toBe(1);
                const info = got[0].inMessage.info;
                expect(info.bounce).toBe(false);
                // D-215, PAY_FEES_SEPARATELY: the forward fee is on top, so 0.1 arrives whole
                // (a Telegram wallet pushes for 0.1 received, not for 0.0999).
                expect(info.value.coins).toBe(V);
                expect(got[0].inMessage.body.hash().equals(inviteCommentCell().hash())).toBe(true);
            }
            expect(await s.ledger.getInviteSpend()).toEqual(spend(count, count));
        });
    }

    it('the comment bytes are exactly the genesis words, with no link (D-215)', async () => {
        const bob = s.bob;
        const { r } = await mintHead(s.alice, 1, [[1, bob.address]]);
        const body = fromLedgerTo(r, bob.address)[0].inMessage.body.beginParse();
        expect(body.loadUint(32)).toBe(0);
        const text = body.loadStringTail();
        expect(text).toBe(INVITE_TEXT_GENESIS);
        expect(text).toBe(inviteCommentText());
        expect(await s.ledger.getInviteText()).toBe(INVITE_TEXT_GENESIS);
    });

    // ---- D-211/D-215: the operator's wallet sets the terms; the words are the whole comment ----
    const operator = () => s.blockchain.treasury('treasury'); // the stack's FeeDests.operatorAddr
    const setTerms = async (via: SandboxContract<TreasuryContract>, count: number, inviteValue: bigint, words = INVITE_TEXT_GENESIS) =>
        s.ledger.sendSetInviteTerms(via.getSender(), { count, inviteValue, words, value: 50_000_000n });
    const termsBody = (count: number, value: bigint, text: Cell) =>
        beginCell().storeUint(LEDGER.set_invite_terms, 32).storeUint(0, 64).storeUint(count, 7).storeCoins(value).storeRef(text).endCell();

    it('D-211: the operator rewrites the words; the next invite carries exactly them, at the cap', async () => {
        const op = await operator();
        const words = 'Ж'.repeat(INVITE_TEXT_MAX_BYTES / 2); // non-ASCII: 2 bytes each, exactly the cap
        const set = await setTerms(op, INVITE_GENESIS_COUNT, V, words);
        expect(set.transactions).toHaveTransaction({ from: op.address, to: s.ledger.address, success: true });
        expect(await s.ledger.getInviteText()).toBe(words);

        const bob = s.bob;
        const { r } = await mintHead(s.alice, 3, [[1, bob.address]]);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const body = fromLedgerTo(r, bob.address)[0].inMessage.body;
        expect(body.hash().equals(inviteCommentCell(words).hash())).toBe(true);
        expect((await s.ledger.getInviteComment()).hash().equals(inviteCommentCell(words).hash())).toBe(true);
    });

    it('D-211: anyone but the operator is refused 100; over-long or ref-carrying words are refused 237', async () => {
        const r1 = await setTerms(s.alice, INVITE_GENESIS_COUNT, V, 'scam');
        expect(r1.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: ERRORS.wrong_sender });

        const op = await operator();
        const long = termsBody(3, V, beginCell().storeBuffer(Buffer.alloc(INVITE_TEXT_MAX_BYTES + 1, 0x41)).endCell());
        const withRef = termsBody(3, V, beginCell().storeBuffer(Buffer.from('hi')).storeRef(beginCell().endCell()).endCell());
        const partial = termsBody(3, V, beginCell().storeUint(1, 7).endCell());
        for (const body of [long, withRef, partial]) {
            const r = await op.send({ to: s.ledger.address, value: 50_000_000n, body });
            expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: ERRORS.invite_text_bad });
        }
        expect(await s.ledger.getInviteText()).toBe(INVITE_TEXT_GENESIS);
    });

    it('holes: 3 declared, slot 2 named — one transfer, two slots stay in β', async () => {
        const inv = await s.blockchain.treasury('hole');
        const { r } = await mintHead(s.alice, 3, [[2, inv.address]]);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(fromLedgerTo(r, inv.address).length).toBe(1);
        expect(await s.ledger.getInviteSpend()).toEqual(spend(3, 1));
    });

    it('a slot above the declared count is never read and never paid', async () => {
        const inv = await s.blockchain.treasury('above');
        const { r } = await mintHead(s.alice, 1, [[3, inv.address]]);
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(fromLedgerTo(r, inv.address).length).toBe(0);
        expect((await s.ledger.getInviteSpend()).transfersSent).toBe(0n);
    });

    it('the β deduction is exactly the transfers sent: T grows 3 x (0.1 + fee) GRAM less on a full list', async () => {
        const tBefore0 = await s.ledger.getFloorNum();
        await mintHead(s.alice, 0, []);
        const dT0 = (await s.ledger.getFloorNum()) - tBefore0;

        s = await deployStack(); // the same genesis, so the same head and the same split
        const invitees = await Promise.all([1, 2, 3].map((i) => s.blockchain.treasury(`beta${i}`)));
        const tBefore3 = await s.ledger.getFloorNum();
        await mintHead(s.alice, 3, invitees.map((t, i) => [i + 1, t.address]));
        const dT3 = (await s.ledger.getFloorNum()) - tBefore3;

        expect(dT0 - dT3).toBe(3n * (V + FEE));
    });

    it('an UNDEPLOYED recipient still receives it — NoBounce, the value stays on the new account', async () => {
        const fresh = new Address(0, randomBytes(32));
        const { r } = await mintHead(s.alice, 1, [[1, fresh]]);
        // The recipient's OWN transaction is the one exception: an account with no code
        // skips its compute phase, which TVM reports as aborted — the shape of every first
        // transfer to a not-yet-deployed wallet. Nothing else in the trace may abort.
        const abortedElsewhere = r.transactions.filter(
            (t: any) => t.description?.aborted && !t.inMessage?.info?.dest?.equals?.(fresh)
        );
        expect(abortedElsewhere.length).toBe(0);
        expect(r.transactions).toHaveTransaction({ from: s.ledger.address, to: fresh });
        // Nothing bounced back to the ledger.
        expect(r.transactions).not.toHaveTransaction({ from: fresh, to: s.ledger.address });
        const acct = await s.blockchain.getContract(fresh);
        expect(acct.balance).toBeGreaterThan(V - 1_000_000n);
    });

    it('self-send: a minter may name their own wallet and gets the 0.3 GRAM back (owner-accepted)', async () => {
        const minter = s.alice;
        const before = await minter.getBalance();
        const { r } = await mintHead(minter, 3, [[1, minter.address], [2, minter.address], [3, minter.address]]);
        expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(fromLedgerTo(r, minter.address).length).toBeGreaterThanOrEqual(3);
        expect((await s.ledger.getInviteSpend()).transfersSent).toBe(3n);
        // The mint still cost the minter about 0.7 GRAM net, not 1.
        const spent = before - (await minter.getBalance());
        expect(spent).toBeLessThan(MINT_PRICE - 2n * V);
    });

    it(`a count above ${INVITE_GENESIS_COUNT} is refused (invite_count_over_max) and sends nothing`, async () => {
        const inv = await s.blockchain.treasury('over');
        const headBefore = await s.ledger.getHead();
        const { r } = await mintHead(s.alice, 4, [[1, inv.address]]);
        expect(r.transactions).toHaveTransaction({
            to: s.ledger.address,
            success: false,
            exitCode: ERRORS.invite_count_over_max,
        });
        expect(fromLedgerTo(r, inv.address).length).toBe(0);
        expect(await s.ledger.getHead()).toBe(headBefore);
    });

    // ---- D-215: the operator sets count and value, inside bounds no message moves ----

    it("D-215: the operator's terms are bounded — ceiling 100, value >= 1, count x (value + fee) <= 0.31", async () => {
        const op = await operator();
        const words = cellOf(INVITE_TEXT_GENESIS);
        const atCap = (INVITE_LINE_CAP_NANOTON / 100n) - FEE; // 100 transfers, exactly the cap
        const refused: [number, bigint][] = [
            [INVITE_COUNT_CEILING + 1, 1n], // over the ceiling
            [3, 0n], // a zero value
            [100, atCap + 1n], // one nanoGRAM over the cap
            [4, V], // 4 x 0.101 = 0.404
        ];
        for (const [count, value] of refused) {
            const r = await op.send({ to: s.ledger.address, value: 50_000_000n, body: termsBody(count, value, words) });
            expect(r.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: ERRORS.invite_terms_bad });
        }
        expect(await s.ledger.getInviteTerms()).toMatchObject({ count: INVITE_GENESIS_COUNT, value: V });

        const ok = await setTerms(op, 100, atCap);
        expect(ok.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        expect(await s.ledger.getInviteTerms()).toMatchObject({ count: 100, value: atCap });
    });

    it('D-215: a lowered count refuses a mint over it (221); count 0 switches the line off', async () => {
        const op = await operator();
        await setTerms(op, 1, V);
        const inv = await s.blockchain.treasury('lowered');
        const headBefore = await s.ledger.getHead();
        const over = await mintHead(s.alice, 2, [[1, inv.address]]);
        expect(over.r.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: ERRORS.invite_count_over_max });
        expect(await s.ledger.getHead()).toBe(headBefore);

        await setTerms(op, 0, V);
        const off = await mintHead(s.alice, 1, [[1, inv.address]]);
        expect(off.r.transactions).toHaveTransaction({ to: s.ledger.address, success: false, exitCode: ERRORS.invite_count_over_max });
        const plain = await mintHead(s.alice, 0, []);
        expect(plain.r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getHead()).toBeGreaterThan(headBefore);
    });

    /**
     * What one mint leaves on the ledger's own balance with `count` invites named, relative to
     * the same mint uninvited on an identical stack. The line takes `count x (value + FEE)` off
     * β, sends `count x value`, and pays the real forward fees and loop compute; so this is
     * `count x FEE - actual cost`, and it must never be negative — a negative is the gas & ops
     * line paying for invites, which D-215 says it never does.
     */
    async function invitedMintMargin(count: number, value: bigint, words: string) {
        const balanceOf = async () => (await s.blockchain.getContract(s.ledger.address)).balance;

        s = await deployStack();
        const b0 = await balanceOf();
        const plain = await mintHead(s.alice, 0, [], null, MINT_PRICE + FEE_MARGIN_NANOTON);
        expect(plain.r.transactions).not.toHaveTransaction({ aborted: true });
        const d0 = (await balanceOf()) - b0;

        s = await deployStack();
        const op = await operator();
        const set = await setTerms(op, count, value, words);
        expect(set.transactions).toHaveTransaction({ to: s.ledger.address, success: true });
        const invitees = await Promise.all(Array.from({ length: count }, (_, i) => s.blockchain.treasury(`m${count}_${i}`)));
        const b1 = await balanceOf();
        // The webapp's send: MINT_PRICE + FEE_MARGIN (shared/values.ts). A long invite list
        // makes the card's forward dearer, and that margin is what pays for it.
        const { r } = await mintHead(s.alice, count, invitees.map((t, i) => [i + 1, t.address]), null, MINT_PRICE + FEE_MARGIN_NANOTON);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const d1 = (await balanceOf()) - b1;
        for (const t of invitees) {
            const got = fromLedgerTo(r, t.address);
            expect(got.length).toBe(1);
            expect(got[0].inMessage.info.value.coins).toBe(value);
            expect(got[0].inMessage.body.hash().equals(inviteCommentCell(words).hash())).toBe(true);
        }
        expect(await s.ledger.getInviteSpend()).toEqual(spend(count, count, value));
        const margin = d1 - d0;
        // The card -> ledger hop, as GasRegression's padded bound defines it: what of the
        // 1 GRAM the long body cost before reaching the ledger (B43: the ledger's
        // CARD_HOP_ALLOWANCE comment quotes this figure for the heaviest honest body).
        const card = minterCardAddress(s.ledger.address, s.alice.address);
        const arrived = r.transactions.find(
            (t: any) => t.inMessage?.info?.src?.equals?.(card) && t.inMessage.info.dest.equals(s.ledger.address)
        )!.inMessage!.info as any;
        // Recorded for the INVITE_SEND_FEE allowance (DECISIONS.md D-215).
        console.log(`D-215 invite fee: count=${count} words=${Buffer.byteLength(words)}B margin=${margin} actual/invite=${(BigInt(count) * FEE - margin) / BigInt(count)} card hop=${MINT_PRICE + FEE_MARGIN_NANOTON - (arrived.value.coins as bigint)}`);
        return margin;
    }

    it('D-215: INVITE_SEND_FEE covers 3 full-length invites — the gas & ops line pays nothing for them', async () => {
        expect(await invitedMintMargin(3, V, 'A'.repeat(INVITE_TEXT_MAX_BYTES))).toBeGreaterThanOrEqual(0n);
    });

    it('D-215: 100 invites at the cap land in one mint, each whole, and the allowance still covers them', async () => {
        const atCap = INVITE_LINE_CAP_NANOTON / 100n - FEE;
        expect(await invitedMintMargin(100, atCap, 'A'.repeat(INVITE_TEXT_MAX_BYTES))).toBeGreaterThanOrEqual(0n);
    });

    // ---- Audit R2-L1 (2026-11-19): a named slot off workchain 0 is refused, in compute ----
    //
    // The transfer is mode REGULAR to an address the minter wrote. To a workchain that
    // does not exist the send failed in the ACTION phase (36): aborted, no bounce, the
    // ledger kept the 1 GRAM and the card never got its standing back. The refusal is now
    // a compute-phase throw, which bounces to the card (`giveBack`, then the GRAM home).
    // Masterchain is refused too, BY CHOICE: a -1 invitee was delivered cleanly before this
    // (measured 2026-11-19), but every wallet the line is for lives on workchain 0, the
    // keeper's list already filters to it, and one rule is one thing to audit.
    const card = (owner: Address) =>
        s.blockchain.openContract(PrimesMinterCard.createFromAddress(minterCardAddress(s.ledger.address, owner)));
    const aborted = (r: any) => r.transactions.filter((t: any) => t.description?.aborted);

    /** The refusal's whole trace shape: one abort, the ledger's 236, and the money home. */
    async function expectRefused(r: any, payer: SandboxContract<TreasuryContract>, before: bigint, headBefore: bigint) {
        expect(r.transactions).toHaveTransaction({
            to: s.ledger.address,
            success: false,
            exitCode: ERRORS.invite_bad_workchain,
        });
        // Compute refused it; nothing failed in an action phase, and nothing else aborted.
        expect(aborted(r).length).toBe(1);
        expect(r.transactions).not.toHaveTransaction({ actionResultCode: 36 });
        expect(await s.ledger.getHead()).toBe(headBefore);
        expect(await s.ledger.getInviteSpend()).toEqual(spend(0, 0));
        // The mint value came back, less gas.
        expect(before - (await payer.getBalance())).toBeLessThan(50_000_000n);
    }

    for (const wc of [5, -1]) {
        it(`R2-L1: an invitee on workchain ${wc} is refused 236 — the mint bounces, the card's window unit comes back`, async () => {
            const carol = await s.blockchain.treasury('carol');
            await seedMinterCard(s.blockchain, s.ledger.address, { owner: carol.address, primesMinted: 1, window: 2 });
            const good = await s.blockchain.treasury('good');
            const bad = new Address(wc, randomBytes(32));
            const headBefore = await s.ledger.getHead();
            const before = await carol.getBalance();

            // Slot 1 is honest and is walked first: its queued transfer must go down with the throw.
            const { r } = await mintHead(carol, 2, [[1, good.address], [2, bad]]);
            await expectRefused(r, carol, before, headBefore);
            expect(fromLedgerTo(r, good.address).length).toBe(0);
            expect(await card(carol.address).getMinterState()).toMatchObject({ primesMinted: 1, window: 2 });
            expect((await card(carol.address).getCardOwner()).seen).toBe(true);

            // The same wallet's honest mint goes through and spends the unit it was given back.
            const ok = await mintHead(carol, 1, [[1, good.address]]);
            expect(ok.r.transactions).not.toHaveTransaction({ aborted: true });
            expect(await s.ledger.getHead()).toBeGreaterThan(headBefore);
            expect(fromLedgerTo(ok.r, good.address).length).toBe(1);
            expect((await card(carol.address).getMinterState()).window).toBe(1);
        });
    }

    it('R2-L1: an off-workchain address in a slot ABOVE the declared count is never read — the mint lands', async () => {
        const good = await s.blockchain.treasury('good-below');
        const headBefore = await s.ledger.getHead();
        const { r } = await mintHead(s.alice, 1, [[1, good.address], [2, new Address(5, randomBytes(32))]]);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getHead()).toBeGreaterThan(headBefore);
        expect(fromLedgerTo(r, good.address).length).toBe(1);
        expect((await s.ledger.getInviteSpend()).transfersSent).toBe(1n);
    });

    it('R2-L1: a first-ever mint refused 236 leaves the card fresh again', async () => {
        const dave = await s.blockchain.treasury('dave');
        const headBefore = await s.ledger.getHead();
        const before = await dave.getBalance();
        const { r } = await mintHead(dave, 1, [[1, new Address(5, randomBytes(32))]]);
        await expectRefused(r, dave, before, headBefore);
        expect((await card(dave.address).getCardOwner()).seen).toBe(false); // inFlight back to 0

        const ok = await mintHead(dave, 0, []);
        expect(ok.r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await card(dave.address).getCardOwner()).seen).toBe(true);
    });

    it('R2-L1: a gift to a fresh wallet refused 236 un-opens the newcomer window, credits no recruit, and the next gift is the edge', async () => {
        const erin = await s.blockchain.treasury('erin'); // never minted: her card is fresh
        const headBefore = await s.ledger.getHead();
        const before = await s.alice.getBalance();
        const { r } = await mintHead(s.alice, 1, [[1, new Address(5, randomBytes(32))]], erin.address);
        await expectRefused(r, s.alice, before, headBefore);
        expect((await card(erin.address).getCardOwner()).seen).toBe(false);
        expect(await card(erin.address).getNewcomerWindow()).toMatchObject({ left: 0, opened: false });
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(0);

        // No EDGE_HOLD wait: the refusal reset `edgeSentAt`, so this is not a 104, and it
        // is the recruit edge the refused gift would have been.
        const ok = await mintHead(s.alice, 0, [], erin.address);
        expect(ok.r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
        expect(await card(erin.address).getNewcomerWindow()).toMatchObject({ left: 5, opened: true });
        expect((await card(erin.address).getCardOwner()).seen).toBe(true);
    });
});
