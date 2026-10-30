// Run: node tests/solver.test.mjs [from] [to]
import assert from 'node:assert/strict';
import { msDeal, cardName, doMove, autoPlay, canMove, isWon, encodeState, decodeState, finishMoves } from '../js/engine.js';
import { analyze as solve } from '../js/solver.js';

// Known deal #1 first row.
const d1 = msDeal(1);
assert.deepEqual(d1.c.map((c) => cardName(c[0])), ['J♦', '2♦', '9♥', 'J♣', '5♦', '7♥', '7♣', '5♥']);
assert.deepEqual(decodeState(encodeState(d1)), d1);

// Deal #11982 is the famous unwinnable one.
const r = solve(msDeal(11982), { budget: 3_000_000 });
assert.equal(r.status, 'unsolvable');
console.log('#11982 unsolvable, expanded', r.expanded);

const from = +(process.argv[2] || 1), to = +(process.argv[3] || 300);
let worst = 0, total = 0, unknown = [], t0 = Date.now(), lens = 0;
for (let seed = from; seed <= to; seed++) {
  const st0 = msDeal(seed);
  const res = solve(st0, {});
  if (res.status !== 'solved') { unknown.push([seed, res.status]); continue; }
  // Replay the solution to verify it.
  let st = st0;
  for (const m of res.moves) {
    if (!canMove(st, m.f, m.t, m.n)) throw new Error(`illegal move in #${seed}`);
    st = autoPlay(doMove(st, m)).st;
  }
  assert.ok(isWon(st), `#${seed} not won`);
  worst = Math.max(worst, res.expanded); total += res.expanded; lens += res.moves.length;
}
const n = to - from + 1;
console.log(`deals ${from}-${to}: ${((Date.now() - t0) / n).toFixed(1)}ms avg, nodes avg ${(total / n) | 0} worst ${worst}, avg len ${(lens / n) | 0}`);
console.log('not solved:', unknown);
