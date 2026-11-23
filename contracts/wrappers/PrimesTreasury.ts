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
    TREASURY,
    TREASURY_ACTION_DEPOSIT,
    TREASURY_TIERS as REGISTRY_TREASURY_TIERS,
    TREASURY_VENUE_CONFIRM_GAS_NANOTON,
} from '../../shared/opcodes';
import { clockDivisorOf } from './PrimesMarket';
import {
    buildDistributeMessage,
    buildExecuteProposalMessage,
    buildLpDepositPayload,
    buildPruneProposalMessage,
} from '../../shared/messages';

/**
 * TON PRIMES — the GOVERNED TREASURY (CONCEPT §5.5, DECISIONS D-100).
 *
 * The team's money under holder control: PRIMES (its vesting lock, D-166), GRAM
 * (58% of the unsold-prime forfeits, D-166), tsTON (D-151) and depositors' LP. LP
 * custody in four lock terms buys a VOTE and nothing else (D-168 deleted the miner).
 *
 * It holds NO protocol GRAM: `pending` is the ratchet's and `owed` is the prime
 * owners', both in their own accounts (§3.4). It has no owner, no admin opcode,
 * no pause and no upgrade — it spends only by a passed proposal or by
 * `distribute()` (PRIMES to the stake master, once per epoch, by formula), and
 * there is no third path (TR-2). Nothing here mints; `S` is untouched (TR-4).
 *
 * Positions live on one `PrimesLpPosition` child per wallet, because config 43's
 * 65,536-cell account ceiling kills a single positions dictionary around 20,000
 * entries. See `primes_treasury.tolk`'s header.
 */
export const TreasuryOpcodes = {
    /** one-shot, genesis script only: all three of this contract's own jetton wallets */
    SetWallets: TREASURY.set_wallets,
    /** inbound from either of our own jetton wallets (TEP-74) */
    TransferNotification: TREASURY.transfer_notification,
    /** inbound from the sender's own child: a relock moved a position's vote weight */
    RelockVote: TREASURY.relock_vote,
    /** inbound from the sender's own child: move a matured position's LP */
    WithdrawLp: TREASURY.withdraw_lp,
    /** inbound from the sender's own child: tally a vote */
    Vote: TREASURY.vote,
    /** inbound from the sender's own child: open a proposal */
    Propose: TREASURY.propose,
    /** inbound, PERMISSIONLESS, after the vote closes */
    Execute: TREASURY.execute,
    /** inbound, PERMISSIONLESS, once per epoch: the stake master's budget (D-168) */
    Distribute: TREASURY.distribute,
    /** inbound, PERMISSIONLESS: delete a settled proposal (D-188 point 7) */
    Prune: TREASURY.prune,
    /** outbound, treasury -> child */
    LpCredit: TREASURY.lp_credit,
    ConfirmWithdraw: TREASURY.confirm_withdraw,
    RestorePosition: TREASURY.restore_position,
    /** outbound GRAM payout on `execute` of an asset-0 proposal */
    TonPayout: TREASURY.ton_payout,
    /** outbound, D-194: `execute` of a passed venue-confirm proposal, to the timelock */
    ConfirmVenue: TREASURY.confirm_venue,
    /** outbound TEP-74 transfer, every asset this contract can move */
    JettonTransfer: TREASURY.jetton_transfer,
};

/** The `forwardPayload` tag on an inbound LP transfer. Permanent; see the contract. */
export { TREASURY_ACTION_DEPOSIT };

/**
 * `Proposal.asset`. tsTON is D-151 / §4.3.2's harvested staking yield; LP is not proposable
 * (D-167). `VENUE` (D-194) is a venue-confirm proposal: `amount` = the timelock record's
 * `seq`, `dest` = the timelock; `execute` must attach `TREASURY_VENUE_CONFIRM_GAS`.
 */
export const TreasuryAsset = { GRAM: 0, PRIMES: 1, TSTON: 2, VENUE: 3 } as const;
export const TREASURY_VENUE_CONFIRM_GAS = TREASURY_VENUE_CONFIRM_GAS_NANOTON;

/**
 * The four custody tiers, index = the `tier:uint3` a deposit payload carries. A LOCK
 * TERM measured from the deposit (D-147) that votes while it runs and earns nothing
 * (D-168). The registry's copy; the contract's `getVoteMultipliers` / `getTierTerms` are
 * the §9.1 authority and `Treasury.spec.ts` asserts these agree with them.
 */
export const TREASURY_TIERS = REGISTRY_TREASURY_TIERS;

/** Nominal GRAM a treasury-bound message must forward. A real sender adds a margin. */
export const TREASURY_MIN_FORWARD = 150000000n;

export type TreasuryConfig = {
    /**
     * D-100 point 6's operator. Recorded for `getTreasuryConfig` only — no
     * message in the contract grants them any authority whatsoever.
     */
    operatorAddr: Address;
    /** `primes_lp_sink.tolk` — the one destination a sink-forward can name. */
    sinkAddr: Address;
    /** The stake master (§5.3) — the ONE address `distribute()` can pay. Deploy data. */
    stakeAddr: Address;
    /**
     * `shared/params.json` `staking.distribution_rate_bps_per_day` (19). DEPLOY DATA,
     * fixed at deploy; no message can change it.
     */
    distributionRateBpsPerDay: number;
    /**
     * D-139 — THE TEST CLOCK. Divides the vote window, the tier terms and
     * `distribute()`'s interval. 1 is mainnet and the identity. Deploy-time only,
     * and part of every child's address.
     */
    clockDivisor?: number;
    /** `primes_lp_position.tolk`'s compiled code — the child address derivation. */
    positionCode: Cell;
    /** The one-shot `set_wallets` authority. */
    genesisScriptAddr: Address;
};

function treasuryConfigToCell(config: TreasuryConfig): Cell {
    const dist = beginCell()
        .storeAddress(config.stakeAddr)
        .storeUint(config.distributionRateBpsPerDay, 32)
        .storeUint(0, 40) // lastDistributeTime — 0 until the first distribute()
        .storeCoins(0) // distributedTotal
        .storeUint(0, 32) // distributeEvents
        .endCell();
    const bal = beginCell()
        .storeCoins(0) // primesBalance
        .storeCoins(0) // tstonBalance — D-151
        .storeCoins(0) // lpHeld
        .storeCoins(0) // primesIn
        .storeUint(0, 32) // depositEvents
        .endCell();
    const gov = beginCell()
        .storeUint(0, 32) // proposalSeq
        .storeUint(0, 128) // eligibleWeight
        .storeDict(undefined) // proposals
        .storeDict(undefined) // openBy
        .endCell();
    const wallets = beginCell()
        // Placeholders until the one-shot `set_wallets`; `walletsSet = 0` is what
        // every handler checks first, so an unbootstrapped placeholder can never
        // be impersonated into authority.
        .storeAddress(config.genesisScriptAddr)
        .storeAddress(config.genesisScriptAddr)
        .storeUint(0, 8) // walletsSet
        .storeAddress(config.genesisScriptAddr)
        .endCell();
    const cfg = beginCell()
        .storeAddress(config.operatorAddr)
        .storeAddress(config.sinkAddr)
        // tsTON wallet placeholder until the one-shot `set_wallets`. It lives on
        // the config cell and not in `wallets` because a fourth MsgAddress
        // overflows that cell's 1023 bits; see the contract.
        .storeAddress(config.genesisScriptAddr)
        .storeUint(clockDivisorOf(config.clockDivisor), 16)   // D-139
        .storeRef(config.positionCode)
        .storeRef(wallets)
        .endCell();
    return beginCell().storeRef(dist).storeRef(bal).storeRef(gov).storeRef(cfg).endCell();
}

/** The `forwardPayload` a custody deposit carries: the tag plus the tier. */
export function depositPayload(tier: number): Cell {
    return buildLpDepositPayload(tier); // GAUNTLET.md G61: the webapp's own bytes
}

export class PrimesTreasury implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new PrimesTreasury(address);
    }

    static createFromConfig(config: TreasuryConfig, code: Cell, workchain = 0) {
        const data = treasuryConfigToCell(config);
        const init = { code, data };
        return new PrimesTreasury(contractAddress(workchain, init), init);
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /**
     * Plain GRAM in — the 58% forfeit share (§4.1, §6 point 2, D-166). Nothing to
     * record: the balance is the counter.
     */
    async sendTon(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().endCell(),
        });
    }

    /**
     * D21-family bootstrap, one-shot: all three of the treasury's own jetton
     * wallets. `tstonJettonWallet` (D-151) is derived from TONSTAKERS' master,
     * not ours, so on mainnet it is a genesis input rather than something this
     * repo deploys.
     */
    async sendSetWallets(
        provider: ContractProvider,
        via: Sender,
        opts: {
            lpJettonWallet: Address;
            primesJettonWallet: Address;
            /**
             * D-151. OPTIONAL only so a harness that never exercises tsTON does
             * not have to name one: omitted, it is written as THE TREASURY'S OWN
             * ADDRESS, which no jetton wallet can ever be, so the tsTON arm is
             * unreachable. It is deliberately not defaulted to another wallet —
             * that would credit the wrong balance — and not to `addr_none`,
             * which the contract's `address` field will not parse. Still
             * one-shot, still gated by `walletsSet`; genesis always passes it.
             */
            tstonJettonWallet?: Address;
            value: bigint;
            queryID?: number;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(TreasuryOpcodes.SetWallets, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeAddress(opts.lpJettonWallet)
                .storeAddress(opts.primesJettonWallet)
                .storeAddress(opts.tstonJettonWallet ?? this.address)
                .endCell(),
        });
    }

    /**
     * A jetton arriving, as one of the treasury's own wallets delivers it. Test
     * harnesses call this impersonating that wallet; in production a depositor
     * sends a TEP-74 `transfer` and the wallet produces this notification.
     */
    async sendTransferNotification(
        provider: ContractProvider,
        via: Sender,
        opts: {
            amount: bigint;
            from: Address;
            value: bigint;
            queryID?: number;
            /** Absent or unrecognised on the LP wallet refunds — the burn sink's outcome 2. */
            forwardPayload?: Cell;
        }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell()
                .storeUint(TreasuryOpcodes.TransferNotification, 32)
                .storeUint(opts.queryID ?? 0, 64)
                .storeCoins(opts.amount)
                .storeAddress(opts.from)
                // TEP-74's Either discriminator, then the ref (R20).
                .storeBit(true)
                .storeRef(opts.forwardPayload ?? beginCell().endCell())
                .endCell(),
        });
    }

    /**
     * PERMISSIONLESS after the vote closes — the vesting lock's `release`
     * precedent. Nothing here names a destination or an amount, so who calls it
     * cannot matter.
     */
    async sendExecute(
        provider: ContractProvider,
        via: Sender,
        opts: { seq: number; value: bigint; queryID?: number }
    ) {
        await provider.internal(via, {
            value: opts.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: buildExecuteProposalMessage(opts.seq, BigInt(opts.queryID ?? 0)).body,
        });
    }

    /**
     * D-188 point 7, PERMISSIONLESS: delete a proposal nothing can happen to any
     * more (failed and closed, or past its execute window). `getPrunable` first.
     */
    async sendPrune(
        provider: ContractProvider,
        via: Sender,
        opts: { seq: number; value?: bigint; queryID?: number }
    ) {
        const m = buildPruneProposalMessage(opts.seq, BigInt(opts.queryID ?? 0));
        await provider.internal(via, {
            value: opts.value ?? m.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: m.body,
        });
    }

    /**
     * PERMISSIONLESS, at most once per interval: send one epoch's PRIMES budget to the
     * stake master (D-168). The caller funds the hop and gets the change back.
     */
    async sendDistribute(provider: ContractProvider, via: Sender, opts?: { value?: bigint; queryID?: number }) {
        const m = buildDistributeMessage(BigInt(opts?.queryID ?? 0));
        await provider.internal(via, {
            value: opts?.value ?? m.value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: m.body,
        });
    }

    /**
     * (lastDistributeTime, interval, rateBps, nextBudgetEstimate, distributedTotal,
     * stakeAddr). `interval` is divided; the next `distribute()` is due at
     * `lastDistributeTime + interval`.
     */
    async getDistribution(provider: ContractProvider) {
        const r = await provider.get('getDistribution', []);
        return {
            lastDistributeTime: r.stack.readNumber(),
            interval: r.stack.readNumber(),
            rateBps: r.stack.readNumber(),
            nextBudgetEstimate: r.stack.readBigNumber(),
            distributedTotal: r.stack.readBigNumber(),
            stakeAddr: r.stack.readAddress(),
        };
    }

    /**
     * (tonBalance, primesBalance, lpHeld, primesIn, tstonBalance). `lpHeld` is the
     * depositors' — all the LP the treasury holds — and is never proposable (TR-5).
     */
    async getTreasuryBalances(provider: ContractProvider) {
        const r = await provider.get('getTreasuryBalances', []);
        return {
            tonBalance: r.stack.readBigNumber(),
            primesBalance: r.stack.readBigNumber(),
            lpHeld: r.stack.readBigNumber(),
            primesIn: r.stack.readBigNumber(),
            tstonBalance: r.stack.readBigNumber(),
        };
    }

    /** (proposalSeq, eligibleWeight, proposalCapBps, proposeMinBps, voteDuration, noticeDuration).
     *  A proposal's vote opens `noticeDuration` after it is proposed (audit R2-H1). */
    async getGov(provider: ContractProvider) {
        const r = await provider.get('getGov', []);
        return {
            proposalSeq: r.stack.readNumber(),
            eligibleWeight: r.stack.readBigNumber(),
            proposalCapBps: r.stack.readNumber(),
            proposeMinBps: r.stack.readNumber(),
            voteDuration: r.stack.readNumber(),
            noticeDuration: r.stack.readNumber(),
        };
    }

    /** A missing proposal returns a zero row with `opens === 0`. */
    async getProposal(provider: ContractProvider, seq: number) {
        const r = await provider.get('getProposal', [{ type: 'int', value: BigInt(seq) }]);
        return {
            proposer: r.stack.readAddressOpt(),
            asset: r.stack.readNumber(),
            amount: r.stack.readBigNumber(),
            dest: r.stack.readAddressOpt(),
            opens: r.stack.readNumber(),
            closes: r.stack.readNumber(),
            yes: r.stack.readBigNumber(),
            no: r.stack.readBigNumber(),
            executed: r.stack.readNumber(),
        };
    }

    /**
     * (executable, reason, cap, available). `reason` is the error code the call
     * WOULD throw, or 0 — so a UI can disable the button and say why without
     * provoking the throw.
     */
    async getExecutable(provider: ContractProvider, seq: number) {
        const r = await provider.get('getExecutable', [{ type: 'int', value: BigInt(seq) }]);
        return {
            executable: r.stack.readNumber() === 1,
            reason: r.stack.readNumber(),
            cap: r.stack.readBigNumber(),
            available: r.stack.readBigNumber(),
        };
    }

    /**
     * Would the BLOCK clock accept a `vote` on `seq` now? `reason` is the code `vote`
     * would throw (1153 / 1206 in its notice / 1154 closed) or 0. A driver waits on this,
     * never on its own clock against `opens`.
     */
    async getVotable(provider: ContractProvider, seq: number) {
        const r = await provider.get('getVotable', [{ type: 'int', value: BigInt(seq) }]);
        return { votable: r.stack.readNumber() === 1, reason: r.stack.readNumber() };
    }

    /**
     * Would `prune(seq)` succeed now? D-188 point 7. Who voted is not on the
     * treasury any more — `PrimesLpPosition.getHasVoted` on the voter's child.
     */
    async getPrunable(provider: ContractProvider, seq: number) {
        const r = await provider.get('getPrunable', [{ type: 'int', value: BigInt(seq) }]);
        return r.stack.readNumber() === 1;
    }

    /** (depositEvents, distributeEvents) — an indexer reconciles against these. */
    async getTreasuryCounts(provider: ContractProvider) {
        const r = await provider.get('getTreasuryCounts', []);
        return { depositEvents: r.stack.readNumber(), distributeEvents: r.stack.readNumber() };
    }

    /** The four VOTE multipliers, `treasury.vote_multipliers`. */
    async getVoteMultipliers(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getVoteMultipliers', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    /** D-214: what LP locked forever through a position votes with. Not a tier. */
    async getForeverVoteMultiplier(provider: ContractProvider): Promise<number> {
        const r = await provider.get('getForeverVoteMultiplier', []);
        return r.stack.readNumber();
    }

    /**
     * The four LOCK TERMS in seconds, `treasury.tier_term_seconds`, already
     * divided by the deploy-time clock divisor — the same figures the child
     * enforces a position's `maturesAt` against.
     */
    async getTierTerms(provider: ContractProvider): Promise<number[]> {
        const r = await provider.get('getTierTerms', []);
        return Array.from({ length: 4 }, () => r.stack.readNumber());
    }

    /**
     * The address of `owner`'s position child, deployed or not. This is the same
     * derivation that authenticates every child message.
     */
    async getPositionAddress(provider: ContractProvider, owner: Address) {
        const r = await provider.get('getPositionAddress', [
            { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
        ]);
        return r.stack.readAddress();
    }

    /** The permanent `forwardPayload` deposit tag. */
    async getTreasuryActions(provider: ContractProvider) {
        const r = await provider.get('getTreasuryActions', []);
        return { deposit: r.stack.readNumber() };
    }

    /** (treasuryMinForward, distributeMinForward). */
    async getTreasuryMinForward(provider: ContractProvider) {
        const r = await provider.get('getTreasuryMinForward', []);
        return { treasuryMinForward: r.stack.readBigNumber(), distributeMinForward: r.stack.readBigNumber() };
    }

    async getTreasuryConfig(provider: ContractProvider) {
        const r = await provider.get('getTreasuryConfig', []);
        return {
            lpJettonWallet: r.stack.readAddress(),
            primesJettonWallet: r.stack.readAddress(),
            operatorAddr: r.stack.readAddress(),
            sinkAddr: r.stack.readAddress(),
            walletsSet: r.stack.readNumber(),
            tstonJettonWallet: r.stack.readAddress(),
        };
    }
}
