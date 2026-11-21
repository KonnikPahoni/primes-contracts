#!/usr/bin/env node
// Regenerates docs/audit/sender-gates.md — every message arm on every contract,
// with the mechanism that authorises its caller, or the fact that it has none.
//
// WHY THIS EXISTS (GAUNTLET.md D1, CONCEPT.md §8)
//
// "Unauthorised sender on every message arm" is the first thing an adversarial
// pass checks and the easiest to cover unevenly: the suites test the arms
// someone thought to test, and an arm added later inherits no coverage at all.
// D1 asks for a TABLE rather than per-contract prose, and this is the table.
//
// The claim it supports is narrow and worth stating precisely: **every arm is
// either caller-authorised by some mechanism, or deliberately permissionless.**
// There is no third category, and an arm in neither is a finding rather than a
// default. Deliberately-permissionless is a real and necessary class here —
// `flush`, `sweep_ops`, `sync_head`, `open_head_lot` and `bid` are open BY
// DESIGN (§4.3.1, §4.1, §4.4), and CONCEPT.md leans on it: a keeper-free
// protocol is one where anyone can push the crank. So the table cannot simply
// demand a gate everywhere; it has to record which arms are open on purpose.
//
// FOUR MECHANISMS, NOT ONE. The first draft of this generator looked only for
// `senderAddress ==` and reported 35 open arms. Reading them showed the detector
// was wrong about four of them and wrong in four different ways, each of which
// is a real gate:
//
//   compare    `in.senderAddress == cfg.ledgerAddr` — the common case. Note the
//              comparison also appears REVERSED (`look.loadValue() ==
//              in.senderAddress`, registrar's TransferTrophy), which a
//              left-hand-side-only regex silently reports as an open door.
//   key        the sender IS the dictionary key for the caller's own record.
//              `Unstake` reaches your position and nobody else's via
//              `addrKey(in.senderAddress)`; `PayProgramBounty` reaches its
//              allow-list entry via `senderAddress.getWorkchainAndHash()`. Not a
//              weaker gate — there is no other row the caller can name.
//   signature  a cryptographic gate, deliberately sender-agnostic. The voucher's
//              `BurnSigner` verifies against `storage.signerPubkey`; who relays
//              the message is irrelevant by design.
//
// The throw code is NOT part of the test. `throw 100` (wrong_sender) is the
// common case, but `throw 300` (item_not_owner), `throw 800`
// (timelock_not_proposer), `throw 401` (jetton_not_minter) and `throw 915`
// (reg_not_namer) are all sender gates, and keying on 100 alone would reclassify
// several real gates as open doors.
//
// WHAT IT DOES NOT DO. Lexical, not semantic. It does not prove the address
// compared against is the RIGHT one — that is what the per-contract suites and
// `FuzzInvariants`' corpus are for — and it follows only one level of `handleX`
// delegation. Its job is to make the set countable and to fail loudly when an
// arm appears that nobody classified.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { emitPage, isCheckMode } from './lib/audit-page.mjs';
import { join, basename } from 'node:path';

const CONTRACTS_DIR = join(process.cwd(), 'contracts', 'contracts');
const OUT = join(process.cwd(), 'docs', 'audit', 'sender-gates.md');

const SENDER = String.raw`(?:in\.)?senderAddress`;
/** Either side of the comparison — see the TransferTrophy note above. */
const CMP = new RegExp(`${SENDER}\\s*(?:==|!=)|(?:==|!=)\\s*${SENDER}`);
/** The sender used as a dictionary key, reaching only the caller's own record. */
const KEY = new RegExp(`addrKey\\s*\\(\\s*${SENDER}|${SENDER}\\.getWorkchainAndHash`);
/** A cryptographic gate, deliberately sender-agnostic. */
const SIGNATURE = /isSignatureValid\s*\(/;

const MECHANISMS = [
    ['compare', CMP],
    ['key', KEY],
    ['signature', SIGNATURE],
];

const LABEL = {
    compare: 'compares sender',
    key: 'sender IS the key',
    signature: 'signature',
};

/** Grab the balanced `{...}` starting at `i` (which points at the `{`). */
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

/** The body of `fun NAME(...) { ... }`, or '' if there is no such function. */
function funBody(src, name) {
    const m = src.match(new RegExp(`\\bfun\\s+${name}\\s*\\(`));
    if (!m) return '';
    const open = src.indexOf('{', m.index);
    return open < 0 ? '' : balanced(src, open);
}

/**
 * Arms whose lexical match is REAL but does not gate the arm.
 *
 * `Mint` is the only one. D-101 put an operator signature over the invite list
 * inside `handleMint`, and the scan below follows `handle*` calls — so the
 * heuristic reads a signature gate on an arm that is, and must remain, open to
 * everyone (§4: anyone may mint the head; that is the game). The signature
 * gates ONE OPTIONAL FIELD of the body, not the sender and not the mint: a mint
 * with `invite_count == 0` never reaches `isSignatureValid` at all. Recording
 * it as `signature` would overstate the authorised count, and an audit surface
 * that overstates is as wrong as one that understates.
 */
const NOT_A_SENDER_GATE = new Set(['primes_ledger.tolk::Mint']);

const mechanismIn = (text) => {
    for (const [name, re] of MECHANISMS) if (re.test(text)) return name;
    return '';
};

const rows = [];
for (const file of readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.tolk')).sort()) {
    const src = readFileSync(join(CONTRACTS_DIR, file), 'utf8');
    for (const m of src.matchAll(/^ {8}([A-Z][A-Za-z0-9_]*)\s*=>/gm)) {
        const arm = m[1];
        const open = src.indexOf('{', m.index);
        const body = open >= 0 ? balanced(src, open) : '';
        const clean = body.replace(/\/\/[^\n]*/g, '');

        let kind = mechanismIn(clean);
        let via = kind ? 'inline' : '';
        if (!kind) {
            for (const call of clean.matchAll(/\b(handle[A-Za-z0-9_]+)\s*\(/g)) {
                const inner = funBody(src, call[1]).replace(/\/\/[^\n]*/g, '');
                const k = mechanismIn(inner);
                if (k) {
                    kind = k;
                    via = call[1];
                    break;
                }
            }
        }
        if (NOT_A_SENDER_GATE.has(`${basename(file)}::${arm}`)) {
            kind = '';
            via = '';
        }
        rows.push({
            file: basename(file),
            line: src.slice(0, m.index).split('\n').length,
            arm,
            kind,
            via,
        });
    }
}

const gated = rows.filter((r) => r.kind);
const openRows = rows.filter((r) => !r.kind);
const byKind = {};
for (const r of gated) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

const md = `# Sender gates — every message arm, and what authorises its caller

<!-- GENERATED by tools/sender-gates.mjs. Do not edit by hand. -->

Every message arm on every contract, with the mechanism that authorises its
caller or the fact that it has none. **Every arm is either caller-authorised or
deliberately permissionless** — there is no third category, and an arm in
neither is a finding. \`SenderGates.spec.ts\` asserts that, and enumerates the
permissionless set by name, so an arm arriving there by accident fails the build
rather than being assumed intentional.

**Three mechanisms count as authorisation**, because three are in use:

- **compares sender** — \`in.senderAddress == cfg.ledgerAddr\` and friends. Also
  appears reversed (\`look.loadValue() == in.senderAddress\`), which a
  left-hand-side-only check reports as an open door.
- **sender IS the key** — the sender is the dictionary key for the caller's own
  record, so the caller cannot name anyone else's. Not a weaker gate.
- **signature** — a cryptographic gate, deliberately sender-agnostic.

The throw code is not part of the test: \`throw 100\` is the common case, but
\`300\`, \`401\`, \`800\` and \`915\` are all sender gates too.

**Totals:** ${rows.length} arms · ${gated.length} authorised (${Object.entries(byKind)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${LABEL[k]} ${v}`)
    .join(', ')}) · ${openRows.length} permissionless.

## Authorised arms

| contract | line | arm | mechanism | where |
|---|---|---|---|---|
${gated
    .map(
        (r) =>
            `| \`${r.file}\` | ${r.line} | \`${r.arm}\` | ${LABEL[r.kind]} | ${r.via === 'inline' ? 'inline' : `via \`${r.via}\``} |`
    )
    .join('\n')}

## Permissionless arms

No caller authorisation, by design. The spec enumerates this set by name.

| contract | line | arm |
|---|---|---|
${openRows.map((r) => `| \`${r.file}\` | ${r.line} | \`${r.arm}\` |`).join('\n')}

## Limits

Lexical, not semantic. This does not prove the address compared against is the
RIGHT one, and it follows only one level of \`handleX\` delegation. Its job is to
make the set countable and to fail loudly when an arm appears that nobody
classified.
`;

const inSync = emitPage(OUT, md, 'sender-gates.mjs');
console.log(`${rows.length} arms (${gated.length} authorised, ${openRows.length} permissionless) ${isCheckMode() ? '' : ` -> ${OUT}`}`);
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v}`);
console.log('permissionless:');
for (const r of openRows) console.log(`  ${r.file}:${r.line} ${r.arm}`);

// GAUNTLET.md B35 — the exit code is the gate's answer; the summaries above
// print either way, so a drift run still tells the reader WHAT it measured.
if (!inSync) process.exit(1);
