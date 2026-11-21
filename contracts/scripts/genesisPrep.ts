/**
 * TON PRIMES — genesis PREP: the hand steps before `deployGenesis.ts --skew-safe`, checked.
 *
 * Reads `/.env` (the same line regex every `*Live.ts` script uses — no dotenv) and prints:
 *   - the deploy SUBWALLET address for `PRIMES_DEPLOY_SUBWALLET_ID` and its live balance,
 *     against the 13 TON pipeline floor (gotcha 10 in docs/testnet-deployment.md) — this is
 *     the address to fund before the run;
 *   - every deploy-time env var the runner `requireAddr`s, and whether it is set;
 *   - whether `PRIMES_PROPOSER_ADDR` IS the subwallet (gotcha 8 — the venue timelock bakes
 *     it in and the 2026-08-17 / 2026-08-29 runs died at the last step when it wasn't);
 *   - whether `PRIMES_OPERATOR_ADDR` IS `.owner.json`'s key as v4R2 (TESTNET_MASTER_PLAN.md §4b).
 *
 *   npx tsx contracts/scripts/genesisPrep.ts            # report
 *
 * (The invite signer pair and `--keygen` are gone: D-202 deleted the signature.)
 * Exit 1 on any refusal the runner would also make, so this is safe to run repeatedly.
 */
import fs from 'fs';
import path from 'path';
import { beginCell } from '@ton/core';
import { Address, TonClient, WalletContractV4 } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import {
    hydrateProcessEnv,
    deploySubwalletId,
    loadEnvFile,
    clockDivisorFromEnv,
    resolveStakeMin,
    MAINNET_AUCTION_SECONDS,
    assertBuildFresh,
} from './envFile';
import { getPoolAddress, jettonAsset } from './dedust';
import { readOwnerEntry } from './testnet/cast';
import { dryRunGenesisMasterAddress } from './genesisPipeline';
import { resolvePresentation } from './deployGenesis';
import { Cell } from '@ton/core';

// `tsx` loads no `.env`; every `process.env.PRIMES_*` read below depends on this.
hydrateProcessEnv();

const REPO = path.resolve(__dirname, '..', '..');
const PIPELINE_GAS_FLOOR_TON = 13;
/**
 * With `PRIMES_DEDUST_LP_STANDIN=0` the run does not stop at genesis: it is
 * followed by `donateFloor.ts` (the D-154 donation, 132.50 TON) and
 * `seedDedustLiquidity.ts` (the same figure again as the pool's TON side, plus
 * the jetton vault and the deposit/transfer hops). Those come out of this same
 * wallet, so the floor has to cover them or the run dies halfway with the pool
 * half-seeded and the LP receipt unforwarded.
 */
const SEEDING_BUDGET_TON = 10;

const BUILD = path.resolve(__dirname, '..', 'build');
function loadCode(name: string): Cell {
    const j = JSON.parse(fs.readFileSync(path.join(BUILD, `${name}.compiled.json`), 'utf8'));
    return Cell.fromBoc(Buffer.from(j.hex, 'hex'))[0];
}

async function main() {
    assertBuildFresh();
    const env = loadEnvFile();
    let fail = false;
    const refuse = (msg: string) => { console.log(`  !! ${msg}`); fail = true; };

    const mnemonic = env.get('KEEPER_WALLET_MNEMONIC');
    if (!mnemonic) throw new Error('KEEPER_WALLET_MNEMONIC not found in /.env');
    const keyPair = await mnemonicToPrivateKey(mnemonic.split(/\s+/));
    // Resolved through the SHARED accessor so this preflight cannot check a
    // different wallet than deployGenesis.ts --skew-safe deploys from (envFile.ts).
    const walletId = deploySubwalletId(env);
    const walletIdRaw = walletId === undefined ? undefined : String(walletId);
    const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey, walletId });
    const addr = wallet.address;

    const client = new TonClient({
        endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC',
        apiKey: env.get('TONCENTER_API_KEY_TESTNET') || undefined,
    });
    const balance = Number(await client.getBalance(addr)) / 1e9;
    const deployed = await client.isContractDeployed(addr);

    console.log(`deploy subwallet id: ${walletIdRaw ?? '<default>'}`);
    console.log(`deploy subwallet:    ${addr.toString({ testOnly: true })}`);
    const standIn = env.get('PRIMES_DEDUST_LP_STANDIN') === '1';
    const floorTon = standIn ? PIPELINE_GAS_FLOOR_TON : PIPELINE_GAS_FLOOR_TON + SEEDING_BUDGET_TON;
    console.log(
        `balance:             ${balance} TON (floor ${floorTon}` +
            (standIn ? '' : ` = ${PIPELINE_GAS_FLOOR_TON} pipeline + ${SEEDING_BUDGET_TON} donate/seed`) +
            ')'
    );
    if (!walletIdRaw) refuse('PRIMES_DEPLOY_SUBWALLET_ID unset — every genesis needs a FRESH id (gotcha 6)');

    // Gotcha 6, checked against the thing that actually collides. Every genesis
    // contract's init embeds the deploy wallet, so REUSING a subwallet id
    // re-derives addresses a previous run already occupied. This used to be
    // approximated by "is the deploy wallet itself deployed?" — and that proxy
    // stopped being true the moment createDedustPool.ts had to run BEFORE
    // genesis (R18): creating the pool sends one external from this wallet,
    // which deploys it. Bumping the id to satisfy the proxy would move the
    // jetton master and orphan the pool just paid for — the exact
    // unrecoverable mistake the pool check below exists to prevent.
    //
    // So ask the direct question instead: is the PRIMES jetton master this run
    // would deploy already on chain? A fresh id derives a fresh master; a
    // reused one derives the old master, deployed. That is the collision, not
    // the wallet's own deploy state.
    let master: Address | undefined;
    try {
        master = dryRunGenesisMasterAddress(
            addr,
            loadCode('PrimesJettonMaster'),
            loadCode('PrimesJettonWallet'),
            resolvePresentation().jettonMetadataUri
        );
    } catch (e) {
        refuse(`could not derive this run's jetton master (is contracts/build populated? run pnpm build): ${String(e)}`);
    }
    if (master) {
        const fmt = master.toString({ testOnly: true });
        if (await client.isContractDeployed(master)) {
            refuse(
                `the jetton master this run would deploy (${fmt}) is ALREADY on chain — this subwallet id ` +
                    'has run genesis before. Bump PRIMES_DEPLOY_SUBWALLET_ID, then re-run createDedustPool.ts ' +
                    '(a new id moves the master, and the pool is keyed on it).'
            );
        }
        console.log(`PRIMES jetton master: ${fmt}  (not yet deployed — id is fresh)`);
    }
    if (deployed) {
        console.log('  note this subwallet has sent transactions before (expected: createDedustPool.ts).');
    }
    if (balance < floorTon) console.log(`  -> FUND IT: send >= ${floorTon} TON to the address above, then re-run this script`);

    // GOTCHA 6, ENFORCED — a FRESH subwallet id per genesis.
    //
    // 2026-09-17: this check did not exist, and a run started on `20260919`, the id the
    // LIVE set was deployed from that same morning. The "id is fresh" line above did not
    // catch it, because it only asks whether the JETTON MASTER is deployed — and the
    // master had moved on its own that day (the TEP-74 `excesses` arm changed its code),
    // so a brand-new master address sat on top of a fully reused set. Three contracts
    // whose code had NOT changed — the collection, the venue timelock, the (since
    // deleted) generators collection — re-derive to the LIVE set's addresses on a reused id, and the deploy
    // then "deploys" onto already-active contracts: TON ignores the stateInit, the money
    // is credited as a plain top-up, the log says `deploy:collection`, and the run walks
    // into one-shot links that are already spent. Nothing announces it.
    //
    // The recorded id is the one `docs/testnet-deployment.md`'s status line carries, which
    // `pnpm check:env-genesis` already treats as the live table's own statement about
    // itself. Refusing on equality is the whole fix.
    const deployDoc = fs.readFileSync(path.join(REPO, 'docs', 'testnet-deployment.md'), 'utf8');
    const liveId = deployDoc.match(/deploy subwallet `(\d+)`/)?.[1];
    if (liveId && walletIdRaw === liveId) {
        refuse(
            `PRIMES_DEPLOY_SUBWALLET_ID=${liveId} is the id the LIVE set was deployed from ` +
                `(docs/testnet-deployment.md's status line). Gotcha 6: use a FRESH id per genesis — ` +
                `every contract whose code has not changed re-derives to a LIVE address and the ` +
                `deploy silently lands on an already-active contract with its one-shot links spent. ` +
                `Bump it (convention: YYYYMMDD of the run), then re-run createDedustPool.ts, because ` +
                `the id moves the jetton master and orphans the pool.`
        );
    }

    // D-139 — THE TEST CLOCK, printed because it is baked into three contracts'
    // addresses and there is no way to change it after the run. Throws here, on a
    // read-only preflight, rather than halfway through a genesis.
    const divisor = clockDivisorFromEnv(env);
    const auctionSeconds = MAINNET_AUCTION_SECONDS / divisor;
    console.log(
        `auction clock:       ${auctionSeconds}s (divisor ${divisor})` +
            (divisor === 1
                ? '  — MAINNET SPEED'
                : `  — flush cooldown ${Math.floor(86400 / divisor)}s, vote ${Math.floor(86400 / divisor)}s`)
    );

    // D-153 — THE TEST STAKE FLOOR, printed for the same reason: it is baked into
    // the ratchet's address and no message can change it. The EFFECTIVE figure is
    // printed, not the requested one, because the divisor is rounded.
    const stake = resolveStakeMin(env);
    console.log(
        `stake minimum:       ${stake.effectiveTon} TON (divisor ${stake.divisor})` +
            (stake.divisor === 1
                ? '  — MAINNET, and `stake` needs `pending` above 625 TON'
                : `  — \`stake\` needs \`pending\` above ${(stake.effectiveTon / 0.8).toFixed(4)} TON`)
    );

    console.log('deploy-time env:');
    for (const k of [
        'PRIMES_OPERATOR_ADDR',
        'PRIMES_PROPOSER_ADDR',
        'PRIMES_DEDUST_VAULT_ADDR',
        'PRIMES_DEDUST_POOL_ADDR',
        'PRIMES_DEDUST_JETTON_VAULT_ADDR',
        'PRIMES_DEDUST_LP_STANDIN',
    ]) {
        const v = env.get(k);
        console.log(`  ${v ? 'ok ' : '-- '} ${k}${v ? '' : '  (UNSET)'}`);
        if (!v) refuse(`${k} is required by the runner`);
    }
    // THE OPERATOR IS THE OWNER'S KEY, AS v4R2. `.owner.json` holds the human's seed as
    // a W5 wallet; the forfeit remainder and the TEP-66 royalty go to the SAME seed's
    // v4R2 default-subwallet account instead — one key, two accounts, and a genesis that
    // stamps any other address into `ConfigA.operatorAddr` is refused here.
    const owner = readOwnerEntry();
    const opAddr = env.get('PRIMES_OPERATOR_ADDR');
    if (!owner) {
        refuse('.owner.json is missing — PRIMES_OPERATOR_ADDR must be its key as v4R2');
    } else if (opAddr) {
        const ownerV4 = WalletContractV4.create({
            workchain: 0,
            publicKey: (await mnemonicToPrivateKey(owner.mnemonic)).publicKey,
        }).address;
        if (Address.parse(opAddr).equals(ownerV4)) {
            console.log(`  ok  PRIMES_OPERATOR_ADDR is .owner.json's key as v4R2`);
        } else {
            refuse(
                `PRIMES_OPERATOR_ADDR must be .owner.json's key as v4R2: set it to ` +
                    ownerV4.toString({ testOnly: true, bounceable: false })
            );
        }
    }
    if (env.get('PRIMES_TREASURY_ADDR') && !env.get('PRIMES_OPERATOR_ADDR')) {
        refuse('PRIMES_TREASURY_ADDR is the pre-D-100 name — rename it to PRIMES_OPERATOR_ADDR (gotcha 5)');
    }
    // DeDust v2 IS deployed on TON testnet, at the SAME factory address as mainnet
    // (EQBfBWT7…J67 — mainnet's code has since been upgraded, testnet still runs the
    // original, which is why the two code hashes differ at one address). Vault and pool
    // creation there is permissionless and cheap (create_vault#21cfe02b 0.1 TON,
    // create_volatile_pool#97d51f2f 0.3 TON). So `PRIMES_DEDUST_LP_STANDIN=1` is no
    // longer the only legal testnet setting, and the old unconditional refusal here
    // ("no real DeDust pool exists there") was simply false.
    //
    // The real precondition is unchanged and is now checked directly: with the stand-in
    // OFF, step 25b calls `get_wallet_address` on the pool, so the pool must ALREADY be
    // deployed — its answer lands in the LP sink's and the treasury's one-shot bootstraps
    // and neither survives a wrong address (D-100 point 4).
    if (!standIn) {
        const pool = env.get('PRIMES_DEDUST_POOL_ADDR')!;

        // THE CHECK THAT MATTERS MOST, AND THE ONE NOTHING ELSE MAKES. The pool
        // is keyed on the PRIMES jetton master's ADDRESS, and that address moves
        // whenever `PRIMES_DEPLOY_SUBWALLET_ID` does. So a pool created against
        // yesterday's subwallet id is a live, healthy contract that answers
        // `get_wallet_address` perfectly — and is for a different token. The
        // probe below would pass and step 25b would bake its answer into the LP
        // sink's and the treasury's ONE-SHOT bootstraps (D-100 point 4), after
        // which no LP from the real pool can ever be locked and neither contract
        // can be repaired. Recomputing the pair here costs one get-call.
        try {
            if (!master) throw new Error('jetton master could not be derived (see above)');
            const expected = await getPoolAddress(client, { kind: 'native' }, jettonAsset(master));
            if (!expected.equals(Address.parse(pool))) {
                refuse(
                    `PRIMES_DEDUST_POOL_ADDR is ${pool}, but the pool for the jetton master THIS run will ` +
                        `deploy (${master.toString({ testOnly: true })}) is ` +
                        `${expected.toString({ testOnly: true })}. The subwallet id has changed since the pool ` +
                        'was created. Re-run createDedustPool.ts and use the address it prints.'
                );
            } else {
                console.log(`  ok  pool ${pool} is the pool for this run's jetton master`);
            }
        } catch (e) {
            refuse(`could not verify the pool is keyed on this run's jetton master: ${String(e)}`);
        }

        try {
            const res = await client.runMethod(Address.parse(pool), 'get_wallet_address', [
                { type: 'slice', cell: beginCell().storeAddress(addr).endCell() },
            ]);
            console.log(`  ok  DeDust pool ${pool} answers get_wallet_address -> ${res.stack.readAddress().toString({ testOnly: true })}`);
        } catch (e) {
            refuse(
                `PRIMES_DEDUST_LP_STANDIN is not 1, so the pool must be live, but ` +
                    `${pool} does not answer get_wallet_address. Create the PRIMES/TON pool ` +
                    `first (npx tsx scripts/dryRunGenesisAddresses.ts -> create_volatile_pool ` +
                    `on the factory), or set PRIMES_DEDUST_LP_STANDIN=1 to run without one. ` +
                    `Underlying: ${String(e)}`
            );
        }
    }
    // The three signer keys deployGenesis.ts reads after it has already sent the mock
    // Tonstakers pool (resolveStakingVenue). 2026-11-21: a stale single
    // VOUCHER_SIGNER_SECRET_KEY (pre-R2-M2) passed prep and failed the run there.
    const q = env.get('QUESTS_VOUCHER_SIGNER_SECRET_KEY') ?? '';
    const pq = env.get('PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY') ?? '';
    const sec = env.get('SECURITY_BOUNTY_SIGNER_PUBKEY') ?? '';
    const hex = (s: string, n: number) => new RegExp(`^[0-9a-fA-F]{${n}}$`).test(s);
    if (!hex(q, 128) || !hex(pq, 128)) {
        refuse('QUESTS_VOUCHER_SIGNER_SECRET_KEY and PRIME_QUESTS_VOUCHER_SIGNER_SECRET_KEY must each be a 64-byte hex secret (R2-M2; .env.example has the generator)');
    } else if (q.toLowerCase() === pq.toLowerCase()) {
        refuse('the two voucher signer keys are equal — one key per track (R2-M2)');
    } else if (!hex(sec, 64) || [q, pq].some((k) => k.slice(64).toLowerCase() === sec.toLowerCase())) {
        refuse('SECURITY_BOUNTY_SIGNER_PUBKEY must be a 32-byte hex pubkey distinct from both voucher keys (D-170, R2-M2)');
    } else {
        console.log('  ok  voucher + security signer keys: three distinct keys');
    }
    const proposer = env.get('PRIMES_PROPOSER_ADDR');
    if (proposer && !Address.parse(proposer).equals(addr)) {
        refuse(`PRIMES_PROPOSER_ADDR is not this subwallet — set it to ${addr.toString({ testOnly: true })} (gotcha 8)`);
    }

    console.log(fail ? 'NOT READY — fix the lines above.' : `ready: fund ${addr.toString({ testOnly: true })} if needed, then run deployGenesis.ts --skew-safe backgrounded.`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
