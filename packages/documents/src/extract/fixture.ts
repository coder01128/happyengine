// Returns a saved extraction output. No network. For tests and smoke.

import type { Extractor } from '../types.ts';

export function createFixtureExtractor(output: unknown, model = 'fixture'): Extractor {
  return {
    async extract() {
      return { output: structuredClone(output), model, usage: { input: 0, output: 0 } };
    },
  };
}
