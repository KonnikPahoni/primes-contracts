// TON PRIMES — D10: jetton interop abuse — unsolicited transfer notifications,
// wrong wallet, forged master (GAUNTLET.md D10).
//
// WHY THIS FILE EXISTS ALONGSIDE JettonInterop.spec.ts
//
// `JettonInterop.spec.ts` is a COMPLIANCE suite — "the PRIMES jetton as a wallet
// or DEX sees it": standard method IDs resolve, `get_wallet_address` agrees with
// the native getter, TEP-64 content round-trips. Every test in it asks whether a
// well-behaved counterparty gets the right answer. Not one asks what a
// misbehaving one gets, and D10 is entirely about the second question.
//
// THE ATTACK, AND WHY IT IS CHEAP. A `transfer_notification` is just a message
// with opcode 0x7362d09c. Anyone can send one, from any address, claiming any
// amount, and a contract that believes it is a contract that can be told it
// received tokens it never received. That is the standard jetton footgun, and it
// costs an attacker one message.
//
// THE RATCHET IS THE CONTRACT HERE THAT LISTENS FOR IT. (The burn sink was a
// second, which REJECTED a stranger's notification with 1111; D-212 deleted it.)
//
//   the RATCHET has NO sender assert on the arm — its own comment says so —
//              and instead gates the EFFECT: the burn counters move only when
//              the sender is the configured wallet. An unsolicited notification
//              is accepted, counted nowhere, and its TON carried straight back
//              out to whoever sent it.
//
// The ratchet's shape is the more interesting of the two: it is safe not because
// the message is refused but because believing it costs nothing. Testing only
// "does it throw" would have marked that arm as unprotected; testing the counter
// is what shows it is not.
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, beginCell, toNano } from '@ton/core';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { PrimesRatchet } from '../wrappers/PrimesRatchet';
import { PrimesJettonMaster } from '../wrappers/PrimesJettonMaster';
import { PrimesJettonWallet } from '../wrappers/PrimesJettonWallet';
import { TEP74 } from '../../shared/opcodes';

/** TEP-74 `transfer_notification`, as both listeners decode it. */
function notification(amount: bigint, sender: Address): Cell {
    return beginCell()
        .storeUint(TEP74.transfer_notification, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(sender)
        .storeRef(beginCell().endCell())
        .endCell();
}

/** TEP-74 `internal_transfer` (0x178d4519) — what a sibling wallet sends when tokens move. */
function internalTransfer(amount: bigint, from: Address, responseAddr: Address): Cell {
    return beginCell()
        .storeUint(TEP74.internal_transfer, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(from)
        .storeAddress(responseAddr)
        .storeCoins(0)
        .storeRef(beginCell().endCell())
        .endCell();
}

describe('TON PRIMES — D10: a forged jetton message is believed by nobody who matters', () => {
    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let genesisScript: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let holder: SandboxContract<TreasuryContract>;
    let realWallet: SandboxContract<TreasuryContract>;
    let codes: Record<string, Cell>;
    let ratchet: SandboxContract<PrimesRatchet>;
    let master: SandboxContract<PrimesJettonMaster>;

    beforeAll(async () => {
        codes = {
            jettonWallet: await compile('PrimesJettonWallet'),
            jettonMaster: await compile('PrimesJettonMaster'),
            ratchet: await compile('PrimesRatchet'),
        };
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        blockchain.now = 1_770_000_000;
        deployer = await blockchain.treasury('deployer');
        genesisScript = await blockchain.treasury('genesisScript');
        attacker = await blockchain.treasury('attacker', { balance: toNano('500') });
        holder = await blockchain.treasury('holder');
        // Stands in for the ratchet's own PRIMES wallet — the one address its
        // burn counter is allowed to believe.
        realWallet = await blockchain.treasury('ratchetJettonWallet');

        master = blockchain.openContract(
            PrimesJettonMaster.createFromConfig(
                {
                    ledgerAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    walletCode: codes.jettonWallet,
                },
                codes.jettonMaster
            )
        );
        await master.sendDeploy(deployer.getSender(), toNano('5'));

        ratchet = blockchain.openContract(
            PrimesRatchet.createFromConfig(
                {
                    venueTimelockAddr: deployer.address,
                    genesisScriptAddr: genesisScript.address,
                    dedustNativeVault: deployer.address,
                    dedustPool: deployer.address,
                    primesJettonVault: deployer.address,
                },
                codes.ratchet
            )
        );
        await ratchet.sendDeploy(deployer.getSender(), toNano('10'));
        await ratchet.sendSetLedger(genesisScript.getSender(), {
            ledgerAddr: deployer.address,
            value: toNano('0.05'),
        });
    });

    // ------------------------------------------------------------------ //
    // Unsolicited transfer notifications
    // ------------------------------------------------------------------ //

    describe('the ratchet\'s burn counter believes exactly one address', () => {
        it('counts nothing from a stranger, even once the real wallet is configured', async () => {
            await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
                jettonWalletAddr: realWallet.address,
                value: toNano('0.05'),
            });
            const before = await ratchet.getBurnStats();

            // A forged notification claiming a million PRIMES were burned.
            await attacker.send({
                to: ratchet.address,
                value: toNano('0.5'),
                bounce: false,
                body: notification(toNano('1000000'), attacker.address),
            });

            const after = await ratchet.getBurnStats();
            expect({ burned: after.burnedPrimes, events: after.burnEvents }).toEqual({
                burned: before.burnedPrimes,
                events: before.burnEvents,
            });
        });

        it('counts nothing BEFORE the wallet is configured either — walletSet = 0 is idle, not open', async () => {
            // The window between deploy and `set_jetton_wallet` is the one where
            // a naive implementation is wide open: no configured address to
            // compare against, so "does it match" is vacuously true. Here the
            // guard is `walletSet == 1 && ...`, so the counter is IDLE rather
            // than permissive, and the under-count is documented in the
            // contract as the deliberate trade.
            expect((await ratchet.getBurnStats()).counting).toBe(0);
            await attacker.send({
                to: ratchet.address,
                value: toNano('0.5'),
                bounce: false,
                body: notification(toNano('5000'), attacker.address),
            });
            const after = await ratchet.getBurnStats();
            expect(after.burnedPrimes).toBe(0n);
            expect(after.burnEvents).toBe(0);
        });

        it('DOES count from the configured wallet — otherwise the tests above prove nothing', async () => {
            // The positive control. A guard that rejected everything would pass
            // both tests above while breaking the mechanic entirely.
            await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
                jettonWalletAddr: realWallet.address,
                value: toNano('0.05'),
            });
            expect((await ratchet.getBurnStats()).counting).toBe(1);

            // Swap proceeds: the jetton-level sender is the venue's PRIMES vault
            // (`deployer` in this suite).
            await realWallet.send({
                to: ratchet.address,
                value: toNano('0.5'),
                bounce: false,
                body: notification(toNano('7'), deployer.address),
            });

            const after = await ratchet.getBurnStats();
            expect(after.burnedPrimes).toBe(toNano('7'));
            expect(after.burnEvents).toBe(1);
        });

        it("does NOT count a holder's own transfer to the real wallet — it chose the burn's gas (2026-11-08 audit)", async () => {
            // An honest notification from our own wallet, for PRIMES a holder sent with
            // too little TON for the burn to land: counting it published a burn that
            // IGNORE_ERRORS then dropped.
            await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
                jettonWalletAddr: realWallet.address,
                value: toNano('0.05'),
            });
            await realWallet.send({
                to: ratchet.address,
                value: toNano('0.006'),
                bounce: false,
                body: notification(toNano('7'), holder.address),
            });
            const after = await ratchet.getBurnStats();
            expect(after.burnedPrimes).toBe(0n);
            expect(after.burnEvents).toBe(0);
        });

        it('accepts the forged message without throwing, and hands the TON straight back', async () => {
            // The ratchet's arm deliberately has no sender assert — its own
            // comment says so. That is safe here because believing the message
            // costs nothing: nothing is counted, and the handler replies to
            // `in.senderAddress` with CARRY_ALL_REMAINING, so the attacker's own
            // TON leaves again. Worth pinning because a reader checking only for
            // a `throw` would mark this arm unprotected, and a future edit that
            // "fixed" it by adding an assert would break the real burn path's
            // reply.
            await ratchet.sendSetJettonWallet(genesisScript.getSender(), {
                jettonWalletAddr: realWallet.address,
                value: toNano('0.05'),
            });
            const r = await attacker.send({
                to: ratchet.address,
                value: toNano('0.5'),
                bounce: false,
                body: notification(toNano('1000000'), attacker.address),
            });
            // The ratchet did not throw...
            expect(r.transactions).toHaveTransaction({ to: ratchet.address, success: true });
            // ...and sent a message back to the forger rather than keeping the value.
            expect(r.transactions).toHaveTransaction({
                from: ratchet.address,
                to: attacker.address,
            });
        });
    });

    // ------------------------------------------------------------------ //
    // Wrong wallet / forged master, on the wallet itself
    // ------------------------------------------------------------------ //

    describe('a wallet credits only its own master and its own siblings', () => {
        /** The real wallet the master would deploy for `owner`. */
        async function walletFor(owner: Address) {
            return blockchain.openContract(
                PrimesJettonWallet.createFromAddress(await master.getWalletAddress(owner))
            );
        }

        it('mints to a holder through the master, so there is a real wallet to attack', async () => {
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('100'),
                value: toNano('0.2'),
            });
            const w = await walletFor(holder.address);
            expect((await w.getWalletData()).balance).toBe(toNano('100'));
        });

        it('refuses an internal_transfer from a stranger — the forged-sibling case', async () => {
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('100'),
                value: toNano('0.2'),
            });
            const w = await walletFor(holder.address);
            const before = (await w.getWalletData()).balance;

            // The attacker claims to be a sibling wallet delivering 1000 PRIMES.
            const r = await attacker.send({
                to: w.address,
                value: toNano('0.3'),
                bounce: true,
                body: internalTransfer(toNano('1000'), attacker.address, attacker.address),
            });
            expect(r.transactions).toHaveTransaction({
                to: w.address,
                success: false,
                exitCode: 100, // wrong_sender
            });
            expect((await w.getWalletData()).balance).toBe(before);
        });

        it('refuses an internal_transfer whose `from` is spoofed to name a real holder', async () => {
            // The subtler forgery. The sibling check derives the expected
            // address from `msg.from` — so claiming to be a delivery FROM a real
            // holder does not help: the attacker's own address still has to
            // equal `siblingWalletAddress(msg.from, master, ourCode)`, and it
            // does not. This is the test that shows the check is on the
            // relationship, not merely on the field being populated.
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('100'),
                value: toNano('0.2'),
            });
            const w = await walletFor(holder.address);
            const before = (await w.getWalletData()).balance;

            const r = await attacker.send({
                to: w.address,
                value: toNano('0.3'),
                bounce: true,
                body: internalTransfer(toNano('1000'), deployer.address, attacker.address),
            });
            expect(r.transactions).toHaveTransaction({
                to: w.address,
                success: false,
                exitCode: 100,
            });
            expect((await w.getWalletData()).balance).toBe(before);
        });

        it('refuses a mint relayed by a FORGED master — a different master cannot credit our wallet', async () => {
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('100'),
                value: toNano('0.2'),
            });
            const w = await walletFor(holder.address);
            const before = (await w.getWalletData()).balance;

            // A second, independently deployed master with the same wallet code.
            // It is a real jetton master — just not OUR jetton master — and the
            // wallet compares `in.senderAddress` against the master baked into
            // its own state, so its address does not match.
            const forged = blockchain.openContract(
                PrimesJettonMaster.createFromConfig(
                    {
                        ledgerAddr: attacker.address,
                        genesisScriptAddr: attacker.address,
                        walletCode: codes.jettonWallet,
                    },
                    codes.jettonMaster
                )
            );
            await forged.sendDeploy(attacker.getSender(), toNano('5'));
            expect(forged.address.equals(master.address)).toBe(false);

            const r = await attacker.send({
                to: w.address,
                value: toNano('0.3'),
                bounce: true,
                body: internalTransfer(toNano('1000'), holder.address, attacker.address),
            });
            expect(r.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: 100 });
            expect((await w.getWalletData()).balance).toBe(before);
        });

        it('the real master CAN credit it — the positive control for all three refusals', async () => {
            const w = await walletFor(holder.address);
            await master.sendMintGenesis(genesisScript.getSender(), {
                to: holder.address,
                amount: toNano('42'),
                value: toNano('0.2'),
            });
            expect((await w.getWalletData()).balance).toBe(toNano('42'));
        });
    });
});
