// TON PRIMES — D1: unauthorised sender on every message arm, as a TABLE
// (GAUNTLET.md D1, CONCEPT.md §8).
//
// The item asks for a table rather than per-contract prose, and the reason is
// the failure mode it prevents: per-contract prose covers the arms someone
// thought to write about, and an arm added later inherits no coverage at all.
// A table covers the arms that EXIST, by construction, and fails when the set
// changes.
//
// THE CLAIM. Every one of the 99 message arms is either **caller-authorised**
// by some mechanism, or **deliberately permissionless**. There is no third
// category, and an arm in neither is a finding.
//
// Permissionless is a real and necessary class here, not a euphemism. `flush`,
// `sweep_ops`, `sync_head`, `open_head_lot` and `bid` are open BY DESIGN
// (§4.3.1, §4.1, §4.4) and CONCEPT.md leans on it — a keeper-free protocol is
// one where anyone can push the crank. So this spec cannot demand a gate
// everywhere. What it does instead is enumerate the open set BY NAME, so an arm
// arriving there by accident fails rather than being assumed intentional.
//
// FOUR MECHANISMS, FOUND THE HARD WAY. The generator's first pass looked only
// for `senderAddress ==` on the left and reported 35 open arms. Reading them
// showed it was wrong about eleven, in four distinct ways — each a real gate:
// a reversed comparison, the sender used as a dictionary key, the sender
// forwarded to a peer that checks, and a signature. All four are recognised now;
// see `tools/sender-gates.mjs` for the detail. The count went 74 → 85 gated,
// and D-147 removed one arm (`request_withdraw`) and added two (`relock` gated,
// `expire` deliberately open).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const REPO = join(__dirname, '..', '..');
const CONTRACTS_DIR = join(REPO, 'contracts', 'contracts');
const DOC = join(REPO, 'docs', 'audit', 'sender-gates.md');

type Row = { file: string; line: number; arm: string; authorised: boolean };

function readTable(): Row[] {
    const md = readFileSync(DOC, 'utf8');
    const rows: Row[] = [];
    let inOpen = false;
    for (const line of md.split('\n')) {
        if (line.startsWith('## Permissionless arms')) inOpen = true;
        if (line.startsWith('## Limits')) inOpen = false;
        const m = line.match(/^\| `([^`]+)` \| (\d+) \| `([^`]+)` \|/);
        if (m) rows.push({ file: m[1], line: Number(m[2]), arm: m[3], authorised: !inOpen });
    }
    return rows;
}

/**
 * The arms that are open on purpose, each with the reason. Enumerated here
 * rather than in the generator so that adding one is a deliberate edit to a
 * TEST, reviewed as such — the generator only reports what it finds.
 */
const PERMISSIONLESS: Record<string, string> = {
    // TEP standards. A metadata query that required authorisation would not be
    // the standard.
    'primes_collection.tolk::GetRoyaltyParams': 'TEP-66 royalty query',
    'primes_item.tolk::GetStaticData': 'TEP-62 static-data query — answers with facts get_nft_data already publishes',
    'primes_item.tolk::TopUp': 'D-62/GAUNTLET.md D9.1 — anyone may extend a composite item\'s rent runway',

    // TEP-89, R19. The on-chain half of the jetton's standard surface. Gating it
    // would gate LISTING, not abuse: it answers with a pure function of the owner
    // address and this master's own wallet code — the identical value
    // `get_wallet_address` already returns to any reader and `deployAndCredit`
    // recomputes at every mint. It moves no money, reads no caller-controlled
    // state and writes nothing. A master that demanded authorisation here would be
    // one no DEX vault could initialise against, which is exactly the defect this
    // arm was added to fix.
    'primes_jetton_master.tolk::ProvideWalletAddress': 'TEP-89 wallet-address query — public derivable data; gating it would gate listing (GAUNTLET R19)',

    // TEP-74's excess return, 2026-09-17. Both contracts write their OWN address
    // into the `response_destination` of a jetton message they send — the master
    // in `deployAndCredit` (it funds the wallet deploy, so the change is its
    // own), the vault in `payOut` (H11: `TRANSFER_GAS` comes out of the vault's
    // balance) — and the recipient's wallet answers with `excesses#d53276db`.
    //
    // Open because there is nothing to gate: the arm moves no money, reads no
    // caller-controlled field and writes no state. The value is credited by the
    // credit phase before the arm runs, so the worst an impostor achieves is
    // DONATING GRAM to a contract that spends it on gas. A sender check would buy
    // nothing and would have to name the recipient's wallet — an address neither
    // contract knows in advance.
    //
    // The alternative is what was there until 2026-09-17: no arm at all, so the
    // reply hit `else => assert (in.body.isEmpty()) throw 101` and EVERY mint's
    // trace carried two aborted leaves (testnet trace 8c354845…d724a).
    'primes_jetton_master.tolk::Excesses': 'TEP-74 excess return to an address the master itself named; moves nothing, writes nothing',
    'primes_bounty_vault.tolk::Excesses': 'TEP-74 excess return to an address the vault itself named (H11); moves nothing, writes nothing',
    // GAUNTLET.md B27 and B28. Same shape as the three above, and open for the same
    // reason: the value is credited before the arm runs, the arm moves nothing and
    // writes nothing, and the worst an impostor achieves is donating GRAM to a contract
    // with no withdraw path. Gating them would buy nothing and could fail a reply the
    // contract itself asked for by naming its own address as `response_destination`.
    'primes_treasury.tolk::Excesses': 'TEP-74 excess return on a governance payout the treasury itself named (B27); moves nothing, writes nothing',

    // The player actions. These ARE the game; gating them would be the bug.
    // D-191 point 1: the mint is sent to the beneficiary's minter card, which
    // forwards it to the ledger (the ledger's own arm is card-gated now).
    'primes_minter_card.tolk::Mint': '§4 — anyone may mint the head, or gift one (§4.5); that is the game',
    'primes_market.tolk::OpenLot': '§4.4 / D-30 — opening IS the first bid, permissionless',
    // D-212: anyone may ASK to name a number; item(n) checks the sender is its owner and
    // refunds every refusal, so the open door moves no GRAM but the caller's own.
    'primes_collection.tolk::NameNumber': '§4.7.1 / D-212 — the owner names a number for GRAM; the item is the gate (owner + fee), and every refusal refunds',
    'primes_market.tolk::OpenHeadLot': '§4.4 — permissionless, unpriced lot open',
    'primes_market.tolk::BidLot': '§4.4 — a bid is the purchase; anyone may bid',

    // The cranks. CONCEPT.md's keeper-free claim rests on these being open: if
    // any needed an authorised caller, the protocol would need a keeper, and a
    // keeper that stops is an outage.
    'primes_ratchet.tolk::Flush': '§4.3.1 — permissionless, floor-guarded',
    // §4.3.2 / D-151's three triggers, and open in a STRONGER sense than
    // `Flush`: `flush` has one number a caller may lower, and these have no
    // number at all. Each leg's size is computed by the contract from
    // `reserveTarget` against its own balances, so a caller can trigger the rule
    // and cannot aim it — there is no destination field and no size field to
    // supply. That absence is §11.14's constraint made structural rather than
    // asserted, and it is why reopening Q14 was possible at all.
    'primes_ratchet.tolk::Stake': '§4.3.2 — permissionless; NO amount field, the size is `pending - reserveTarget`',
    'primes_ratchet.tolk::Unstake': '§4.3.2 — permissionless; refuses unless the reserve is short, and sizes the exit itself',
    'primes_ratchet.tolk::Harvest': '§4.3.2 — permissionless, 30-day gated; pays accrued tsTON to the governed treasury, an address no message names',
    'primes_ratchet.tolk::RecoverExit': 'D-155 — permissionless, 72-hour gated; RESTORES a stranded tranche and credits nothing, so `T` is unchanged and there is nothing for a caller to aim',
    // §4.3.2's replies, all four of which arrive NON-BOUNCEABLE, so the
    // alternative to an open arm is not a gated arm — it is the catch-all
    // `throw 101` eating a protocol reply and painting the trace red while the
    // balance looks right (MISTAKES.md, 2026-09-17).
    //
    // The two payout-bill messages are UNAUTHENTICATABLE BY CONSTRUCTION, not by
    // omission: the collection's address is salted with `random()` at deploy
    // (`address_calculations.func:67-68`), so it cannot be precomputed at genesis
    // or whitelisted afterwards without adding a message to set it — a new admin
    // surface on the one contract whose whole claim is that it has none. D-151
    // makes them safe by arithmetic instead: `ownership_assigned` takes NO
    // accounting action at all, and `distributed_asset` credits `pending` and
    // draws `exiting` down by the same figure, both terms of `T`, capped at what
    // this contract's own `unstake` put there. A forged one is a donation that
    // costs the forger exactly what it gives the ratchet.
    'primes_ratchet.tolk::PayoutOwnershipAssigned': '§4.3.2 leg 3 — takes NO accounting action; the bill collection`s address is salted with random() and cannot be whitelisted',
    'primes_ratchet.tolk::PayoutDistributedAsset': '§4.3.2 leg 3 — same unwhitelistable sender; only while leg 3 is open, credits `pending` and debits `exiting` and `exitCostBasis` by the same figure (2026-09-26), so a forgery is a donation',
    'primes_ratchet.tolk::Excesses': 'TEP-74 excess return from a wallet this contract itself named in `response_destination`; moves nothing, writes nothing',
    'primes_ledger.tolk::SweepOps': '§4.1 — permissionless; pays a fixed formula to a fixed address (C9)',
    'primes_ledger.tolk::SyncHead': '§4.4 — pushes the market\'s lagging head hint',
    'primes_ledger.tolk::AdvanceHead': '§4.4, D-189 — finishes a gas-bounded head walk; moves no GRAM, returns the caller its own unburnt value',
    'primes_ledger.tolk::ImportLotBlock': "D-196 — pulls the frontier block's auction marks in once the head's window reaches it; refuses early (225), names no address, moves no GRAM out",
    'primes_ledger.tolk::FlushUnsold': "D-198 — moves the oldest passed block's unsold rows to its own lot block (an address derived from the block, never named by the caller); refuses while the head is in the block (225), moves no GRAM but the caller's",
    'primes_ledger.tolk::SyncLaunch': '§6 point 0 — re-sends LaunchOpen, idempotent',
    'primes_ledger.tolk::ClaimDividend': '§3.2 — pays the PRIME OWNER, not the caller',
    // Open in the strongest sense: it takes money IN and gives PRIMES back at a
    // fixed rate, so there is no withdraw to gate and nothing a caller can
    // extract. A stranger calling it donates backing to every holder.
    // D-179. The sink cannot read `T`/`S` synchronously, so it asks. Open in the
    // strongest sense: it writes nothing, moves no money but the asker's own
    // gas back to the asker, and the echoed order is opaque here. The sink's
    // answering arm (`floor_quote`) is the one that is gated — on this ledger.
    'primes_ledger.tolk::DonateFloor': 'D-91 point 4 — GRAM in, PRIMES to the sender; raises p_f for everyone',
    'primes_ledger.tolk::RetryCredit': 'retry lane — re-sends a bounced credit to its rightful item',
    // D-52, and open in the same strong sense as `DonateFloor` above: the caller
    // names `to`, but `to` is ALSO the dictionary key, so a stranger can only replay
    // an emission a bounce already recorded FOR THAT WALLET. There is no address a
    // caller can supply that pays them anything they were not already owed, and the
    // caller pays the gas to deliver someone else's PRIMES.
    'primes_ledger.tolk::RetryMint': 'D-52 retry lane — re-sends a bounced jetton mint to the wallet its own bounce recorded',
    'primes_ledger.tolk::RetryItem': 'D-117 retry lane — re-sends a bounced mint_item with the owner and held split its own bounce recorded',
    'primes_bounty_vault.tolk::RetryBountyPayout': 'D-53/B12.1 — retry lane; replays a journalled beneficiary/amount already decided at the original send',
    'primes_market.tolk::CloseLot': '§4.4 — anyone may close an expired lot',
    // D-147's `expire`, and the strongest kind of open arm in this table: it
    // CHANGES NO RULE. A matured term cannot vote whether or not it has been
    // expired, because `position_vote` checks the position's own clock — so
    // this arm only makes two published aggregates agree with a timestamp that
    // has already passed. It moves no LP, no PRIMES and no GRAM, it names no
    // destination, it cannot be aimed, and a second send returns rather than
    // decrementing twice.
    //
    // Open because the party it helps is a would-be PROPOSER measured against
    // an inflated `eligibleWeight`, and that party is not the position's owner.
    // Gating it on the owner would leave the denominator wrong for everyone
    // else whenever a depositor walked away, which is precisely the failure it
    // exists to prevent — `Flush`'s argument, with a smaller pot.
    'primes_lp_position.tolk::Expire': 'D-147 — retires a matured term’s vote weight from two published aggregates; moves nothing, changes no rule, idempotent',
    'primes_market.tolk::RetryPremiumForward': 'retry lane — re-sends stuck premium to the ratchet',
    'primes_market.tolk::ParkLots': 'D-200 — folds resting descending rows into their parked bit; moves no GRAM but the caller’s own change, and the lot stays open at the same resting price',

    // Timelocks. D-90 deletes `primes_market.tolk::Settle` — it was a relay to
    // the shard, and there is no shard and nothing to settle later. `Execute` is
    // gated at QUEUE time (proposer-only, throw 800) and the delay is the
    // protection; anyone firing a matured action is the point of a timelock,
    // not a hole.
    'primes_venue_timelock.tolk::Execute': '§11.1 — gated at queue time; the ETA is the guard',
    // D-77's vest is the same shape as the timelock's `Execute`, and open for the
    // same reason: the beneficiary must not be able to withhold execution of an
    // already-public, already-matured schedule. It is safe to open because the
    // message carries NO destination field — the only address the contract can
    // pay is the one fixed in its deploy data, so a stranger calling this moves
    // the operator's own tranche to the operator and gains nothing.
    'primes_vesting.tolk::Release': 'D-77 — the schedule is the guard; no field names a recipient, so the payout is always to the deploy-fixed beneficiary',
    'primes_venue_timelock.tolk::RetryUpdateVenue': '§11.1 — re-sends an already-matured, already-fired action',

    // D-100 point 8's treasury execute, and the third arm of the timelock shape
    // above: gated at PROPOSE time (a proposer needs >= PROPOSE_MIN_BPS of
    // eligible weighted LP), then by a 1-day vote of the >= 30-day tiers, then by
    // `yes > no` — and only then may anybody push it. Opening the last step is
    // not a hole in that chain, it is what stops the chain needing a keeper: a
    // passed proposal only its proposer could execute would be a proposal its
    // proposer could veto after the fact. The caller names nothing: `Execute`
    // carries a `seq` and no destination, and every term of the payment
    // (`prop.dest`, `prop.amount`, `prop.asset`) was written at propose time and
    // re-checked against the cap at execute time. `NoAdminWithdraw.spec.ts`
    // asserts that guard chain in source; here it only has to be on the list.
    'primes_treasury.tolk::Execute': 'D-100 point 8 — gated at propose and by the vote; permissionless execute is what keeps the treasury keeper-free',
    // D-168. `distribute()` names no destination and no amount: the recipient is
    // the stake master fixed in deploy data and the budget is the formula over
    // the balance, at most once per interval — `Harvest`'s shape. And the stake
    // child's `Expire` is the LP child's `Expire` with money in it: it BANKS the
    // prorated tail on the position (paying nobody) and retires the weight from
    // `totalWeight`, which is what stops a matured stake diluting everyone else.
    'primes_treasury.tolk::Distribute': 'D-168 — once per interval, formula-sized, to the deploy-fixed stake master; the caller names nothing',
    'primes_treasury.tolk::Prune': 'D-188 point 7 — deletes only a settled proposal (failed and closed, or past its execute window); moves no asset',
    'primes_stake_position.tolk::Expire': 'D-168 — banks a matured position`s tail on the position itself and retires its weight; names no destination, idempotent',
};

describe('TON PRIMES — D1: every message arm is authorised or deliberately open', () => {
    const rows = readTable();
    const key = (r: Row) => `${r.file}::${r.arm}`;

    it('the generated table is current — regenerating it changes nothing', () => {
        const before = readFileSync(DOC, 'utf8');
        execFileSync(process.execPath, [join(REPO, 'tools', 'sender-gates.mjs')], { cwd: REPO });
        expect(readFileSync(DOC, 'utf8')).toBe(before);
    }, 60_000);

    it('covers every arm of every contract — the count matches the sources', () => {
        // The table proves nothing if it missed a contract or an arm. Recount
        // independently, from the same shape the generator matches.
        let counted = 0;
        for (const f of readdirSync(CONTRACTS_DIR).filter((x) => x.endsWith('.tolk'))) {
            const src = readFileSync(join(CONTRACTS_DIR, f), 'utf8');
            counted += [...src.matchAll(/^ {8}[A-Z][A-Za-z0-9_]*\s*=>/gm)].length;
        }
        expect(rows.length).toBe(counted);
        // 109 before D-90 deleted the shard contract and the market's whole
        // escrowed-claim lane.
        expect(rows.length).toBeGreaterThanOrEqual(99);
    });

    it('THE CLAIM: every arm is authorised or is on the deliberate-open list', () => {
        const unaccounted = rows
            .filter((r) => !r.authorised && !(key(r) in PERMISSIONLESS))
            .map((r) => `${r.file}:${r.line} ${r.arm}`);
        expect(unaccounted).toEqual([]);
    });

    it('and the open list has no dead entries — every reason names a real arm', () => {
        // The other direction. A stale entry here would silently excuse an arm
        // that no longer exists, and would go on excusing a NEW arm that
        // happened to reuse the name.
        const open = new Set(rows.filter((r) => !r.authorised).map(key));
        const dead = Object.keys(PERMISSIONLESS).filter((k) => !open.has(k));
        expect(dead).toEqual([]);
    });

    it('the great majority of arms ARE gated — the open set is the exception', () => {
        const authorised = rows.filter((r) => r.authorised).length;
        // 0.65, down from 0.70 with D-151. §4.3.2 adds seven open arms to one
        // contract at once — three triggers with no field to aim and four
        // non-bounceable replies that MUST be accepted — against one gated arm
        // (`SetTstonWallet`). The bar is a shape check ("most arms are gated"),
        // not a budget, and the seven are each named and argued in the map above;
        // lowering it is the deliberate edit, not a slipped one.
        expect(authorised).toBeGreaterThan(rows.length * 0.65);
        // Non-vacuous in the other direction too: if this ever reported every
        // arm as gated, the detector would have stopped discriminating.
        expect(rows.filter((r) => !r.authorised).length).toBeGreaterThan(0);
    });

    it('no arm that moves protocol GRAM to a caller-named address is open', () => {
        // D1 crossed with C9. The withdraw surface says where money can go; this
        // says who may ask. The dangerous combination is an OPEN arm that also
        // pays an address the message names — that is a withdraw path with extra
        // steps. `ClaimDividend` is the case that looks like one and is not: it
        // pays the prime's OWNER, resolved from chain state, never the caller.
        //
        // `ClaimDividend =>`'s own dispatch arm is a ONE-LINER delegating to
        // `handleClaimDividend` — the real logic, and the thing this test is
        // actually about, lives in that function's body elsewhere in the
        // file. Slicing from the dispatch arm's own text (as this used to)
        // finds no `\n        }` inside a single-line arm at all, so it fell
        // through into WHATEVER later arm happened to close on that exact
        // 8-space-indented pattern first — accidentally capturing unrelated
        // code (GAUNTLET V9 added a real, legitimate `dest: in.senderAddress`
        // inside `SettlePrimeClearing`, several arms later, and this test's
        // old slice silently swept it in). Anchored on the function
        // definition and its own top-level closing brace instead, so the
        // slice can only ever be `handleClaimDividend`'s real body.
        const src = readFileSync(join(CONTRACTS_DIR, 'primes_ledger.tolk'), 'utf8');
        const fn = src.slice(src.indexOf('fun handleClaimDividend('));
        const body = fn.slice(0, fn.indexOf('\n}'));
        expect(body).not.toMatch(/dest:\s*in\.senderAddress/);

        // D-100 point 8 adds the second case of the same shape, and it is the
        // one that has to be looked at rather than reasoned about: the
        // treasury's `Execute` IS open and DOES pay an arbitrary address. What
        // keeps it off the withdraw surface is that the address is not the
        // caller's to name — `prop.dest` was written by a `Propose` and survived
        // a vote. Same negative check: nothing on this arm pays whoever pushed
        // it, and nothing on it reads a destination out of the message.
        const treasury = readFileSync(join(CONTRACTS_DIR, 'primes_treasury.tolk'), 'utf8');
        const exec = treasury.slice(treasury.indexOf('Execute =>'));
        const execBody = exec.slice(0, exec.indexOf('\n        }'));
        expect(execBody).not.toMatch(/dest:\s*in\.senderAddress/);
        expect(execBody).not.toMatch(/dest:\s*msg\./);
        expect(execBody).toMatch(/dest:\s*prop\.dest/);
    });
});
