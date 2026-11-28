import { makeClient, retry } from './sender';
import { walletFor, addr } from './chain';
import { PrimesTreasury } from '../../wrappers/PrimesTreasury';
import { PrimesLpPosition } from '../../wrappers/PrimesLpPosition';
(async () => {
  const c = makeClient();
  const t = c.open(PrimesTreasury.createFromAddress(addr('PRIMES_TREASURY_ADDRESS')));
  const w = await walletFor(c, process.argv[2] ?? 'L');
  const p = c.open(PrimesLpPosition.createFromAddress(await retry(() => t.getPositionAddress(w.wallet.address), 'pa')));
  const ps = await retry(() => p.getPositions(), 'ps'); console.log(ps);
  for (let i = 0; i < ps.nextId; i++) { const r = await retry(() => p.getPosition(i), 'p'); console.log(i, r.tier, r.amount, 'matures', r.maturesAt, 'since', r.weightSince, 'in', r.maturesAt - Math.floor(Date.now()/1000), 's'); }
  console.log('terms', await retry(() => p.getTierTerms(), 't'), 'forever', await retry(() => p.getForever(), 'f'));
})();
