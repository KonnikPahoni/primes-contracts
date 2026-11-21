import {
    Address,
    beginCell,
    Cell,
    Contract,
    ContractProvider,
    contractAddress,
    Sender,
    SendMode,
} from '@ton/core';
import {
    buildPositionExpireMessage,
    buildPositionProposeMessage,
    buildPositionRelockMessage,
    buildPositionToSinkMessage,
    buildPositionVoteMessage,
    buildPositionWithdrawMessage,
} from '../../shared/messages';
import { clockDivisorOf } from './PrimesMarket';

/**
 * TON PRIMES — the LP POSITION CHILD, one per depositing wallet (CONCEPT §5.5,
 * DECISIONS D-100 points 4/5/9).
 *
 * It holds a wallet's LP positions and nothing else — no LP, no PRIMES, no TON
 * beyond its own rent. The assets sit in the treasury's jetton wallets; this is
 * the RECORD, sharded per owner because config 43's 65,536-cell account ceiling
 * kills a single positions dictionary around 20,000 entries.
 *
 * Its address is a hash of (this code, owner, treasury), and that derivation is
 * the authentication in both directions: the treasury re-derives it to trust a
 * message from here, and this contract compares `owner` and `treasuryAddr` to
 * trust a message from either side. `positionConfigToCell` must stay
 * byte-identical to `primes_treasury.tolk`'s `PositionInit` — `Treasury.spec.ts`
 * asserts it by comparing this wrapper's address against the contract's own
 * `getPositionAddress`.
 */

/** Nominal TON an owner message must forward: this hop plus the treasury's. */
export const POSITION_MIN_FORWARD = 200000000n;

export type LpPositionConfig = {
    /**
     * D-139 — the deploy-time clock divisor, inherited from the treasury that
     * derives this child. It divides `tierTerm(tier)`, the LOCK TERM this
     * contract enforces. 1 is mainnet and the identity. It is part of the
     * ADDRESS, so it must equal the treasury's own or `getPositionAddress` and
     * every child-message auth check stop agreeing.
     */
    clockDivisor?: number;
    owner: Address;
    treasuryAddr: Address;
};

function positionConfigToCell(config: LpPositionConfig): Cell {
    // THE FIELD ORDER IS PART OF THE ADDRESS. Mirrored by
    // `primes_treasury.tolk`'s `PositionInit`; change one, change both.
    return beginCell()
        .storeAddress(config.owner)
        .storeAddress(config.treasuryAddr)
        .storeDict(undefined) // positions
        .storeUint(0, 32) // nextId
        .storeUint(0, 32) // positionCount
        .storeUint(0, 120) // voteWeight
        .storeDict(undefined) // voted (D-188 point 7)
        .storeUint(clockDivisorOf(config.clockDivisor), 16) // D-139, inherited from the treasury
        .endCell();
}

export class PrimesLpPosition implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesLpPosition(address);
    }

    static createFromConfig(config: LpPositionConfig, code: Cell, workchain = 0) {
        const data = positionConfigToCell(config);
        const init = { code, data };
        return new PrimesLpPosition(contractAddress(workchain, init), init);
    }

    /**
     * Take the LP back. D-147: ONE message, allowed from the instant the term
     * matures — there is nothing to request first and nothing to wait out
     * afterwards.
     */
    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        opts: { positionId: number; value: bigint; queryID?: number }
    ) {
        await this.sendBody(provider, via, opts.value, buildPositionWithdrawMessage(opts.positionId, BigInt(opts.queryID ?? 0)).body);
    }

    /** Forward one position's LP to the LP sink — locked depth, forever, no wait. */
    async sendToSink(
        provider: ContractProvider,
        via: Sender,
        opts: { positionId: number; value: bigint; queryID?: number }
    ) {
        await this.sendBody(provider, via, opts.value, buildPositionToSinkMessage(opts.positionId, BigInt(opts.queryID ?? 0)).body);
    }

    /**
     * D-147. Restart one position's term at `now` under a new tier (0..3); the
     * vote weight moves with it. Refused as a downgrade while the current term
     * still runs (`position_relock_downgrade`, 1167).
     */
    async sendRelock(
        provider: ContractProvider,
        via: Sender,
        opts: { positionId: number; tier: number; value: bigint; queryID?: number }
    ) {
        const { body } = buildPositionRelockMessage({ positionId: opts.positionId, tier: opts.tier, queryId: BigInt(opts.queryID ?? 0) });
        await this.sendBody(provider, via, opts.value, body);
    }

    /**
     * D-147, and THE ONE MESSAGE HERE ANYONE MAY SEND. Mark a matured position's
     * vote weight gone, here and in the treasury's `eligibleWeight`. It moves no
     * asset and changes no rule — a matured term cannot vote whether or not this
     * has run — so it takes no owner and is idempotent on a second call.
     */
    async sendExpire(
        provider: ContractProvider,
        via: Sender,
        opts: { positionId: number; value: bigint; queryID?: number }
    ) {
        await this.sendBody(provider, via, opts.value, buildPositionExpireMessage(opts.positionId, BigInt(opts.queryID ?? 0)).body);
    }

    /** GAUNTLET.md G61: every body comes from `shared/messages.ts`, the builder the
     *  webapp sends, so a wire change cannot pass the contract tests and break the app. */
    private async sendBody(provider: ContractProvider, via: Sender, value: bigint, body: Cell) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    /**
     * Cast ONE named position's vote weight (D-147 — a term belongs to a
     * position, so a wallet holding three live terms casts three votes). There
     * is no partial vote (TR-7), and a matured position is refused.
     */
    async sendVote(
        provider: ContractProvider,
        via: Sender,
        opts: { seq: number; support: boolean; positionId: number; value: bigint; queryID?: number }
    ) {
        const { body } = buildPositionVoteMessage({
            seq: opts.seq,
            support: opts.support,
            positionId: opts.positionId,
            queryId: BigInt(opts.queryID ?? 0),
        });
        await this.sendBody(provider, via, opts.value, body);
    }

    /** Open a proposal on ONE named position's weight: transfer {TON | PRIMES | tsTON}. */
    async sendPropose(
        provider: ContractProvider,
        via: Sender,
        opts: {
            asset: number;
            amount: bigint;
            dest: Address;
            positionId: number;
            value: bigint;
            queryID?: number;
        }
    ) {
        const { body } = buildPositionProposeMessage({
            asset: opts.asset,
            amountRaw: opts.amount,
            dest: opts.dest.toString(),
            positionId: opts.positionId,
            queryId: BigInt(opts.queryID ?? 0),
        });
        await this.sendBody(provider, via, opts.value, body);
    }

    /**
     * (positionCount, nextId, voteWeight). `nextId` is the exclusive upper bound of
     * the id range; ids are never reused, so enumerating `getPosition(0..nextId-1)`
     * is stable across a withdrawal.
     */
    async getPositions(provider: ContractProvider) {
        const r = await provider.get('getPositions', []);
        return {
            positionCount: r.stack.readNumber(),
            nextId: r.stack.readNumber(),
            voteWeight: r.stack.readBigNumber(),
        };
    }

    /**
     * (amount, tier, lockedAt, expired, inFlight, maturesAt, weightSince).
     * `maturesAt` is the instant `withdraw` stops throwing AND `vote` starts
     * throwing. `weightSince` is when the position's current weight began (a
     * same-tier relock keeps it, an upgrade or a revived term restamps it); the
     * treasury counts a vote only if it is before the proposal's `opens` (1202).
     */
    async getPosition(provider: ContractProvider, positionId: number) {
        const r = await provider.get('getPosition', [{ type: 'int', value: BigInt(positionId) }]);
        return {
            amount: r.stack.readBigNumber(),
            tier: r.stack.readNumber(),
            lockedAt: r.stack.readNumber(),
            expired: r.stack.readNumber(),
            inFlight: r.stack.readNumber(),
            maturesAt: r.stack.readNumber(),
            weightSince: r.stack.readNumber(),
        };
    }

    /**
     * Σ `amount × voteMultiplier(tier)`, less what `expire` has retired. AN
     * UPPER BOUND between a term's maturity and its `expire`, because nobody
     * sends a message at maturity — the same staleness the treasury's
     * `eligibleWeight` carries. The RULE is never approximate: `sendVote` names
     * a position and the child weighs it against that position's own clock.
     */
    async getVoteWeight(provider: ContractProvider) {
        const r = await provider.get('getVoteWeight', []);
        return r.stack.readBigNumber();
    }

    /**
     * The four LOCK TERMS in seconds as THIS contract enforces them, already
     * divided by the deploy-time clock divisor — so a `maturesAt` and the ladder
     * are read in the same clock.
     */
    async getTierTerms(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getTierTerms', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    /**
     * D-188 point 7: does this POSITION hold a vote record on proposal `seq`? The
     * record is the one-vote rule — the treasury keeps only totals — and it is
     * forgotten once the proposal has certainly closed.
     */
    async getHasVoted(provider: ContractProvider, seq: number, positionId: number) {
        const r = await provider.get('getHasVoted', [
            { type: 'int', value: BigInt(seq) },
            { type: 'int', value: BigInt(positionId) },
        ]);
        return r.stack.readNumber() === 1;
    }

    /** How many of this wallet's positions hold a vote record on `seq`. */
    async getVotedCount(provider: ContractProvider, seq: number) {
        const r = await provider.get('getVotedCount', [{ type: 'int', value: BigInt(seq) }]);
        return r.stack.readNumber();
    }

    async getPositionOwner(provider: ContractProvider) {
        const r = await provider.get('getPositionOwner', []);
        return { owner: r.stack.readAddress(), treasuryAddr: r.stack.readAddress() };
    }

    async getPositionMinForward(provider: ContractProvider) {
        const r = await provider.get('getPositionMinForward', []);
        return r.stack.readBigNumber();
    }
}
