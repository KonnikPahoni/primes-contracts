// TON PRIMES — GAUNTLET.md R13: the DeDust native-vault deposit_liquidity wire
// format, researched (not built against) before anyone builds the
// donate -> pair -> lock atomic path CONCEPT.md §6 point 3 and D-100's
// "options not taken" both currently leave manual.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT. `mock_dedust_deposit_vault.tolk`
// parses field-by-field against DeDust v2's own published schema
// (docs.dedust.io/reference/tlb-schemes, cross-checked against a second,
// independent fetch on 2026-09-12 — both agree on opcode 0xd55e4686 and the
// field list byte-for-byte). This proves the schema itself is internally
// consistent and round-trips in `@ton/sandbox`, and surfaces the one finding
// that actually matters for R13's question ("would the LP receipt arrive at
// the sender or at a responseAddr we choose"): deposit_liquidity carries NO
// recipient field anywhere — not in the top-level message, not in
// `PoolParams`. A contract wanting the LP receipt for itself has to be the
// SENDER of this message; there is no field to redirect it with. It does NOT
// prove a real DeDust pool accepts this exact message (no production
// contract in this repo builds one yet — that is what R13 asked to research,
// not build) and it does NOT model the jetton-vault half of a two-asset
// deposit or the pool's two-sided settlement. Both remain open per R13's own
// closing note in GAUNTLET.md.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { MockDedustDepositVault } from '../wrappers/MockDedustDepositVault';

const DEDUST_DEPOSIT_OP = 0xd55e4686;

describe("GAUNTLET.md R13 — the DeDust deposit_liquidity body matches DeDust v2's own published schema", () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let depositor: SandboxContract<TreasuryContract>;
    let vaultCode: Cell;
    let vault: SandboxContract<MockDedustDepositVault>;

    beforeAll(async () => {
        vaultCode = await compile('MockDedustDepositVault');
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        depositor = await blockchain.treasury('depositor', { balance: toNano('1000') });

        // lpNum/lpDen start at 0/1 — every deposit refunds until a test sets a
        // real rate, so "fills by accident" cannot happen.
        vault = blockchain.openContract(
            MockDedustDepositVault.createFromConfig({ owner: owner.address, lpNum: 0n, lpDen: 1n }, vaultCode)
        );
        await vault.sendDeploy(owner.getSender(), toNano('5'));
    });

    it('parses field-by-field against deposit_liquidity#d55e4686 query_id:uint64 amount:Coins pool_params:PoolParams ^[min_lp_amount:Coins asset0_target_balance:Coins asset1_target_balance:Coins] fulfill_payload:(Maybe ^Cell) reject_payload:(Maybe ^Cell)', async () => {
        // Set a rate so this exact call fills, then re-derive the raw cell by
        // hand (rather than trusting the wrapper alone) to prove the ON-CHAIN
        // parse — not just the TypeScript builder — matches the schema.
        await vault.sendSetLpRate(owner.getSender(), { lpNum: 1n, lpDen: 1n, value: toNano('0.05') });

        const amount = toNano('10');
        const body = beginCell()
            .storeUint(DEDUST_DEPOSIT_OP, 32)
            .storeUint(0, 64) // query_id
            .storeCoins(amount)
            .storeUint(0, 1) // pool_type = volatile$0
            .storeUint(0, 4) // asset0 = native$0000
            .storeUint(1, 4) // asset1 = jetton$0001
            .storeInt(0, 8) // workchain_id
            .storeUint(123n, 256) // address (PRIMES jetton master stand-in)
            // min_lp_amount + both target balances ride in a REF, per the SDK's
            // own builder. The doc page prints them inline and is wrong.
            .storeRef(
                beginCell()
                    .storeCoins(amount) // min_lp_amount — exactly meets the 1:1 rate
                    .storeCoins(0n) // asset0_target_balance
                    .storeCoins(0n) // asset1_target_balance
                    .endCell()
            )
            .storeUint(0, 1) // fulfill_payload = none$0
            .storeUint(0, 1) // reject_payload = none$0
            .endCell();

        const r = await depositor.send({ to: vault.address, value: toNano('11'), bounce: true, body });

        expect(r.transactions).toHaveTransaction({ from: depositor.address, to: vault.address, success: true });
        // FILL: the reply lands on the SENDER — depositor — with no field in
        // the message able to redirect it anywhere else.
        const reply = r.transactions.find(
            (t) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.dest?.equals(depositor.address)
        );
        expect(reply).toBeDefined();
        const s = reply!.inMessage!.body.beginParse();
        expect(s.loadUint(32)).toBe(0x7362d09c); // TransferNotification — the LP mint stand-in
        expect(s.loadUint(64)).toBe(0); // query_id echoed
        expect(s.loadCoins()).toBe(amount); // minted LP at the 1:1 rate this test set
    });

    it('THE FINDING: no recipient field exists in the schema — building the same message from two different treasuries still pays the vault SENDER, never a chosen address', async () => {
        await vault.sendSetLpRate(owner.getSender(), { lpNum: 1n, lpDen: 1n, value: toNano('0.05') });
        const other = await blockchain.treasury('otherDepositor', { balance: toNano('100') });

        const amount = toNano('5');
        await vault.sendDedustDeposit(depositor.getSender(), {
            value: amount + toNano('1'),
            amount,
            poolType: 0,
            asset0: { kind: 'native' },
            asset1: { kind: 'jetton', workchainId: 0, address: 123n },
            minLpAmount: amount,
            asset0TargetBalance: 0n,
            asset1TargetBalance: 0n,
        });
        const r = await vault.sendDedustDeposit(other.getSender(), {
            value: amount + toNano('1'),
            amount,
            poolType: 0,
            asset0: { kind: 'native' },
            asset1: { kind: 'jetton', workchainId: 0, address: 123n },
            minLpAmount: amount,
            asset0TargetBalance: 0n,
            asset1TargetBalance: 0n,
        });

        // `other`'s deposit pays `other`, never `depositor` — there is no
        // field in the message this test could have set to redirect it.
        expect(r.transactions).toHaveTransaction({ from: vault.address, to: other.address, success: true });
        expect(r.transactions).not.toHaveTransaction({ from: vault.address, to: depositor.address });
    });

    it('REFUND (not a throw/bounce): under-filled deposit returns the GRAM gracefully — the documented DeDust behaviour, distinct from a swap slippage revert', async () => {
        // lpNum/lpDen still 0/1 from beforeEach — every deposit "mints" 0 LP,
        // guaranteed below any positive min_lp_amount.
        const amount = toNano('3');
        const r = await vault.sendDedustDeposit(depositor.getSender(), {
            value: amount + toNano('1'),
            amount,
            poolType: 0,
            asset0: { kind: 'native' },
            asset1: { kind: 'jetton', workchainId: 0, address: 456n },
            minLpAmount: 1n,
            asset0TargetBalance: 0n,
            asset1TargetBalance: 0n,
        });

        // No bounce anywhere — this is a normal successful transaction chain,
        // not a bounced/aborted one, unlike the swap mock's REJECT path.
        expect(
            r.transactions.some((t) => t.inMessage?.info?.type === 'internal' && (t.inMessage.info as any).bounced)
        ).toBe(false);
        expect(r.transactions).toHaveTransaction({ to: vault.address, success: true });

        const refund = r.transactions.find(
            (t) => t.inMessage?.info?.type === 'internal' && t.inMessage.info.dest?.equals(depositor.address)
        );
        expect(refund).toBeDefined();
        const s = refund!.inMessage!.body.beginParse();
        expect(s.loadUint(32)).toBe(0x92000021); // this mock's own DepositRefunded signal
        expect(s.loadUint(64)).toBe(0);
        expect(s.loadCoins()).toBe(amount); // the full deposited amount, returned
    });

    it('a malformed body (missing reject_payload bit) is rejected the way a real parse mismatch would be — the mock checks shape, not just opcode', async () => {
        const amount = toNano('1');
        const body = beginCell()
            .storeUint(DEDUST_DEPOSIT_OP, 32)
            .storeUint(0, 64)
            .storeCoins(amount)
            .storeUint(0, 1)
            .storeUint(0, 4) // asset0 native
            .storeUint(0, 4) // asset1 native
            .storeRef(beginCell().storeCoins(0n).storeCoins(0n).storeCoins(0n).endCell())
            .storeUint(0, 1) // fulfill_payload = none$0
            // reject_payload bit OMITTED — one bit short of the real schema
            .endCell();

        const r = await depositor.send({ to: vault.address, value: amount + toNano('1'), bounce: true, body });
        expect(r.transactions).toHaveTransaction({ to: vault.address, success: false });
    });
});
