// Best-first FreeCell solver.
//
// Every edge is one player move followed by safe auto-play, matching the
// game's behaviour, so a solution's first move is directly usable as a hint.
// The move set is complete (every single-card move is generated, supermoves
// are shortcuts), so exhausting the search proves a position is unwinnable.

import {
  CASCADES, CELLS, CELL0, FOUND0,
  rankOf, suitOf, canStack, runLength, capacity,
  doMove, autoPlay, isTrivial, finishMoves, stateKey,
} from './engine.js';

function genMoves(st) {
  const moves = [];
  const { c, cl, fd } = st;
  let firstEmptyCell = -1;
  for (let i = 0; i < CELLS; i++) if (cl[i] < 0) { firstEmptyCell = i; break; }
  let firstEmptyCol = -1;
  for (let i = 0; i < CASCADES; i++) if (!c[i].length) { firstEmptyCol = i; break; }
  const capFull = capacity(st, false);
  const capEmpty = firstEmptyCol >= 0 ? capacity(st, true) : 0;

  // To foundations.
  for (let i = 0; i < CELLS; i++) {
    const card = cl[i];
    if (card >= 0 && fd[suitOf(card)] === rankOf(card) - 1) moves.push({ f: CELL0 + i, t: FOUND0 + suitOf(card), n: 1 });
  }
  for (let i = 0; i < CASCADES; i++) {
    const col = c[i];
    if (!col.length) continue;
    const card = col[col.length - 1];
    if (fd[suitOf(card)] === rankOf(card) - 1) moves.push({ f: i, t: FOUND0 + suitOf(card), n: 1 });
  }

  // Free cell -> cascade.
  for (let i = 0; i < CELLS; i++) {
    const card = cl[i];
    if (card < 0) continue;
    for (let j = 0; j < CASCADES; j++) {
      const dest = c[j];
      if (dest.length && canStack(card, dest[dest.length - 1])) moves.push({ f: CELL0 + i, t: j, n: 1 });
    }
    if (firstEmptyCol >= 0) moves.push({ f: CELL0 + i, t: firstEmptyCol, n: 1 });
  }

  // Cascade -> cascade.
  for (let i = 0; i < CASCADES; i++) {
    const col = c[i];
    if (!col.length) continue;
    const run = runLength(col);
    const top = col[col.length - 1];
    for (let j = 0; j < CASCADES; j++) {
      if (j === i) continue;
      const dest = c[j];
      if (!dest.length) continue;
      const need = rankOf(dest[dest.length - 1]) - rankOf(top);
      if (need < 1 || need > run || need > capFull) continue;
      if (canStack(col[col.length - need], dest[dest.length - 1])) moves.push({ f: i, t: j, n: need });
    }
    if (firstEmptyCol >= 0) {
      const max = Math.min(run, capEmpty, col.length - 1); // moving a whole column to an empty one is pointless
      for (let n = max; n >= 1; n--) moves.push({ f: i, t: firstEmptyCol, n });
    }
  }

  // Cascade -> free cell.
  if (firstEmptyCell >= 0) {
    for (let i = 0; i < CASCADES; i++) {
      if (c[i].length) moves.push({ f: i, t: CELL0 + firstEmptyCell, n: 1 });
    }
  }
  return moves;
}

// Lower is better.
function heuristic(st) {
  const { c, cl, fd } = st;
  let h = (52 - fd[0] - fd[1] - fd[2] - fd[3]) * 2;
  for (let i = 0; i < CASCADES; i++) {
    const col = c[i];
    let minRank = 99;
    for (let j = 0; j < col.length; j++) {
      const r = rankOf(col[j]);
      if (r > minRank) h += 1; // sits on a lower card: must be moved eventually
      else minRank = r;
    }
    if (!col.length) h -= 1;
  }
  for (let i = 0; i < CELLS; i++) if (cl[i] >= 0) h += 1;
  return h;
}

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(x) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].prio <= x.prio) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = x;
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        let l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        if (r < n && a[r].prio < a[l].prio) l = r;
        if (a[l].prio >= last.prio) break;
        a[i] = a[l];
        i = l;
      }
      a[i] = last;
    }
    return top;
  }
}

// Returns { status: 'solved', moves } | { status: 'unsolvable' } | { status: 'unknown' }.
// `moves` are player moves; safe auto-play is assumed after each one.
export function solve(start, { maxNodes = 200000, weight = 0.5 } = {}) {
  const seen = new Set([stateKey(start)]);
  const heap = new Heap();
  let seq = 0;
  heap.push({ s: start, parent: null, m: null, g: 0, prio: 0, seq: seq++ });
  let expanded = 0;
  while (heap.size) {
    const node = heap.pop();
    if (isTrivial(node.s)) {
      const moves = finishMoves(node.s);
      for (let n = node; n.parent; n = n.parent) moves.unshift(n.m);
      return { status: 'solved', moves, expanded };
    }
    if (++expanded > maxNodes) return { status: 'unknown', expanded };
    const g = node.g + 1;
    for (const m of genMoves(node.s)) {
      const { st } = autoPlay(doMove(node.s, m));
      const k = stateKey(st);
      if (seen.has(k)) continue;
      seen.add(k);
      heap.push({ s: st, parent: node, m, g, prio: heuristic(st) + g * weight, seq: seq++ });
    }
  }
  return { status: 'unsolvable', expanded };
}

// Different search weights shine on different deals; try a few in turn.
// Any attempt that exhausts the search proves the position unwinnable.
export function analyze(start, { budget = 240000 } = {}) {
  let expanded = 0;
  for (const weight of [0.5, 0, 2]) {
    const r = solve(start, { maxNodes: budget / 3, weight });
    expanded += r.expanded;
    if (r.status !== 'unknown') return { ...r, expanded };
  }
  return { status: 'unknown', expanded };
}
