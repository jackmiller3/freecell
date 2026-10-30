// FreeCell rules engine. Pure functions over immutable-ish states.
//
// Card ids are 0..51: rank = (id >> 2) + 1 (A=1..K=13), suit = id & 3
// with suits ordered ♣ ♦ ♥ ♠ (the classic Microsoft deal order).
//
// A state is { c: number[8][], cl: number[4], fd: number[4] }
//   c  – cascades, bottom card first
//   cl – free cells, -1 when empty
//   fd – foundation height per suit (0 = empty, 13 = complete)
//
// Locations: 0..7 cascades, 8..11 free cells, 12..15 foundations (12 + suit).

export const CASCADES = 8;
export const CELLS = 4;
export const CELL0 = 8;
export const FOUND0 = 12;

export const rankOf = (c) => (c >> 2) + 1;
export const suitOf = (c) => c & 3;
export const isRed = (c) => ((c & 3) === 1) || ((c & 3) === 2);
export const cardOf = (rank, suit) => ((rank - 1) << 2) | suit;

export const RANK_LABELS = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUIT_NAMES = ['clubs', 'diamonds', 'hearts', 'spades'];

export function cardName(c) {
  return RANK_LABELS[rankOf(c)] + '♣♦♥♠'[suitOf(c)];
}

// Microsoft FreeCell deal. Works for any seed in [1, 2^31).
export function msDeal(seed) {
  let s = seed >>> 0;
  const rand = () => {
    s = (s * 214013 + 2531011) % 2147483648;
    return s >> 16;
  };
  const deck = Array.from({ length: 52 }, (_, i) => i);
  const c = [[], [], [], [], [], [], [], []];
  let left = 52;
  for (let i = 0; i < 52; i++) {
    const j = rand() % left;
    c[i % 8].push(deck[j]);
    deck[j] = deck[--left];
  }
  return { c, cl: [-1, -1, -1, -1], fd: [0, 0, 0, 0] };
}

export const canStack = (card, onto) =>
  rankOf(onto) === rankOf(card) + 1 && isRed(card) !== isRed(onto);

// Number of cards at the top of a cascade forming a valid alternating run.
export function runLength(col) {
  const len = col.length;
  if (!len) return 0;
  let n = 1;
  for (let i = len - 1; i > 0 && canStack(col[i], col[i - 1]); i--) n++;
  return n;
}

export function freeCellCount(st) {
  let n = 0;
  for (let i = 0; i < CELLS; i++) if (st.cl[i] < 0) n++;
  return n;
}

export function emptyCascadeCount(st) {
  let n = 0;
  for (let i = 0; i < CASCADES; i++) if (!st.c[i].length) n++;
  return n;
}

// Largest run that can be moved at once (a "supermove").
export function capacity(st, toEmpty) {
  const empty = emptyCascadeCount(st) - (toEmpty ? 1 : 0);
  return (freeCellCount(st) + 1) * (1 << Math.max(0, empty));
}

export function movingCard(st, f, n) {
  if (f < CELL0) {
    const col = st.c[f];
    return col[col.length - n];
  }
  return st.cl[f - CELL0];
}

// Why a move is illegal, or null if it is legal.
export function moveError(st, f, t, n = 1) {
  if (f === t) return 'same';
  let card;
  if (f < CELL0) {
    const col = st.c[f];
    if (n < 1 || n > col.length || n > runLength(col)) return 'run';
    card = col[col.length - n];
  } else if (f < FOUND0) {
    if (n !== 1) return 'run';
    card = st.cl[f - CELL0];
    if (card < 0) return 'empty';
  } else {
    return 'foundation';
  }
  if (t >= FOUND0) {
    if (n !== 1) return 'run';
    return st.fd[suitOf(card)] === rankOf(card) - 1 ? null : 'nofit';
  }
  if (t >= CELL0) {
    if (n !== 1) return 'run';
    return st.cl[t - CELL0] < 0 ? null : 'nofit';
  }
  const dest = st.c[t];
  if (!dest.length) return n <= capacity(st, true) ? null : 'capacity';
  if (!canStack(card, dest[dest.length - 1])) return 'nofit';
  return n <= capacity(st, false) ? null : 'capacity';
}

export const canMove = (st, f, t, n = 1) => moveError(st, f, t, n) === null;

// Apply a (legal) move. Returns a new state; untouched cascades are shared.
export function doMove(st, m) {
  const { f, t, n } = m;
  const c = st.c.slice();
  const cl = st.cl.slice();
  const fd = st.fd.slice();
  let cards;
  if (f < CELL0) {
    const col = c[f];
    cards = col.slice(col.length - n);
    c[f] = col.slice(0, col.length - n);
  } else {
    cards = [cl[f - CELL0]];
    cl[f - CELL0] = -1;
  }
  if (t < CELL0) c[t] = c[t].concat(cards);
  else if (t < FOUND0) cl[t - CELL0] = cards[0];
  else fd[suitOf(cards[0])] = rankOf(cards[0]);
  return { c, cl, fd };
}

// A card is safe to auto-play when no remaining card could ever need it as
// a landing spot: both opposite-colour foundations already hold rank - 1.
export function isSafeToPlay(st, card) {
  const r = rankOf(card);
  const s = suitOf(card);
  if (st.fd[s] !== r - 1) return false;
  if (r <= 2) return true;
  const red = s === 1 || s === 2;
  const a = red ? 0 : 1;
  const b = red ? 3 : 2;
  return st.fd[a] >= r - 1 && st.fd[b] >= r - 1;
}

function autoStep(st) {
  for (let i = 0; i < CELLS; i++) {
    const card = st.cl[i];
    if (card >= 0 && isSafeToPlay(st, card)) return { f: CELL0 + i, t: FOUND0 + suitOf(card), n: 1 };
  }
  for (let i = 0; i < CASCADES; i++) {
    const col = st.c[i];
    if (!col.length) continue;
    const card = col[col.length - 1];
    if (isSafeToPlay(st, card)) return { f: i, t: FOUND0 + suitOf(card), n: 1 };
  }
  return null;
}

// Play every safe card to the foundations.
export function autoPlay(st) {
  const moves = [];
  for (let m = autoStep(st); m; m = autoStep(st)) {
    moves.push(m);
    st = doMove(st, m);
  }
  return { st, moves };
}

export const isWon = (st) => st.fd[0] === 13 && st.fd[1] === 13 && st.fd[2] === 13 && st.fd[3] === 13;

// True when no card sits on a higher card: the rest plays out mechanically.
export function isTrivial(st) {
  for (let i = 0; i < CASCADES; i++) {
    const col = st.c[i];
    for (let j = 1; j < col.length; j++) if (rankOf(col[j]) > rankOf(col[j - 1])) return false;
  }
  return true;
}

// Moves that play out a trivial position to the foundations.
export function finishMoves(st) {
  const moves = [];
  for (;;) {
    let m = null;
    for (let i = 0; i < CELLS && !m; i++) {
      const card = st.cl[i];
      if (card >= 0 && st.fd[suitOf(card)] === rankOf(card) - 1) m = { f: CELL0 + i, t: FOUND0 + suitOf(card), n: 1 };
    }
    for (let i = 0; i < CASCADES && !m; i++) {
      const col = st.c[i];
      if (!col.length) continue;
      const card = col[col.length - 1];
      if (st.fd[suitOf(card)] === rankOf(card) - 1) m = { f: i, t: FOUND0 + suitOf(card), n: 1 };
    }
    if (!m) return moves;
    moves.push(m);
    st = doMove(st, m);
  }
}

// Canonical key: cell order and cascade order don't matter for solvability.
export function stateKey(st) {
  const cells = st.cl.filter((x) => x >= 0).sort((a, b) => a - b);
  const cols = st.c.map((col) => String.fromCharCode(...col.map((x) => x + 48))).sort();
  return st.fd.join(',') + '|' + String.fromCharCode(...cells.map((x) => x + 48)) + '|' + cols.join('/');
}

// Exact (non-canonical) serialization for persistence.
export function encodeState(st) {
  const enc = (arr) => arr.map((x) => String.fromCharCode(x + 48)).join('');
  return [st.fd.join(','), st.cl.map((x) => (x < 0 ? '-' : String.fromCharCode(x + 48))).join(''), ...st.c.map(enc)].join('|');
}

export function decodeState(s) {
  const parts = s.split('|');
  const fd = parts[0].split(',').map(Number);
  const cl = [...parts[1]].map((ch) => (ch === '-' ? -1 : ch.charCodeAt(0) - 48));
  const c = parts.slice(2).map((p) => [...p].map((ch) => ch.charCodeAt(0) - 48));
  return { c, cl, fd };
}
