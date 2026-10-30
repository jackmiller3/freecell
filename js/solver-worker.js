import { analyze } from './solver.js';
import { msDeal } from './engine.js';

const MAX_SEED = 1_000_000;

self.onmessage = ({ data }) => {
  const { id, type } = data;
  if (type === 'analyze') {
    const r = analyze(data.state, { budget: data.budget });
    self.postMessage({ id, status: r.status, moves: r.moves });
  } else if (type === 'deal') {
    // Find a winnable deal, skipping any the solver can't win.
    // mode 'from' walks upward from a given seed (daily / chosen deals);
    // mode 'random' picks fresh random seeds.
    const skipped = [];
    let seed = data.mode === 'from' ? data.seed : 1 + Math.floor(Math.random() * MAX_SEED);
    for (;;) {
      const r = analyze(msDeal(seed), { budget: 150000 });
      if (r.status === 'solved') {
        self.postMessage({ id, seed, skipped, moves: r.moves });
        return;
      }
      skipped.push(seed);
      seed = data.mode === 'from' ? (seed % MAX_SEED) + 1 : 1 + Math.floor(Math.random() * MAX_SEED);
    }
  }
};
