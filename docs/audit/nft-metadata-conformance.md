# NFT metadata — TEP-64 conformance pass

GAUNTLET.md Track L, item **L5**. Hand-audited (no generator script; the surface is one
function) at commit `HEAD` on 2026-08-30, against `backend/read-proxy/src/nftMetadata.ts`'s
`buildItemMetadata` and `shared/art/traits.ts`'s `traitAttributes`, the two places that
compose the `attributes` array served at `GET /nft/<n>.json`.

## Base TEP-64 fields

TEP-64 itself defines only five item fields — `uri`, `name`, `description`, `image`,
`image_data` — and leaves `attributes` as an open question, not a standard. This document
already ships the Getgems de-facto extension (`attributes`, `lottie`, `content_url` +
`content_type`, `buttons`), documented in `nftMetadata.ts`'s own header and in CONCEPT.md
§9.8. `name`/`description`/`image` are present and correct on every path; `image` stands
alone (a TEP-64-only wallet sees a finished picture, no missing context) — confirmed by
`backend/read-proxy/test/nft.test.ts`'s "carries every field TEP-64 requires of an item".

## `attributes` — the audit

Every entry uses the correct `trait_type`/`value` keys (Getgems/OpenSea convention); no
naming drift found. The array, in emission order:

| trait_type | value type | conformance before this pass |
| --- | --- | --- |
| Class | string | correct — no `display_type` |
| Digits | number | **missing `display_type: "number"`** |
| Forms (prime) | string | correct |
| Form count (prime) | number | **missing `display_type: "number"`** |
| Rarity (bits) (prime) | number | **missing `display_type: "number"`** |
| Distinct prime factors (composite) | number | **missing `display_type: "number"`** |
| Prime factors with multiplicity (composite) | number | **missing `display_type: "number"`** |
| Factorization (composite) | string | correct |
| Archetype | string | correct |
| Palette | string | correct |
| Hero trait | string | correct |
| Era | number | **missing `display_type: "number"`** |
| Symmetry | number | **missing `display_type: "number"`** |
| Bodies | number | **missing `display_type: "number"`** |
| Art version | number | **missing `display_type: "number"`** |
| Lattice (conditional) | string | correct |

**Finding, fixed in this pass.** No numeric attribute carried `display_type`, so an
OpenSea/Getgems/Telegram-style renderer would show every one of the nine numeric traits
above as a generic text pill instead of a numeric stat (sortable/filterable range, not a
free-text match). Fixed by adding `display_type: "number"` to every attribute whose
`value` is a `number` and leaving every string-valued attribute untouched. Additive-only:
no `trait_type` or `value` changed, so nothing that already reads this document by
`trait_type` breaks. `ART_VERSION` (`shared/art/traits.ts:38`, currently `2`) is
untouched, per L5's own completion bar — this is a metadata-shape pass, not a repaint.

**Checked and found correct as designed, not a gap.** §9.8 says a buyer "wants era,
class, rarity and date without opening the metadata," and the mint date is visibly
absent from `attributes` (it is drawn on the raster overlay via `Traits.mintedDay`,
`shared/art/traits.ts:165,358`, but never pushed into `attributes`). This is not a
conformance gap: `nftMetadata.ts`'s own header states the whole document is a pure
function of `n`, zero chain reads, identical for every caller forever — precisely so a
marketplace can cache it arbitrarily hard (`ops/rate-limit-budget.md`'s constraint on an
unbounded-cardinality route). Mint date does not exist until the mint happens, so it
cannot live in a document that must be renderable and cacheable before mint (the same
"pre-mint base layer, live layers around it" split L4 documents for the lineage card).
Surfacing mint date as a filterable attribute would mean either a per-item cache
invalidation on mint (breaking the "cache forever" property this route is built around)
or a stale `attributes` entry cached before the mint happened — worse than the current
honest omission. §9.8's "without opening the metadata" is satisfied by the raster
overlay and by `/number/:n`'s live envelope, not by this specific document; no code
change, filed here as a closed question rather than a bug.

## Test coverage

`backend/read-proxy/test/nft.test.ts` already spot-checked `Class`/`Factorization`/
`Distinct prime factors`/`Prime factors with multiplicity` values and the required
TEP-64 keys, but no test pinned the `display_type` convention. Added
`"marks every bare-numeric attribute with display_type: \"number\" (GAUNTLET.md L5)"` —
a type-driven assertion (every `number`-valued attribute must carry `display_type:
"number"`, every string-valued one must not) that fails on regression regardless of
which trait a future change adds or removes, rather than re-enumerating the table above
by hand.

## Scope discipline

No opcode, get-method, contract, wire-format or economic-parameter changed. `attributes`
values, `name`, `description`, `image` and every other field are byte-identical to
before this pass except for the added `display_type` keys — a marketplace that already
parses `trait_type`/`value` sees no change; one that reads `display_type` (which none of
today's fixtures did before this pass, confirmed by the additive-only test above) now
renders the numeric traits as numeric.
