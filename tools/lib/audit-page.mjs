// The write-or-check half of a generated audit page (GAUNTLET.md B35).
//
// `docs/audit/*.md` are MEASUREMENTS of the tree, regenerated rather than hand-edited,
// and a page that has silently stopped describing the tree is worse than no page: it
// reports confidence the repo has not earned. Two of the six generators had a `--check`
// mode and four did not, so those four were caught only by their own jest specs' "the
// generated table is current" cases — real coverage, but four minutes into
// `test:contracts` instead of seven seconds into `gate:checks`. B35's evidence: B27
// shifted `primes_treasury.tolk`'s line numbers and `withdraw-surface.md` stayed stale
// for two iterations.
//
// One implementation rather than six, for the reason B29 records: the same fifteen lines
// copied into six files is six chances for the CRLF normalisation below to be got wrong
// in one of them, and `comparable` is exactly the part that is easy to get wrong.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Compare on CONTENT, not on provenance.
 *
 * Every regeneration stamps the current commit and date into the page header, so a byte
 * comparison would report drift on every commit whatever the code did — and a `--check`
 * that cries wolf is a `--check` nobody runs. CRLF is normalised because these pages are
 * LF-generated and a Windows checkout can hold them either way.
 */
export const comparable = (text) =>
    text
        .replace(/\r\n/g, '\n')
        .replace(/commit `[0-9a-f]+` \(\d{4}-\d{2}-\d{2}\)/g, 'commit <stamp>');

/**
 * Read a SOURCE file the generators measure, as LF. A Windows checkout holds a mix of CRLF
 * and LF files, and regexes written against `\n` (`'\n}\n'` closing a builder, `.` stopping
 * at `\r`, …) then miss rows without any error — the page just says less on the laptop than
 * on the box. Normalising once at the read ends the class instead of auditing every regex.
 */
export const readText = (path) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

/** True when `--check` (or `--dry-run`) is on this process's argv. */
export const isCheckMode = (argv = process.argv) =>
    argv.includes('--check') || argv.includes('--dry-run');

/**
 * Write `text` to `out`, or in check mode compare and report.
 *
 * Returns true when the page is IN SYNC, false when it drifted — the caller decides the
 * exit code, because a generator that measures several pages wants to report all of them
 * before failing rather than stopping at the first.
 *
 * A failure here is not always a stale file. These pages measure claims (§8's no-admin
 * withdraw surface, §9.1's stat provenance, the sender-gate matrix), so a row that
 * DISAPPEARED is the claim breaking, not the page rotting. Read the diff before
 * regenerating.
 */
export function emitPage(out, text, generator, { check = isCheckMode() } = {}) {
    if (!check) {
        writeFileSync(out, text);
        return true;
    }
    const current = existsSync(out) ? readFileSync(out, 'utf8') : '';
    if (comparable(current) === comparable(text)) return true;
    console.error(
        `drift: ${out} no longer describes the tree — run \`node tools/${generator}\` ` +
            'and READ THE DIFF before committing it.'
    );
    return false;
}
