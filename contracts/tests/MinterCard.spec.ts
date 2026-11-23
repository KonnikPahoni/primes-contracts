import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Address, beginCell, Cell, internal as relaxed, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { deployStack, factorize, Stack } from './helpers/stack';
import { seedMinterCard } from './helpers/minterCard';
import { PrimesMinterCard } from '../wrappers/PrimesMinterCard';
import { encodeMintBody } from '../../shared/messages';
import { MINTER_CARD_CODE_HEX, minterCardAddress, minterCardInit } from '../../shared/minterCard';
import { MinterCardOpcodes as MINTER_CARD } from '../wrappers/PrimesMinterCard';
import * as fs from 'fs';
import * as path from 'path';

/**
 * D-191 point 1 (GAUNTLET V26.4) — THE MINTER CARD.
 *
 * A wallet's rebate standing (prime rank, the §5.1 prime window, the §4.5 newcomer window,
 * §4.7's recruit count and the era tally) left the ledger's two per-wallet dictionaries for
 * a per-wallet contract. A mint goes payer -> the BENEFICIARY's card -> ledger; the card
 * attaches the standing and whether it was FRESH (the §4.5 sybil guard), spends the mint's
 * window units itself, and gives them back if the ledger refuses the mint.
 */

const MINT_PRICE = toNano('1');
const K_SCALE = 1_000_000_000n;
const S_MAX = 1_200_000_000_000_000_000n;
const PARAMS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'shared', 'params.json'), 'utf-8'));
const POOL_INJECTION = toNano('0.65'); // 1 − 0.10 tribute − 0.05 treasury − 0.20 gas & ops, unreferred

async function dataCells(bc: Blockchain, addr: Address): Promise<number> {
    const acc = (await bc.getContract(addr)).account.account!;
    const st = acc.storage.state;
    if (st.type !== 'active') throw new Error('not active');
    const seen = new Set<string>();
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex');
        if (seen.has(h)) return;
        seen.add(h);
        c.refs.forEach(walk);
    };
    walk(st.state.data!);
    return seen.size;
}

describe('D-191 point 1: the minter card', () => {
    let s: Stack;
    let bc: Blockchain;
    let carol: SandboxContract<TreasuryContract>;
    let dave: SandboxContract<TreasuryContract>;

    beforeEach(async () => {
        s = await deployStack();
        bc = s.blockchain;
        carol = await bc.treasury('carol');
        dave = await bc.treasury('dave');
    });

    const card = (owner: Address) => bc.openContract(PrimesMinterCard.createFromAddress(minterCardAddress(s.ledger.address, owner)));

    /** Mint the current head, `who` paying, `to` receiving (a §4.5 gift when set). */
    async function mintHead(who: SandboxContract<TreasuryContract>, to?: Address, opts: { n?: bigint; value?: bigint } = {}) {
        const n = opts.n ?? (await s.ledger.getHead());
        return s.ledger.sendMint(who.getSender(), {
            n,
            kind: 0,
            factors: factorize(n),
            referralKey: 0,
            beneficiary: to ?? null,
            value: opts.value ?? MINT_PRICE,
        });
    }

    it('the shared code IS the compiled card, and the ledger derives the same address', async () => {
        // regenerate with `node tools/sync-minter-card-code.mjs` after a card change
        const compiled = await compile('PrimesMinterCard');
        expect(compiled.hash().toString('hex')).toBe(Cell.fromBoc(Buffer.from(MINTER_CARD_CODE_HEX, 'hex'))[0].hash().toString('hex'));
        expect((await s.ledger.getMinterCardAddress(s.alice.address)).equals(minterCardAddress(s.ledger.address, s.alice.address))).toBe(true);
    });

    it('a first mint deploys the payer’s card, trace-clean, and marks it seen', async () => {
        const r = await mintHead(s.alice);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const aliceCard = minterCardAddress(s.ledger.address, s.alice.address);
        expect(r.transactions).toHaveTransaction({ from: aliceCard, to: s.ledger.address, success: true });
        const owner = await card(s.alice.address).getCardOwner();
        expect(owner.seen).toBe(true);
        expect(owner.owner.equals(s.alice.address)).toBe(true);
        expect(owner.ledger.equals(s.ledger.address)).toBe(true);
    });

    it('a never-deployed card reads as zero standing', async () => {
        expect(await s.ledger.getMinterState(carol.address)).toEqual({ primesMinted: 0, tier: 0, uplift: 0n, window: 0 });
        expect((await s.ledger.getRecruitRank(carol.address)).recruits).toBe(0);
        expect(await s.ledger.getEraRecruits(carol.address)).toBe(0);
    });

    it('recruit edge: a gift to a fresh wallet is one recruit; the same wallet again is none', async () => {
        let r = await mintHead(s.alice, carol.address);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
        expect(await s.ledger.getEraRecruits(s.alice.address)).toBe(1);
        // A second gift inside EDGE_HOLD is held (104) even from the edge's own payer;
        // past it, it is an ordinary gift.
        const held = await mintHead(s.alice, carol.address);
        expect(held.transactions).toHaveTransaction({ to: minterCardAddress(s.ledger.address, carol.address), exitCode: 104 });
        bc.now = (bc.now ?? Math.floor(Date.now() / 1000)) + 300;
        r = await mintHead(s.alice, carol.address);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        // no credit hop at all the second time
        expect(r.transactions).not.toHaveTransaction({ to: minterCardAddress(s.ledger.address, s.alice.address) });
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
    });

    it('a wallet that has minted for itself is not fresh: a gift to it is no recruit', async () => {
        await mintHead(carol);
        await mintHead(s.alice, carol.address);
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(0);
        expect((await s.ledger.getNewcomerWindow(carol.address)).opened).toBe(false);
    });

    it('the newcomer window opens on the gift (unspent) and decrements one per own mint', async () => {
        await mintHead(s.alice, carol.address);
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(5);
        // Inside the edge hold the owner's mint neither uses nor spends the window.
        await mintHead(carol);
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(5);
        bc.now! += 300; // the hold lapses: an accepted edge is never reported
        for (let i = 4; i >= 0; i--) {
            bc.now! += 60;
            await mintHead(carol);
            expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(i);
        }
        expect((await s.ledger.getNewcomerWindow(carol.address)).opened).toBe(true);
    });

    it('a prime RESETS the window, never stacks it, and makes the card seen', async () => {
        await seedMinterCard(bc, s.ledger.address, { owner: carol.address, primesMinted: 1, window: 2 });
        const r = await s.acquire(carol, 2n);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ primesMinted: 2, window: 6 });
        // a buyer with no card gets one, deployed by the ledger's credit
        await s.acquire(dave, 3n);
        expect(await s.ledger.getMinterState(dave.address)).toMatchObject({ primesMinted: 1, window: 6 });
        expect((await card(dave.address).getCardOwner()).seen).toBe(true);
    });

    it('prices k off the attached standing with the same formula as before (all four uplifts, one clamp)', async () => {
        await seedMinterCard(bc, s.ledger.address, {
            owner: carol.address, primesMinted: 3, window: 2, newcomerWindow: 1, recruits: 3,
        });
        bc.now! += 10 * 365 * 86400; // far past the ramp: k = kMaxEffective
        const n = await s.ledger.getHead();
        const line = await card(carol.address).getUpliftLine();
        expect(line.summed).toBe(20_000_000n + 50_000_000n + 50_000_000n + 20_000_000n);
        const { kmax } = await s.ledger.getKMaxForSum(n, line.summed);
        const T = await s.ledger.getFloorNum();
        const S = await s.ledger.getFloorDen();
        const kEff = (kmax * (S_MAX - S)) / S_MAX;
        const expected = (kEff * POOL_INJECTION * S) / T / K_SCALE;
        const r = await mintHead(carol);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getFloorDen()) - S).toBe(expected);
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ window: 1 });
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(0);
    });

    it('§5 K_CEIL: every uplift live saturates the ONE clamp — k_max is 0.95 exactly and the mint emits at it', async () => {
        // All four terms at their top rung: prime rank V, a live prime window, a live
        // newcomer window, recruit rank V. At n = 4, k_max(n) is K_MAX_CAP (0.9), so the
        // unclamped sum is 0.9 + 0.26 = 1.16 — past 1. The single clamp is the only
        // thing keeping k < 1 here, which is what this case exists to exercise.
        const R = PARAMS.rebate;
        const nano = (x: number) => BigInt(Math.round(x * 1e9));
        const K_CEIL = nano(R.K_CEIL);
        const topRung = nano(R.prime_rank_kmax_uplifts[R.prime_rank_kmax_uplifts.length - 1]) + nano(R.PRIME_UPLIFT) + nano(R.NEWCOMER_UPLIFT)
            + nano(R.recruit_rank_kmax_uplifts[R.recruit_rank_kmax_uplifts.length - 1]);
        expect(topRung).toBe(nano(R.uplift_stacking.ladders.max_summed_uplift));

        await seedMinterCard(bc, s.ledger.address, {
            owner: carol.address, primesMinted: 100, window: 6, newcomerWindow: 5, recruits: 100,
        });
        bc.now! += 10 * 365 * 86400; // far past the ramp: k = kMaxEffective
        const n = await s.ledger.getHead();
        const line = await card(carol.address).getUpliftLine();
        expect(line.summed).toBe(topRung);
        expect((await s.ledger.getKMax(n)) + line.summed).toBeGreaterThanOrEqual(K_SCALE); // would be k >= 1 unclamped
        const { kmax, clamped } = await s.ledger.getKMaxForSum(n, line.summed);
        expect(kmax).toBe(K_CEIL);
        expect(clamped).toBe(true);
        expect(kmax).toBeLessThan(K_SCALE);

        // The mint path reads the same clamp: S moves by exactly the K_CEIL rebate.
        const T = await s.ledger.getFloorNum();
        const S = await s.ledger.getFloorDen();
        const kEff = (K_CEIL * (S_MAX - S)) / S_MAX;
        const expected = (kEff * POOL_INJECTION * S) / T / K_SCALE;
        const r = await mintHead(carol);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getFloorDen()) - S).toBe(expected);
        // §5 ratchet: emitted value (rebate · p_f) is k < 1 times the injection, so p_f rises.
        expect((await s.ledger.getFloorNum()) * S).toBeGreaterThan(T * (await s.ledger.getFloorDen()));
    });

    it('two mints in flight for one wallet: one window unit uplifts exactly one of them', async () => {
        await seedMinterCard(bc, s.ledger.address, { owner: carol.address, window: 1 });
        const n1 = await s.ledger.getHead();
        let n2 = n1 + 1n;
        while (factorize(n2).length === 1 && factorize(n2)[0].exponent === 1) n2++; // next composite
        const to = minterCardAddress(s.ledger.address, carol.address);
        const body = (n: bigint) => encodeMintBody({ n, kind: 0, factors: factorize(n), referralKey: 0 });
        const r = await carol.sendMessages([
            relaxed({ to, value: MINT_PRICE, body: body(n1) }),
            relaxed({ to, value: MINT_PRICE, body: body(n2) }),
        ]);
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        const mints = r.transactions.filter((t: any) => t.inMessage?.info?.src?.equals?.(to) && t.inMessage.info.dest.equals(s.ledger.address));
        expect(mints).toHaveLength(2);
        // the card serialized them: the first saw window 1, the second window 0
        const windows = mints.map((t: any) => {
            const b = t.inMessage.body.beginParse();
            b.loadUint(32); b.loadAddress(); b.loadAddress(); b.loadUint(32);
            return b.loadUint(8);
        });
        expect(windows).toEqual([1, 0]);
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ window: 0 });
        expect(await s.ledger.getHead()).toBeGreaterThan(n2);
    });

    it('a lost race gives the window back and the GRAM to the payer', async () => {
        await seedMinterCard(bc, s.ledger.address, { owner: carol.address, window: 3 });
        const stale = (await s.ledger.getHead()) - 2n;
        const before = await carol.getBalance();
        const r = await mintHead(carol, undefined, { n: stale });
        expect(r.transactions).not.toHaveTransaction({ aborted: true });
        expect(r.transactions).toHaveTransaction({ from: s.ledger.address, op: MINTER_CARD.card_mint_refunded });
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ window: 3 });
        expect(before - (await carol.getBalance())).toBeLessThan(toNano('0.02'));
    });

    it('a lost-race GIFT leaves a fresh card fresh, so the next gift still recruits', async () => {
        const stale = (await s.ledger.getHead()) - 2n;
        await mintHead(s.alice, carol.address, { n: stale });
        expect((await card(carol.address).getCardOwner()).seen).toBe(false);
        expect((await s.ledger.getNewcomerWindow(carol.address)).opened).toBe(false);
        await mintHead(s.alice, carol.address);
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
    });

    it('a refused gift does NOT re-fresh a card whose owner minted while it was in flight', async () => {
        // The exploit: A's gift built to fail opens the window; B mints on it, accepted;
        // the gift's refund used to reset B to fresh, so A could re-open it for gas, again
        // and again — and a wallet that had minted counted as a recruit.
        const stale = (await s.ledger.getHead()) - 2n;
        await mintHead(s.alice, carol.address, { n: stale }); // deploys the card, still fresh
        const to = minterCardAddress(s.ledger.address, carol.address);
        const gift = await bc.sendMessageIter(
            internal({ from: s.alice.address, to, value: MINT_PRICE, body: encodeMintBody({ n: stale, kind: 0, factors: factorize(stale), referralKey: 0 }) }),
            { allowParallel: true },
        );
        expect(((await gift.next()).value as any).description.aborted).toBe(false); // the card forwarded it
        const own = await mintHead(carol);
        expect(own.transactions).not.toHaveTransaction({ aborted: true });
        // 2026-11-08 audit: the unresolved edge's window was not lent to that mint.
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(5);
        for await (const tx of gift) expect((tx as any).description.aborted).toBe(false);
        expect((await card(carol.address).getCardOwner()).seen).toBe(true);
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(0);
        await mintHead(s.alice, carol.address);
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(0);
        expect((await s.ledger.getNewcomerWindow(carol.address)).opened).toBe(false);
    });

    it('two refused gifts in flight leave a fresh card fresh: a stranger cannot burn it', async () => {
        const stale = (await s.ledger.getHead()) - 2n;
        await mintHead(s.alice, carol.address, { n: stale });
        const to = minterCardAddress(s.ledger.address, carol.address);
        const body = encodeMintBody({ n: stale, kind: 0, factors: factorize(stale), referralKey: 0 });
        const r = await dave.sendMessages([relaxed({ to, value: MINT_PRICE, body }), relaxed({ to, value: MINT_PRICE, body })]);
        // The second waits behind the first (the edge hold, even for the same payer)
        // and bounces home whole.
        expect(r.transactions).toHaveTransaction({ to, exitCode: 104 });
        expect(r.transactions).not.toHaveTransaction({ to: s.ledger.address, aborted: true });
        expect((await card(carol.address).getCardOwner()).seen).toBe(false);
        await mintHead(s.alice, carol.address);
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
    });

    it('another payer’s gift waits for an unresolved recruit edge, so a lost race cannot cancel the recruit', async () => {
        // The edge gift loses its race; a second payer's gift sent meanwhile used to go
        // out NOT fresh and be accepted — no recruit credited, the window closed.
        const stale = (await s.ledger.getHead()) - 2n;
        await mintHead(s.alice, carol.address, { n: stale }); // deploys the card, still fresh
        const to = minterCardAddress(s.ledger.address, carol.address);
        const edge = await bc.sendMessageIter(
            internal({ from: s.alice.address, to, value: MINT_PRICE, body: encodeMintBody({ n: stale, kind: 0, factors: factorize(stale), referralKey: 0 }) }),
            { allowParallel: true },
        );
        expect(((await edge.next()).value as any).description.aborted).toBe(false); // the edge is out
        const held = await mintHead(dave, carol.address);
        expect(held.transactions).toHaveTransaction({ to, exitCode: 104 }); // held, GRAM bounces to dave
        expect(held.transactions).not.toHaveTransaction({ to: s.ledger.address });
        for await (const tx of edge) expect((tx as any).description.aborted).toBe(false); // refunded: hold cleared

        const real = await mintHead(dave, carol.address);
        expect(real.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getRecruitRank(dave.address)).recruits).toBe(1);
        expect((await s.ledger.getNewcomerWindow(carol.address)).opened).toBe(true);
    });

    it('the hold lapses on the clock: an accepted edge is never reported', async () => {
        const to = minterCardAddress(s.ledger.address, carol.address);
        await mintHead(s.alice, carol.address); // the edge, accepted
        expect((await s.ledger.getRecruitRank(s.alice.address)).recruits).toBe(1);
        const early = await mintHead(dave, carol.address);
        expect(early.transactions).toHaveTransaction({ to, exitCode: 104 });
        bc.now = (bc.now ?? Math.floor(Date.now() / 1000)) + 300;
        const later = await mintHead(dave, carol.address);
        expect(later.transactions).not.toHaveTransaction({ aborted: true });
        expect((await s.ledger.getRecruitRank(dave.address)).recruits).toBe(0); // a gift, not a second recruit
    });

    it('a ledger THROW bounces to the card, which gives the standing back', async () => {
        await seedMinterCard(bc, s.ledger.address, { owner: carol.address, window: 3, newcomerWindow: 2 });
        const n = await s.ledger.getHead();
        const bad = await s.ledger.sendMint(carol.getSender(), {
            n, kind: 0, factors: [{ prime: 2n, exponent: 1 }], referralKey: 0, beneficiary: null, value: MINT_PRICE,
        });
        expect(bad.transactions).toHaveTransaction({ to: s.ledger.address, exitCode: 201 });
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ window: 3 });
        expect((await s.ledger.getNewcomerWindow(carol.address)).left).toBe(2);
        expect(await s.ledger.getHead()).toBe(n);
    });

    it('below the price the card refuses before touching the standing', async () => {
        await seedMinterCard(bc, s.ledger.address, { owner: carol.address, window: 3 });
        const r = await mintHead(s.alice, carol.address, { value: toNano('0.5') });
        expect(r.transactions).toHaveTransaction({ to: minterCardAddress(s.ledger.address, carol.address), exitCode: 103 });
        expect(await s.ledger.getMinterState(carol.address)).toMatchObject({ window: 3 });
    });

    it('forged card traffic is refused both ways', async () => {
        const aliceCard = minterCardAddress(s.ledger.address, s.alice.address);
        await mintHead(s.alice);
        // a wallet posing as a card
        const forgedMint = await bc.sendMessage(internal({
            from: s.bob.address, to: s.ledger.address, value: MINT_PRICE,
            body: beginCell().storeUint(MINTER_CARD.card_mint, 32).storeAddress(s.bob.address).storeAddress(s.bob.address)
                .storeUint(0, 32).storeUint(6, 8).storeUint(5, 8).storeUint(100, 32).storeBit(true).storeBit(true)
                .storeRef(encodeMintBody({ n: await s.ledger.getHead(), kind: 0, factors: factorize(await s.ledger.getHead()), referralKey: 0 }))
                .endCell(),
        }));
        expect(forgedMint.transactions).toHaveTransaction({ to: s.ledger.address, exitCode: 100 });
        const forgedTally = await bc.sendMessage(internal({
            from: s.bob.address, to: s.ledger.address, value: toNano('0.05'),
            body: beginCell().storeUint(MINTER_CARD.card_recruit_counted, 32).storeUint(0, 64).storeAddress(s.bob.address)
                .storeUint(0, 8).storeUint(99, 32).endCell(),
        }));
        expect(forgedTally.transactions).toHaveTransaction({ to: s.ledger.address, exitCode: 100 });
        expect((await s.ledger.getEraLeader()).leader).toBeNull();
        // a wallet posing as the ledger
        for (const op of [MINTER_CARD.card_add_recruit, MINTER_CARD.card_prime_minted, MINTER_CARD.card_mint_refunded]) {
            const b = beginCell().storeUint(op, 32).storeUint(0, 64);
            if (op === MINTER_CARD.card_add_recruit) b.storeUint(0, 8);
            if (op === MINTER_CARD.card_mint_refunded) b.storeAddress(s.bob.address).storeUint(0, 32).storeUint(6, 8).storeUint(0, 8).storeUint(0, 32).storeBit(false).storeBit(false);
            const r = await bc.sendMessage(internal({ from: s.bob.address, to: aliceCard, value: toNano('0.05'), body: b.endCell() }));
            expect(r.transactions).toHaveTransaction({ to: aliceCard, exitCode: 100 });
        }
        expect(await s.ledger.getMinterState(s.alice.address)).toMatchObject({ primesMinted: 0, window: 0 });
    });

    it('a tally taken under an earlier era is dropped by the running max', async () => {
        const bobCard = minterCardAddress(s.ledger.address, s.bob.address);
        const tally = (seq: number, count: number) => bc.sendMessage(internal({
            from: bobCard, to: s.ledger.address, value: toNano('0.05'),
            body: beginCell().storeUint(MINTER_CARD.card_recruit_counted, 32).storeUint(0, 64).storeAddress(s.bob.address)
                .storeUint(seq, 8).storeUint(count, 32).endCell(),
        }));
        await tally(1, 5); // a seq the ledger has not reached
        expect((await s.ledger.getEraLeader()).leader).toBeNull();
        await tally(0, 2);
        expect(await s.ledger.getEraLeader()).toMatchObject({ recruits: 2, eraSeq: 0 });
        await tally(0, 2); // equal is not a lead
        await tally(0, 1);
        expect((await s.ledger.getEraLeader()).recruits).toBe(2);
    });

    it('the ledger’s storage does not grow with the number of distinct minters', async () => {
        const run = async (distinct: boolean) => {
            const st = await deployStack();
            const wallets = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => st.blockchain.treasury(`w${i}`)));
            for (let i = 0; i < wallets.length; i++) {
                const n = await st.ledger.getHead();
                // six gifts to six fresh wallets (six recruit edges), or six self-mints
                await st.ledger.sendMint(st.alice.getSender(), {
                    n, kind: 0, factors: factorize(n), referralKey: 0,
                    beneficiary: distinct ? wallets[i].address : null, value: MINT_PRICE,
                });
            }
            return dataCells(st.blockchain, st.ledger.address);
        };
        const same = await run(false);
        const many = await run(true);
        // the recruit tally moves the era leader cell's CONTENT, never its size in cells
        expect(many).toBe(same);
    });

    it('the ledger keeps no per-wallet dictionary in its source', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'contracts', 'primes_ledger.tolk'), 'utf8');
        expect(src).not.toMatch(/minterState:\s*map</);
        expect(src).not.toMatch(/recruits:\s*map</);
        void minterCardInit;
    });
});
