// TON PRIMES — genesis presentation guards (CONCEPT §3.1).
//
// THE BUG THIS PINS. `genesisPipeline.deployAndWire` constructed both the NFT collection
// and the jetton master WITHOUT passing any content cell, and without passing a royalty
// destination. Every contract-side field, get-method, encoder and standard-named getter
// was already present and correct — `collectionContent`, `commonContentPrefix`,
// `royaltyDest`, `get_collection_data`, `get_nft_content`, `get_jetton_data`,
// `royalty_params` — so nothing failed, nothing threw, and no test went red. The wrappers'
// `?? beginCell().endCell()` defaults simply answered for all of them.
//
// The result would have been a standards-compliant deploy that renders nameless in every
// wallet, explorer and marketplace on TON, with per-item URIs that are bare relative paths
// (`1234.json`, no host) and a 5% secondary royalty pointed at the throwaway genesis
// script wallet instead of the treasury CONCEPT §3.1 names.
//
// None of it is repairable after the fact: all of it lands in INIT DATA, which is part of
// the address preimage, and §8 forbids the admin setter that could change it. The only fix
// is redeploying the entire set at fresh addresses.
//
// So the guards are typed (presentation is a REQUIRED field, not an optional with a
// default), checked before anything is sent (`validatePresentation`), and checked again
// against the live get-methods after deploy (`verifyPresentation`, exercised in
// GenesisRehearsal.spec.ts). This file covers the first and third.
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { beginCell } from '@ton/core';
import { resolvePresentation } from '../scripts/deployGenesis';
import { parseNetworkConfig, type Network } from '../../shared/networkConfig';
import {
    GenesisPresentation,
    MAX_URI_BYTES,
    decodeComposedNftContent,
    validatePresentation,
} from '../scripts/genesisPipeline';
import { decodeOffchainContent, offchainContentCell } from '../wrappers/PrimesJettonMaster';
import { snakeCell } from '../wrappers/PrimesCollection';
import sharedParams from '../../shared/params.json';

const GOOD: GenesisPresentation = {
    collectionMetadataUri: 'https://primes.live/collection.json',
    nftContentPrefix: 'https://primes.live/nft/',
    jettonMetadataUri: 'https://primes.live/jetton.json',
    royaltyNum: sharedParams.fees.royalty_numerator,
    royaltyDen: sharedParams.fees.royalty_denominator,
};

const withField = (over: Partial<GenesisPresentation>): GenesisPresentation => ({ ...GOOD, ...over });

describe('validatePresentation', () => {
    it('accepts the values deployGenesis.ts actually ships', () => {
        expect(() => validatePresentation(GOOD)).not.toThrow();
    });

    it('is traceable to params.json rather than a literal (CLAUDE.md rule 3)', () => {
        // The 5% is CONCEPT §3.1's, and the numbers come from the sim's params file. A
        // rate hardcoded in a wrapper default is exactly what rule 3 calls a bug.
        expect(GOOD.royaltyNum / GOOD.royaltyDen).toBeCloseTo(sharedParams.fees.royalty_pct, 12);
        expect(sharedParams.fees.royalty_pct).toBe(0.05);
    });

    describe('rejects a presentation that would deploy nameless', () => {
        // The original bug, field by field: an empty string is what the wrapper defaults
        // produced, so each of these is the exact state that shipped.
        // Every URI. (The generators and constellations collections' four were here until
        // D-202 deleted both collections.)
        for (const field of ['collectionMetadataUri', 'nftContentPrefix', 'jettonMetadataUri'] as const) {
            it(`refuses an empty ${field}`, () => {
                expect(() => validatePresentation(withField({ [field]: '' }))).toThrow(
                    /baked into immutable init data/i
                );
            });

            it(`refuses a non-https ${field}`, () => {
                expect(() =>
                    validatePresentation(withField({ [field]: 'http://primes.live/x.json' }))
                ).toThrow(/must be an https:\/\/ URI/i);
            });

            it(`refuses a ${field} too long for a single-cell TEP-64 URI`, () => {
                const long = 'https://primes.live/' + 'x'.repeat(MAX_URI_BYTES) + '/';
                expect(Buffer.byteLength(long, 'utf8')).toBeGreaterThan(MAX_URI_BYTES);
                expect(() => validatePresentation(withField({ [field]: long }))).toThrow(
                    /single-cell TEP-64 limit/i
                );
            });
        }

        // The item prefix: the collection concatenates its key with no separator, so a
        // missing slash mints every item at ".../nft1234.json".
        for (const field of ['nftContentPrefix'] as const) {
            it(`refuses a ${field} with no trailing slash`, () => {
                expect(() => validatePresentation(withField({ [field]: 'https://primes.live/nft' }))).toThrow(
                    /must end in "\/"/i
                );
            });
        }

        it('accepts a URI of exactly the cell limit, and rejects one byte more', () => {
            const pad = (n: number) => 'https://primes.live/' + 'x'.repeat(n - 'https://primes.live/'.length);
            expect(Buffer.byteLength(pad(MAX_URI_BYTES), 'utf8')).toBe(MAX_URI_BYTES);
            expect(() => validatePresentation(withField({ jettonMetadataUri: pad(MAX_URI_BYTES) }))).not.toThrow();
            expect(() => validatePresentation(withField({ jettonMetadataUri: pad(MAX_URI_BYTES + 1) }))).toThrow(
                /single-cell TEP-64 limit/i
            );
        });

        it('refuses a royalty that is not a fraction in [0,1]', () => {
            expect(() => validatePresentation(withField({ royaltyDen: 0 }))).toThrow(/not a fraction/i);
            expect(() => validatePresentation(withField({ royaltyNum: -1 }))).toThrow(/not a fraction/i);
            expect(() => validatePresentation(withField({ royaltyNum: 10001, royaltyDen: 10000 }))).toThrow(
                /not a fraction/i
            );
        });
    });

    it('a URI at the limit really does fit in one cell', () => {
        // The whole point of MAX_URI_BYTES is that @ton/core would otherwise throw a bare
        // "Bit overflow" from inside storeBuffer — at deploy time, with contracts already
        // on chain ahead of the one being built.
        const atLimit = 'https://primes.live/' + 'x'.repeat(MAX_URI_BYTES - 'https://primes.live/'.length);
        expect(() => offchainContentCell(atLimit)).not.toThrow();
        expect(() => offchainContentCell(atLimit + 'x')).toThrow();
    });
});

describe('the presentation deployGenesis.ts actually ships', () => {
    // Read from the two real network files, exactly as a genesis run does.
    const fileCfg = (network: Network) =>
        parseNetworkConfig(readFileSync(resolve(__dirname, `../../shared/networks/${network}.yaml`), 'utf8'), network);

    it.each(['mainnet', 'testnet'] as const)('%s.yaml passes the validator', (network) => {
        // These are what a real genesis uses; if they could not pass validation the
        // guard would only ever fire on the deploy nobody runs.
        expect(() => validatePresentation(resolvePresentation(fileCfg(network)))).not.toThrow();
    });

    it('points at documents this repo actually serves', () => {
        const p = resolvePresentation(fileCfg('mainnet'));
        // webapp/public/*.json are published to the site root, and nginx routes /nft/ to
        // the read-proxy (ops/deploy/primes.live.conf). A URI that validates but 404s is
        // still a nameless collection — just for a different reason, and just as permanent.
        expect(existsSync(resolve(__dirname, '../../webapp/public/collection.json'))).toBe(true);
        expect(existsSync(resolve(__dirname, '../../webapp/public/jetton.json'))).toBe(true);
        expect(p.collectionMetadataUri).toBe('https://primes.live/collection.json');
        expect(p.jettonMetadataUri).toBe('https://primes.live/jetton.json');
        expect(p.nftContentPrefix).toBe('https://primes.live/nft/');

        // The nginx half of this check (ops/deploy/primes.live.conf routes /nft/ and the two
        // documents) runs in the private deployment repo; the host config is not published.
    });

    it('serves metadata documents with the fields a wallet needs', () => {
        // TEP-64 off-chain: the cell only carries a URI, so the NAME lives in the document.
        // An unparseable or field-less document is the same nameless outcome the content
        // cell was fixed to avoid.
        const jetton = JSON.parse(readFileSync(resolve(__dirname, '../../webapp/public/jetton.json'), 'utf8'));
        expect(jetton.name).toBeTruthy();
        expect(jetton.symbol).toBe('PRIMES');
        // Decimals must match the nanoPRIMES the contracts emit, or every balance a wallet
        // shows is wrong by orders of magnitude.
        expect(String(jetton.decimals)).toBe('9');

        // All THREE collection documents. Each names a collection a marketplace renders, and
        // a document with no `name` is the nameless outcome the content cell was fixed to
        // avoid — just moved one hop further out.
        // Collected and compared as a whole rather than asserted in the loop, so a failure
        // names WHICH document is nameless in the diff — jest's `expect` takes no message.
        const docs = ['collection.json'].map((file) => {
            const doc = JSON.parse(readFileSync(resolve(__dirname, `../../webapp/public/${file}`), 'utf8'));
            return { file, named: Boolean(doc.name), described: Boolean(doc.description) };
        });
        expect(docs).toEqual([
            { file: 'collection.json', named: true, described: true },
        ]);
    });

    it('refuses a network file whose nft prefix has no trailing slash', () => {
        const text = readFileSync(resolve(__dirname, '../../shared/networks/testnet.yaml'), 'utf8').replace(
            'nft_content_prefix: https://primes.live/nft/',
            'nft_content_prefix: https://primes.live/nft'
        );
        expect(() => parseNetworkConfig(text, 'testnet')).toThrow(/must end with "\/"/);
    });
});

describe('content cell decoders', () => {
    it('round-trips a single-cell off-chain URI', () => {
        const uri = 'https://primes.live/jetton.json';
        expect(decodeOffchainContent(offchainContentCell(uri))).toBe(uri);
    });

    it('rejects the empty cell the pipeline used to deploy', () => {
        // Not a cosmetic assertion: an empty content cell is precisely what
        // `get_jetton_data` and `get_collection_data` returned before the fix, and reading
        // it as "" rather than throwing is what made the bug invisible.
        expect(() => decodeOffchainContent(beginCell().endCell())).toThrow(/empty/i);
    });

    it('rejects an untagged cell', () => {
        // `snakeCell` is the correct encoder for commonContentPrefix (the contract writes
        // the tag itself) and the WRONG one for a content cell returned verbatim. Passing
        // one where the other belongs is a live footgun, so the decoder refuses.
        expect(() => decodeOffchainContent(snakeCell('https://primes.live/x.json'))).toThrow(/tag/i);
    });

    it('decodes the prefix+index cell get_nft_content composes', () => {
        const composed = beginCell()
            .storeUint(1, 8)
            .storeBuffer(Buffer.from('https://primes.live/nft/', 'utf8'))
            .storeRef(beginCell().storeBuffer(Buffer.from('1234.json', 'utf8')).endCell())
            .endCell();
        expect(decodeComposedNftContent(composed)).toBe('https://primes.live/nft/1234.json');
    });

    it('shows what the unfixed pipeline produced: a bare relative path', () => {
        // The empty commonContentPrefix default, decoded. This is what every one of the
        // millions of items would have reported forever.
        const broken = beginCell()
            .storeUint(1, 8)
            .storeRef(beginCell().storeBuffer(Buffer.from('1234.json', 'utf8')).endCell())
            .endCell();
        expect(decodeComposedNftContent(broken)).toBe('1234.json');
    });
});
