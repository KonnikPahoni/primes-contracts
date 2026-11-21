#!/usr/bin/env node
// Regenerates docs/audit/bounce-coverage.md — every outbound message, its bounce
// mode, and whether the sender handles it coming back.
//
// WHY (GAUNTLET.md D7, CONCEPT.md §12)
//
// TON delivers no failure synchronously. A send that the destination refuses —
// wrong opcode, out of gas, uninitialised, throwing — comes back as a BOUNCE, a
// separate inbound message arriving later at the sender. So every outbound
// message has a second code path, and the question D7 asks is whether that path
// exists and what it does.
//
// The two modes make opposite promises and both are used deliberately here:
//
//   RichBounce  the message CAN come back, carrying enough of the original body
//               to identify it. The sender must handle it, or the effect is
//               silently half-applied: state advanced on the way out, never
//               reversed on the way back.
//
//   NoBounce    the message CANNOT come back. Value credited to an
//               uninitialised address simply accumulates as its balance rather
//               than vanishing, which is exactly what you want for a payment to
//               a wallet that may not exist yet (a dormant patron, a treasury,
//               an item's owner). Choosing NoBounce is a statement that there is
//               nothing to reverse.
//
// So the table has two failure classes, not one: a RichBounce whose opcode the
// sender does not handle, and a NoBounce that is carrying state the sender WOULD
// need to reverse. The first is mechanical to detect and this generator detects it.
// The second is a judgement call, and `BounceCoverage.spec.ts` enumerates the
// NoBounce sends that move real value so each is a decision on the record.
//
// KNOWN GAPS, ALREADY ESCALATED — this generator does not re-litigate them, and the
// spec asserts they are still the only ones: D-51 (a bounced `MintItem` leaves
// the registrar's naming rights and prime rank wrong), D-52 (a bounced rebate
// mint is lost and permanently inflates `S`), D-53 (a bounced era/special bounty
// is marked paid but never delivered).
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { emitPage, isCheckMode } from './lib/audit-page.mjs';
import { join, basename } from 'node:path';

const CONTRACTS_DIR = join(process.cwd(), 'contracts', 'contracts');
const OUT = join(process.cwd(), 'docs', 'audit', 'bounce-coverage.md');

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

function fnAt(src, idx) {
    const funs = [...src.slice(0, idx).matchAll(/\bfun\s+([A-Za-z0-9_]+)\s*\(/g)];
    return funs.length ? funs[funs.length - 1][1] : '(top level)';
}

/** The struct name a body is built from: `(CreditTribute { ... }).toCell()`. */
function bodyName(text) {
    const m = text.match(/body:\s*\(\s*([A-Za-z0-9_]+)\s*\{/);
    if (m) return m[1];
    if (/body:\s*beginCell\(\)\s*\.endCell\(\)/.test(text)) return '(empty)';
    if (/body:\s*beginCell\(\)/.test(text)) return '(inline)';
    return '(unknown)';
}

const RESPONSE_NAME = /^(response|respond)/i;

/**
 * Every place `src` writes its OWN address where a standard reply will be sent:
 *   - a field named `response*`/`respond*` set to `contract.getAddress()`;
 *   - `.storeAddress(contract.getAddress())` with `response_destination` in its comment;
 *   - `contract.getAddress()` passed as an argument whose parameter, in this file's own
 *     `fun` declaration, is named `response*`/`respond*` (the vault's `payOut`, the
 *     treasury's `sendJetton`).
 * And the name of the arm that answers the reply, or null.
 */
function selfResponseSites(src, file) {
    const excesses = src.match(/struct\s*\(\s*0xd53276db\s*\)\s*([A-Za-z0-9_]+)/i)?.[1];
    const arm = excesses && new RegExp(`^\\s*${excesses}\\s*=>`, 'm').test(src) ? excesses : null;
    // Comments blanked to spaces, length kept, so indices still line up with `src`
    // and a comma inside a comment cannot miscount an argument position.
    const code = src.replace(/\/\/[^\n]*/g, (c) => ' '.repeat(c.length));
    const sites = [];
    for (const m of code.matchAll(/contract\.getAddress\(\)/g)) {
        const i = m.index;
        const lineStart = src.lastIndexOf('\n', i) + 1;
        const lineEnd = src.indexOf('\n', i);
        const line = src.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
        const before = code.slice(lineStart, i);
        let via = null;
        const field = before.match(/([A-Za-z_][A-Za-z0-9_]*)\s*:\s*$/)?.[1];
        if (field && RESPONSE_NAME.test(field)) via = `${field}:`;
        else if (/storeAddress\(\s*$/.test(before) && /response_destination/.test(line)) {
            via = '.storeAddress (response_destination)';
        } else {
            // Walk back to the unmatched `(` that opens the enclosing call, counting
            // top-level commas to learn which argument this is.
            let depth = 0, commas = 0, j = i - 1;
            for (; j >= 0; j--) {
                const ch = code[j];
                if (ch === ')') depth++;
                else if (ch === '(') { if (depth === 0) break; depth--; }
                else if (ch === ',' && depth === 0) commas++;
                else if (ch === '{' || ch === ';') { j = -1; break; }
            }
            const callee = j > 0 ? code.slice(0, j).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)?.[1] : null;
            const decl = callee && code.match(new RegExp(`\\bfun\\s+${callee}\\s*\\(([^)]*)\\)`));
            const param = decl?.[1].split(',')[commas]?.split(':')[0].trim();
            if (param && RESPONSE_NAME.test(param)) via = `${callee}(… ${param} …)`;
        }
        if (via) sites.push({ file, line: src.slice(0, i).split('\n').length, via, arm });
    }
    return sites;
}

const rows = [];
/** GAUNTLET.md G56 — self-named response fields, and whether the reply has an arm. */
const selfResponse = [];
/** Per contract: which opcodes its own onBouncedMessage inspects. */
const handled = {};

for (const file of readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.tolk')).sort()) {
    const src = readFileSync(join(CONTRACTS_DIR, file), 'utf8');
    const name = basename(file);

    // What the bounce handler recognises. Both literal opcodes and named
    // constants count — `DEDUST_SWAP_OP` is as much a handled case as 0xb0000030.
    const bounceIdx = src.indexOf('fun onBouncedMessage');
    const bounceBody = bounceIdx >= 0 ? balanced(src, src.indexOf('{', bounceIdx)) : '';
    const opcodes = [
        ...bounceBody.matchAll(/opcode\s*==\s*(0x[0-9a-fA-F]+|[A-Z_][A-Z0-9_]*)/g),
    ].map((m) => m[1]);
    // A handler that inspects NO opcode is not thereby a gap: a contract that
    // sends only one kind of bounceable message has nothing to dispatch on, and
    // several here do real reversal work without a single `opcode ==`. What
    // distinguishes a gap is an EMPTY body — code stripped of comments leaving
    // nothing behind. So the kind, not the opcode count, is what gets recorded.
    const code = bounceBody.replace(/\/\/[^\n]*/g, '').replace(/[\s{}]/g, '');
    handled[name] = {
        opcodes,
        kind: opcodes.length ? `dispatches ${opcodes.length}` : code.length ? 'single-message' : 'empty',
    };

    // GAUNTLET.md G56 — the self-as-responseAddr rule (CLAUDE.md "A contract that names
    // an address in a standard message must handle that message's REPLY"). Every
    // response field in this repo is TEP-74's `response_destination`, so the reply is
    // `excesses#d53276db`; a site whose contract has no `Excesses =>` arm lets the
    // catch-all `throw 101` eat it, which is what B27/B28 and the incidents before
    // them were.
    selfResponse.push(...selfResponseSites(src, name));

    for (const m of src.matchAll(/createMessage\s*\(\s*\{/g)) {
        const open = src.indexOf('{', m.index + 'createMessage'.length);
        const body = balanced(src, open).replace(/\/\/[^\n]*/g, '');
        const mode = body.match(/bounce:\s*BounceMode\.([A-Za-z]+)/)?.[1] ?? '(unset)';
        const value = body.match(/value:\s*([^,\n]+)/)?.[1]?.trim() ?? '(none)';
        rows.push({
            file: name,
            line: src.slice(0, m.index).split('\n').length,
            fn: fnAt(src, m.index),
            mode,
            body: bodyName(body),
            value,
        });
    }
}

const rich = rows.filter((r) => r.mode === 'RichBounce');
const nob = rows.filter((r) => r.mode === 'NoBounce');
const noHandler = rich.filter((r) => handled[r.file].kind === 'empty');

const esc = (s) => s.replace(/\|/g, '\\|');
const md = `# Bounce coverage — every outbound message's failure path

<!-- GENERATED by tools/bounce-coverage.mjs. Do not edit by hand. -->

GAUNTLET.md D7. TON delivers no failure synchronously: a send the destination
refuses comes back as a **bounce**, a separate inbound message arriving later at
the sender. Every outbound message therefore has a second code path.

The two modes make opposite promises, and both are used deliberately:

- **RichBounce** — the message can come back, carrying enough of the original
  body to identify it. The sender must handle it, or the effect is silently
  half-applied: state advanced on the way out, never reversed on the way back.
- **NoBounce** — the message cannot come back. Value credited to an
  uninitialised address accumulates as its balance rather than vanishing, which
  is what a payment to a possibly-dormant wallet wants. Choosing NoBounce is a
  statement that there is nothing to reverse.

So there are two failure classes: a RichBounce whose opcode the sender does not
handle, and a NoBounce carrying state the sender would need to reverse. The first
is mechanical and detected here; the second is a judgement call, enumerated in
\`BounceCoverage.spec.ts\`.

**Totals:** ${rows.length} outbound sends · ${rich.length} RichBounce · ${nob.length} NoBounce · ${
    Object.values(handled).filter((h) => h.kind !== 'empty').length
} contracts whose bounce handler does real work.

## RichBounce sends — these can come back

| contract | line | function | body | value | sender's bounce handler |
|---|---|---|---|---|---|
${rich
    .map(
        (r) =>
            `| \`${r.file}\` | ${r.line} | \`${r.fn}\` | \`${r.body}\` | \`${esc(r.value)}\` | ${
                handled[r.file].kind === 'empty'
                    ? '**empty**'
                    : handled[r.file].kind +
                      (handled[r.file].opcodes.length ? ` (${handled[r.file].opcodes.join(', ')})` : '')
            } |`
    )
    .join('\n')}

## NoBounce sends — these cannot come back

| contract | line | function | body | value |
|---|---|---|---|---|
${nob
    .map((r) => `| \`${r.file}\` | ${r.line} | \`${r.fn}\` | \`${r.body}\` | \`${esc(r.value)}\` |`)
    .join('\n')}

## Self-named response addresses — the reply must have an arm

GAUNTLET.md G56, \`CLAUDE.md\`'s rule: a contract that writes its **own** address into a
standard message's response field will be sent that standard's reply, and the
catch-all \`else => assert (in.body.isEmpty()) throw 101\` eats it unless an arm exists.
The reply is non-bounceable, so the value lands and only the trace goes red. Every
response field here is TEP-74's \`response_destination\`, answered with
\`excesses#d53276db\`. **A row with no arm fails this generator in every mode.**

| contract | line | written via | arm |
|---|---|---|---|
${selfResponse
    .map((r) => `| \`${r.file}\` | ${r.line} | \`${esc(r.via)}\` | ${r.arm ? `\`${r.arm} =>\`` : '**MISSING**'} |`)
    .join('\n')}

## Limits

Lexical. It records which opcodes a bounce handler *inspects*, not whether the
reversal it performs is correct — that is what the per-contract suites and the
three escalated findings (D-51, D-52, D-53) are for. It also cannot tell whether
a NoBounce was the right choice; the spec enumerates the value-bearing ones so
each is a decision on the record rather than a default.
`;

const inSync = emitPage(OUT, md, 'bounce-coverage.mjs');
console.log(`${rows.length} sends (${rich.length} rich, ${nob.length} nobounce) ${isCheckMode() ? '' : ` -> ${OUT}`}`);
if (noHandler.length) {
    console.log('\nRichBounce sent from a contract whose handler inspects NO opcode:');
    for (const r of noHandler) console.log(`  ${r.file}:${r.line} ${r.fn} ${r.body}`);
}

const unanswered = selfResponse.filter((r) => !r.arm);
console.log(`${selfResponse.length} self-named response fields, ${unanswered.length} without an excesses arm`);
for (const r of unanswered) console.error(`  MISSING excesses arm: ${r.file}:${r.line} (${r.via})`);

// GAUNTLET.md B35 — the exit code is the gate's answer; the summaries above
// print either way, so a drift run still tells the reader WHAT it measured.
// G56: an unanswered self-named response field fails it too, in every mode.
if (!inSync || unanswered.length) process.exit(1);
