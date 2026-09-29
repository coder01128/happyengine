// Split deposits: one statement line that equals the sum of several cash book entries,
// e.g. a customer paying two invoices in one transfer. Pure search helpers used by Rule 6.

import type { Cents } from './money.ts';

export interface SplitCandidate {
  id: string;
  amount: Cents;
  /** Shares the statement line's reference key: if any candidate is an anchor, the split must include one. */
  anchor: boolean;
  /** Its reference number appears in the statement line's narrative. Used only to break ties. */
  mentioned: boolean;
}

/**
 * Every combination of 2..maxParts candidates whose amounts add up exactly to `target`.
 * Candidates must all share the target's sign. Stops after `limit` combinations (it's ambiguous by then).
 */
export function subsetsSummingTo(candidates: SplitCandidate[], target: Cents, maxParts: number, limit = 50): SplitCandidate[][] {
  const goal = Math.abs(target);
  const sorted = [...candidates].sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || (a.id < b.id ? -1 : 1));
  const found: SplitCandidate[][] = [];
  const pick: SplitCandidate[] = [];
  const walk = (start: number, remaining: number) => {
    if (remaining === 0) {
      if (pick.length >= 2) found.push([...pick]);
      return;
    }
    if (pick.length === maxParts) return;
    for (let i = start; i < sorted.length && found.length < limit; i++) {
      const a = Math.abs(sorted[i]!.amount);
      if (a > remaining) continue;
      pick.push(sorted[i]!);
      walk(i + 1, remaining - a);
      pick.pop();
    }
  };
  walk(0, goal);
  return found;
}

/**
 * The single combination to suggest, or undefined when none fits or it's ambiguous.
 * With an anchor present, only combinations containing it count. Ties go to the combination
 * with the most parts named in the narrative; a tie that remains means no suggestion.
 */
export function chooseSplit(subsets: SplitCandidate[][], hasAnchor: boolean): SplitCandidate[] | undefined {
  const pool = hasAnchor ? subsets.filter((s) => s.some((c) => c.anchor)) : subsets;
  if (pool.length <= 1) return pool[0];
  const score = (s: SplitCandidate[]) => s.filter((c) => c.mentioned).length;
  const best = Math.max(...pool.map(score));
  const top = pool.filter((s) => score(s) === best);
  return top.length === 1 ? top[0] : undefined;
}

/** Whether a reference key's number (3+ digits), or the whole key, appears in normalised narrative text. */
export function mentions(normalisedText: string, key: string): boolean {
  if (!key) return false;
  const numbers = key.match(/\d{3,}/g);
  if (numbers) return numbers.every((n) => normalisedText.includes(n));
  return key.length >= 4 && normalisedText.includes(key);
}
