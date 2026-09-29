import type { Cents } from '../../core/src/index.ts';
import type { IsoDate } from '../../core/src/index.ts';

export type Side = 'bank' | 'ledger';

/** One normalised line. Every ingest adapter (CSV, OFX, later LlamaParse PDF) outputs this. */
export interface Line {
  id: string;
  side: Side;
  date: IsoDate;
  description: string;
  reference: string;
  /** Positive = money into the account, negative = money out, on both sides. */
  amount: Cents;
}
