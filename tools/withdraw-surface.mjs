#!/usr/bin/env node
// Regenerates docs/audit/withdraw-surface.md — every outbound GRAM-carrying
// message every contract can emit, classified by WHO the destination is.
//
// WHY THIS EXISTS (GAUNTLET.md C9, CONCEPT.md §8)
//
// "No admin withdraw path on any GRAM balance, not timelocked, not multisig" is
// the single strongest claim in the design, and the one an auditor checks
// first. It was tested by `FuzzInvariants.spec.ts`'s I5: fire every opcode from
// every privileged sender at the LEDGER and assert nobody ends up richer. That
// is a good test and it covers one contract out of sixteen. A dynamic probe can
// only ever cover the arms it thinks to fire, on the contracts it thinks to
// point at — and the claim is about the whole surface.
//
// This is the complement: a STATIC enumeration. GRAM only ever leaves a contract
// through an outbound message, so the set of ways money can move IS the set of
// `createMessage` sites. Enumerate all of them, classify each destination, and
// the claim reduces to a property of a finite table that a reader can check by
// eye — and that a new send cannot quietly join, because an unrecognised
// destination expression fails the accompanying spec rather than being assumed
// benign.
//
// WHAT IT DOES NOT DO. This is a lexical pass over the source, not a verifier.
// It does not prove a handler is reachable, does not evaluate the `value`
// expression, and does not follow an address through a helper's parameter
// (those are reported as `via-helper` and resolved by hand in the spec). Its job
// is to make the surface countable and to fail loudly when the surface changes.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { emitPage, isCheckMode } from './lib/audit-page.mjs';
import { join, basename } from 'node:path';

const CONTRACTS_DIR = join(process.cwd(), 'contracts', 'contracts');
const OUT = join(process.cwd(), 'docs', 'audit', 'withdraw-surface.md');

/**
 * Destination classification.
 *
 *   peer      another protocol contract, at a deploy-fixed or derived address.
 *             Money moving here has not left the protocol — the receiving
 *             contract's own rules still apply, and it appears in this table too.
 *   player    the counterparty of the message being handled: whoever sent it,
 *             whoever owns the item, whoever is owed a refund. Never chosen by
 *             an operator.
 *   operator  an address the team controls. THE ONLY CATEGORY §8 IS ABOUT.
 *   deploy    a state-init deploy of a child contract (AutoDeployAddress).
 *   venue     the DeDust vault — external, but fixed by the venue timelock and
 *             not an address the team can set at will.
 *   governed  an address a PASSED PROPOSAL named (D-100 point 8). The one class
 *             this generator gained since it was written, and it is deliberately not
 *             folded into any of the others. It is not `operator`: no privileged
 *             role supplies it — `primes_treasury.tolk` has no owner, no admin
 *             opcode and no key, and the address travels through a proposal that
 *             opened, ran a 1-day vote of LP holders and closed with more yes
 *             than no. It is not `player` either: the payee is not the
 *             counterparty of the message being handled, and the executor who
 *             pushes the send is anybody at all. §8's claim survives the
 *             distinction intact — "no ADMIN withdraw path" is a statement about
 *             what a privileged role can do alone, and this is the one path in
 *             the protocol that moves money to an arbitrary address *because*
 *             nobody can do it alone.
 */
const CLASSES = {
    peer: [
        'cfg.ledgerAddr',
        'storage.ledgerAddr',
        'storage.cfg.load().ledgerAddr',
        'd.marketAddr',
        'cfg.registrarAddr',
        'bCfg.registrarAddr',
        'ratchetAddr',
        'b.ratchetAddr',
        'configA.jettonMasterAddr',
        'storage.jettonMaster',
        'configA.collectionAddr',
        'dCfg.bountyVaultAddr',
        'storage.vaultAddr',
        'b.jettonWalletAddr',
        'walletAddr',
        'itemAddress(configA, msg.p)',
        'itemAddress(configA, credit.p)',
        // LOW-3: a flushed prime's stamp, forwarded to its own item as the claim would.
        'itemAddress(configA, msg.n)',
        'itemAddressWith(configA, itemDefault, referralKey)',
        'itemAddressWith(configA, itemDefault, f.primeNumber)',
        // D-117: the same tribute credit, paid from the escrow on confirmation.
        'itemAddressWith(configA, itemDefault, p)',
        // D-100 point 6: `feeDests.treasuryAddr` is the GOVERNED TREASURY
        // CONTRACT, not the team's wallet, and that is why it sits here and not
        // in `operator`. The name is old and the meaning changed underneath it:
        // before D-100 `treasuryAddr` was a bare wallet the team held the key
        // to, so the treasury's forfeit share would have been an operator send. The
        // treasury contract has no owner field, no admin opcode, no upgrade and
        // no pause (D-100 point 7) — money arriving there is still inside the
        // protocol and the receiving contract's own rules still apply, which is
        // exactly this class's definition. Calling it `operator` would make §8's
        // headline count read WORSE than the truth, and an audit surface that
        // overstates is as wrong as one that understates.
        'feeDests.treasuryAddr',
        // D-100 point 4: the treasury's deterministic per-owner child, derived
        // from `owner + treasury address` — the same shape as `itemAddress(...)`
        // above and classified the same way.
        'positionAddress(cfg, owner)',
        // The same child, addressed inline by `WithdrawLp`'s bounceable confirm (B43).
        'positionAddress(cfg, msg.owner)',
        // A helper parameter, like `walletAddr` and `ratchetAddr` above and
        // unlike the generic `dest` below: the name says which peer it is, and
        // `primes_lp_position.tolk` has exactly one expression that fills it
        // (`storage.treasuryAddr`, written at deploy into the data that decides
        // this contract's own address). `NoAdminWithdraw.spec.ts` asserts that
        // caller list rather than trusting the name.
        'treasuryAddr',
        // D-168: the stake child's parent (`storage.stakeAddr`, deploy data that
        // decides the child's own address — the `treasuryAddr` shape above), and
        // the treasury's OWN PRIMES wallet, through which `distribute()` pays the
        // stake master — the recipient is deploy data, never a message field.
        'storage.stakeAddr',
        'w.primesJettonWallet',
        // D-188 point 6 — the per-number relays. `cfg.collectionAddr` is the
        // registrar's one-shot genesis link to the main collection (a paid prime
        // annotation goes there); `itemAddr` is item(n) derived by the collection
        // from `n` alone. Both carry only the triggering message's own value.
        'cfg.collectionAddr',
        'itemAddr',
        // D-212: an item's naming fee goes to its own collection (`storage.collectionAddr`,
        // init data that decides the item's address), which forwards it to the ledger.
        'storage.collectionAddr',
        // D-191 point 2 — the claim receipt and its voucher. The receipt's parent
        // (`storage.voucherAddr`) is deploy data that decides the receipt's own
        // address; the voucher reaches a receipt only by re-deriving it from the
        // claimant. Both carry only the triggering message's own value.
        'storage.voucherAddr',
        'receiptAddress(storage.receiptCode, beneficiary)',
    ],
    player: [
        'in.senderAddress',
        'senderAddress',
        'storage.owner',
        'msg.to',
        // TEP-62 transfer: both destinations are named by the CURRENT OWNER in
        // the message they signed, and both are paid only out of the value that
        // same message attached (the item reserves its own pre-message balance).
        'msg.newOwner',
        'respondTo',
        // D-106: `forward_to_owner` sends STRAIGHT to `m.owner` now. It used to
        // assign a local `dest` (classified 'via-helper' and resolved by hand in
        // NoAdminWithdraw.spec.ts) because an UNCLAIMED number's owner was the
        // collection placeholder and the commission was redirected to the
        // Patron. With patron mode deleted no item is ever ownerless, so the
        // branch is gone and the destination is the owner, inline.
        'm.owner',
        // D-202: §4.1's invite line. Each address is named by the MINTER in the mint
        // message they signed, and each transfer is paid out of that same mint's 1 GRAM
        // (it is deducted from β, never from a resting balance). A self-send gets the
        // minter their own 0.1 back, which the owner accepted in writing.
        'invitee',
        // D-146: the ratchet's `returnCallerChange` — the sender of the leg that is
        // running (`in.senderAddress`, passed as a helper parameter), paid only the
        // value above the reserved pre-message balance, i.e. its own change.
        'caller',
        // 2026-11-23: the ratchet's `refundExitPrepay` — the `unstake` caller written
        // into the exit's refund row, paid only that exit's unspent prepay and the
        // answering leg's change, and never above the balance over `pending`.
        'row.to!',
        // D-191 point 2: a claim receipt refunds a replay's (or a refused claim's)
        // leftover to the claimant written into its own init data — the wallet that
        // attached that value.
        'storage.claimant',
        // D-191 point 1: a minter card passes a refused mint's GRAM back to the
        // PAYER — the wallet that sent that mint to the card. `msg.payer` arrives
        // in the ledger's `card_mint_refunded` (sender-checked), echoing the payer
        // the card itself attached; `payer` is read off the card's own bounced
        // `card_mint`. Either way it is the value's own sender, paid only that value.
        'msg.payer',
        'payer',
    ],
    // D-100 point 6 re-points §4.1's 5% line and the forfeit remainder onto
    // `feeDests.operatorAddr`. `configA.treasuryAddr` / `cfg.treasuryAddr` are
    // kept listed because a contract may still carry the old field name; if one
    // of them ever appears again it is an operator send and must be counted.
    // D-128 adds `aux.royaltyDest` on the two royalty-bearing collections. It is an
    // operator address and is classified as one, deliberately and without argument:
    // the point of the class is that §8's question gets asked about every such send,
    // and `NoAdminWithdraw.spec.ts` asks it — a royalty leg is triggered only by an
    // INBOUND transfer, pays a fixed fraction OF THAT TRANSFER, and cannot reach
    // anything already resting on the balance (the storage floor is reserved first).
    // That is what makes it a fee rather than a withdrawal, and it is asserted there
    // rather than assumed here.
    // D-117 (owner, 2026-09-22) deleted `d.opsAddr`: `sweep_ops` now pays the
    // ratchet pool through `forwardToRatchet`, a peer send.
    operator: ['configA.treasuryAddr', 'cfg.treasuryAddr', 'feeDests.operatorAddr',
               'aux.royaltyDest'],
    // §4.3.2 / D-151. The Tonstakers pool is a venue in exactly the sense the
    // DeDust vault is: an EXTERNAL address, not settable by any sender, changeable
    // only through the venue timelock's 30-day queue, and reached by a message
    // whose amount the contract computes and no caller names. `deposit#47d54391`
    // carries no amount field at all — the deposit is the message value, sized from
    // `reserveTarget` — so there is no field here for a caller to aim.
    //
    // Leg 2's DeDust swap and `harvest()`'s treasury transfer do not appear as
    // their own rows: both go out through `sendTstonTransfer`, whose destination is
    // this contract's OWN tsTON wallet (classified `peer`), with the real
    // destination inside a TEP-74 `transfer` body. That is the same shape the
    // §4.3 proceeds burn already has.
    venue: ['venue.dedustNativeVault', 'vs.tonstakersPool'],
    // D-100 point 8. See the class doc above for why this is neither `operator`
    // nor `player`.
    governed: ['prop.dest'],
    // A helper that RETURNS an `AutoDeployAddress` rather than one written
    // inline, so the `startsWith` check below cannot see it.
    deploy: ['positionStateInit(cfg, msg.sender)', 'receiptStateInit(storage.receiptCode, in.senderAddress)',
             // D-191 point 1: the ledger's credit to a wallet's minter card (recruit
             // edge: the payer's; prime sale: the beneficiary's), deploy-if-absent.
             'cardStateInit(configA.cardCode, payer)', 'cardStateInit(configA.cardCode, beneficiary)',
             // D-196: the ledger's lot blocks, deploy-if-absent — a claim forwarding the
             // opener's gas, the import request, and a far prime's sold mark. A lot block
             // holds no player money and pays only the ledger back.
             'lotBlockStateInit(loadConfigA(storage).lotBlockCode, block)',
             'lotBlockStateInit(configA.lotBlockCode, primeBlock)'],
    'via-helper': ['dest'],
};

const classOf = (expr) => {
    for (const [name, list] of Object.entries(CLASSES)) if (list.includes(expr)) return name;
    return 'UNCLASSIFIED';
};

/** Grab the balanced `{...}` that follows index `i` (which points at the `{`). */
function balanced(src, i) {
    let depth = 0;
    for (let j = i; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') {
            depth--;
            if (depth === 0) return src.slice(i, j + 1);
        }
    }
    return src.slice(i);
}

/** The `fun NAME(` most recently opened before `idx`, and the nearest `Arm =>` above it. */
function contextAt(src, idx) {
    const before = src.slice(0, idx);
    const funs = [...before.matchAll(/\bfun\s+([A-Za-z0-9_]+)\s*\(/g)];
    const arms = [...before.matchAll(/^\s{8}([A-Z][A-Za-z0-9_]*)\s*=>/gm)];
    return {
        fn: funs.length ? funs[funs.length - 1][1] : '(top level)',
        arm: arms.length ? arms[arms.length - 1][1] : '',
    };
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

const rows = [];
for (const file of readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.tolk')).sort()) {
    const src = readFileSync(join(CONTRACTS_DIR, file), 'utf8');
    for (const m of src.matchAll(/createMessage\s*\(\s*\{/g)) {
        const open = src.indexOf('{', m.index + 'createMessage'.length);
        const body = balanced(src, open);
        // strip line comments so a commented-out `dest:` cannot be picked up
        const clean = body.replace(/\/\/[^\n]*/g, '');
        const dest = clean.match(/\bdest\s*:\s*([\s\S]*?),\s*\n/);
        const value = clean.match(/\bvalue\s*:\s*([\s\S]*?),\s*\n/);
        const mode = src.slice(open + body.length, open + body.length + 80).match(/\.send\(([A-Z_0-9]+)\)/);
        const destExpr = dest ? oneLine(dest[1]) : '(none)';
        const isDeploy = destExpr.startsWith('AutoDeployAddress');
        const { fn, arm } = contextAt(src, m.index);
        rows.push({
            file: basename(file),
            line: src.slice(0, m.index).split('\n').length,
            fn,
            // The arm is only meaningful when the send is lexically INSIDE the
            // message handler. A standalone `fun` defined below the match block
            // would otherwise be labelled with whatever arm happened to precede
            // it in the file, which reads as a claim about reachability that
            // this lexical pass has not earned.
            arm: fn === 'onInternalMessage' ? arm : '',
            dest: isDeploy ? 'AutoDeployAddress { ... }' : destExpr,
            value: value ? oneLine(value[1]) : '(none)',
            mode: mode ? mode[1] : '(unknown)',
            cls: isDeploy ? 'deploy' : classOf(destExpr),
        });
    }
}

const counts = {};
for (const r of rows) counts[r.cls] = (counts[r.cls] ?? 0) + 1;

const esc = (s) => s.replace(/\|/g, '\\|');
let md = `# Outbound message surface — where GRAM can leave a contract

<!-- GENERATED by tools/withdraw-surface.mjs. Do not edit by hand. -->

CONCEPT.md §8: **no admin withdraw path on any GRAM balance, not timelocked, not
multisig.** GRAM only leaves a contract through an outbound message, so the set of
\`createMessage\` sites is the set of ways money can move. This is all of them, across
all ${readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.tolk')).length} contracts,
classified by who the destination is.

\`NoAdminWithdraw.spec.ts\` asserts this table's shape: every destination must fall in a
known class, and the \`operator\` class — the only one §8 is about — must be exactly the
sites listed below, each paying a formula-fixed amount. A new send to an unrecognised
destination fails that spec rather than being assumed benign.

**§8 is a claim about moving GRAM, and that is narrower than "no privileged keys".** Three
standing credentials do exist — the venue timelock's proposer and two signing keys — none
of which can move a GRAM balance. They are listed, with what each can and cannot do, in
[privileged-credentials.md](privileged-credentials.md), kept honest by
\`PrivilegedCredentials.spec.ts\`. **That page also carries the governance disclosure**
(\`GAUNTLET.md\` X5): who controls this money in year three is the treasury's electorate, a
vote is a simple majority with **no quorum**, and what bounds it is what the treasury cannot
reach — not \`T\`, \`S\`, \`pending\`, \`owed\`, \`k\`, \`K_CEIL\` or the split.

**Totals:** ${Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v}`)
        .join(' · ')} — ${rows.length} sites.

| contract | line | handler | destination | class | value |
|---|---|---|---|---|---|
`;
for (const r of rows) {
    md += `| \`${r.file}\` | ${r.line} | ${esc(r.arm ? `${r.arm} → ${r.fn}` : r.fn)} | \`${esc(r.dest)}\` | ${r.cls} | \`${esc(r.value)}\` |\n`;
}
md += `
## Reading the classes

- **peer** — another protocol contract, at a deploy-fixed or derived address. Money here
  has not left the protocol; the receiving contract's rules still apply and its own sends
  appear in this same table.
- **player** — the counterparty of the message being handled: whoever sent it, whoever owns
  the item, whoever is owed a refund. Never an address an operator chooses.
- **operator** — an address the team controls. The whole of §8's question lives here.
- **deploy** — a state-init deploy of a child contract.
- **venue** — the DeDust vault, fixed through the venue timelock rather than settable at
  will.
- **governed** — an address a **passed proposal** named (D-100 point 8). \`primes_treasury.tolk\`
  has no owner, no admin opcode, no key and no pause; a transfer leaves it only after a
  proposal opened, ran a 1-day vote of LP holders in the ≥ 30-day tiers, closed with more
  yes than no, and was pushed by a permissionless \`Execute\`. That is not an admin withdraw
  path — it is the opposite shape: money moves to an arbitrary address precisely *because*
  no single role can move it. Kept as its own class rather than folded into \`operator\`
  (which would overstate §8's count) or \`player\` (which would understate what it is).
- **via-helper** — the destination is a helper's parameter; resolved at the call sites,
  which the spec enumerates by hand.
`;

const inSync = emitPage(OUT, md, 'withdraw-surface.mjs');
console.log(`${rows.length} outbound sites ${isCheckMode() ? '' : ` -> ${OUT}`}`);
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
const bad = rows.filter((r) => r.cls === 'UNCLASSIFIED');
if (bad.length) {
    console.log('\nUNCLASSIFIED destinations:');
    for (const r of bad) console.log(`  ${r.file}:${r.line} ${r.dest}`);
}

// GAUNTLET.md B35 — the exit code is the gate's answer; the summaries above
// print either way, so a drift run still tells the reader WHAT it measured.
if (!inSync) process.exit(1);
