// Happy Contracts settings, stored per organisation as data (presets table, service 'contracts').

export type ParserTier = 'cost_effective' | 'agentic' | 'agentic_plus';
export type ReviewOutcome = 'reviewed' | 'with_legal';
export type PresetSearchKind = 'fieldTag' | 'datesBefore' | 'review';

export interface ContractsPreset {
  service: 'Happy Contracts';
  version: number;
  /** Parser tier for digital PDFs; scanned uploads use scannedTier. Agreements over the page cap are refused. */
  parser: { tier: ParserTier; scannedTier: 'agentic' | 'agentic_plus'; maxPagesPerAgreement: number };
  /** Fuzzy match threshold (0–1) for finding an extracted quote on its page. Below it: "Not verified — review". */
  grounding: {
    minScore: number;
    /** Stray words a watermark or stamp drops into the text ("SAMPLE", "COPY"). Skipped when matching a quote, unless the quote itself has the word. */
    ignoreTokens?: string[];
  };
  /** Display order in the register. A required field that isn't found is flagged for review. */
  fields: { key: string; label: string; required: boolean }[];
  /** Days before a key date when it shows as "Needs attention" and "Upcoming". */
  alertWindows: { attention: number; upcoming: number };
  /** Choices a reviewer has for a flagged term, alphabetical by label. singleValueOnly: not offered on conflicts. */
  reviewOptions: { id: string; label: string; outcome: ReviewOutcome; singleValueOnly: boolean }[];
  /** Fixed filters over recorded fields, not free-form questions. datesBefore counts beforeDays from today. */
  presetSearches: { id: string; question: string; kind: PresetSearchKind; tag?: string; beforeDays?: number }[];
  /** Reminder draft wording. Placeholders in braces are filled in when the draft is prepared. Nothing is sent. */
  reminders: { to: string; subject: string; intro: string; item: string; outro: string; empty: string };
}

const TIERS: ParserTier[] = ['cost_effective', 'agentic', 'agentic_plus'];
const SCANNED_TIERS: ParserTier[] = ['agentic', 'agentic_plus'];
const OUTCOMES: ReviewOutcome[] = ['reviewed', 'with_legal'];
const SEARCH_KINDS: PresetSearchKind[] = ['fieldTag', 'datesBefore', 'review'];
const REMINDER_KEYS = ['to', 'subject', 'intro', 'item', 'outro', 'empty'] as const;

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isWhole = (v: unknown, min: number): v is number => Number.isInteger(v) && (v as number) >= min;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Every problem with a preset (empty = valid). Presets are hand-edited JSON rows, so check them before use. */
function problemsWith(p: unknown): string[] {
  if (!isObject(p)) return ['preset: not an object'];
  const problems: string[] = [];
  const need = (ok: boolean, message: string) => {
    if (!ok) problems.push(message);
  };

  need(p.service === 'Happy Contracts', 'service: must be "Happy Contracts"');
  need(isWhole(p.version, 1), 'version: must be a whole number of 1 or more');

  const parser = p.parser;
  if (!isObject(parser)) problems.push('parser: missing');
  else {
    need(TIERS.includes(parser.tier as ParserTier), `parser.tier: must be one of ${TIERS.join(', ')}`);
    need(SCANNED_TIERS.includes(parser.scannedTier as ParserTier), `parser.scannedTier: must be one of ${SCANNED_TIERS.join(', ')}`);
    need(isWhole(parser.maxPagesPerAgreement, 1), 'parser.maxPagesPerAgreement: must be a whole number of 1 or more');
  }

  const minScore = isObject(p.grounding) ? p.grounding.minScore : undefined;
  need(typeof minScore === 'number' && minScore >= 0 && minScore <= 1, 'grounding.minScore: must be a number from 0 to 1');
  const ignore = isObject(p.grounding) ? p.grounding.ignoreTokens : undefined;
  need(ignore === undefined || (Array.isArray(ignore) && ignore.every(isText)), 'grounding.ignoreTokens: must be a list of words');

  if (!Array.isArray(p.fields) || p.fields.length === 0) problems.push('fields: needs at least one field');
  else {
    const seen = new Set<string>();
    p.fields.forEach((f: unknown, i) => {
      if (!isObject(f) || !isText(f.key) || !isText(f.label) || typeof f.required !== 'boolean') {
        problems.push(`fields[${i}]: needs key, label and required (true or false)`);
        return;
      }
      need(!seen.has(f.key), `fields.${f.key}: listed twice`);
      seen.add(f.key);
    });
  }

  const w = p.alertWindows;
  if (!isObject(w) || !isWhole(w.attention, 0) || !isWhole(w.upcoming, 0)) {
    problems.push('alertWindows: attention and upcoming must be whole numbers of days');
  } else {
    need(w.attention <= w.upcoming, 'alertWindows: attention must not be longer than upcoming');
  }

  if (!Array.isArray(p.reviewOptions) || p.reviewOptions.length === 0) problems.push('reviewOptions: needs at least one option');
  else {
    const seen = new Set<string>();
    const labels: string[] = [];
    p.reviewOptions.forEach((o: unknown, i) => {
      if (!isObject(o) || !isText(o.id) || !isText(o.label)) {
        problems.push(`reviewOptions[${i}]: needs id and label`);
        return;
      }
      need(OUTCOMES.includes(o.outcome as ReviewOutcome), `reviewOptions.${o.id}.outcome: must be one of ${OUTCOMES.join(', ')}`);
      need(typeof o.singleValueOnly === 'boolean', `reviewOptions.${o.id}.singleValueOnly: must be true or false`);
      need(!seen.has(o.id), `reviewOptions.${o.id}: listed twice`);
      seen.add(o.id);
      labels.push(o.label);
    });
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, 'en'));
    need(labels.every((l, i) => l === sorted[i]), 'reviewOptions: must be in alphabetical order by label');
  }

  if (!Array.isArray(p.presetSearches)) problems.push('presetSearches: missing');
  else {
    const seen = new Set<string>();
    p.presetSearches.forEach((s: unknown, i) => {
      if (!isObject(s) || !isText(s.id) || !isText(s.question)) {
        problems.push(`presetSearches[${i}]: needs id and question`);
        return;
      }
      need(SEARCH_KINDS.includes(s.kind as PresetSearchKind), `presetSearches.${s.id}.kind: must be one of ${SEARCH_KINDS.join(', ')}`);
      if (s.kind === 'fieldTag') need(isText(s.tag), `presetSearches.${s.id}: a fieldTag search needs a tag`);
      if (s.kind === 'datesBefore') need(isWhole(s.beforeDays, 0), `presetSearches.${s.id}: a datesBefore search needs beforeDays`);
      need(!seen.has(s.id), `presetSearches.${s.id}: listed twice`);
      seen.add(s.id);
    });
  }

  const r = p.reminders;
  if (!isObject(r)) problems.push('reminders: missing');
  else for (const k of REMINDER_KEYS) need(isText(r[k]), `reminders.${k}: missing`);

  return problems;
}

/** Checks a preset and returns it typed. Throws one error that lists every missing or invalid setting. */
export function validateContractsPreset(p: unknown): ContractsPreset {
  const problems = problemsWith(p);
  if (problems.length) throw new Error(`Contracts preset is not valid: ${problems.join('; ')}`);
  return p as ContractsPreset;
}
