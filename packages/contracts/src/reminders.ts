// The reminder draft: dates that need attention or are upcoming, filled into the preset's templates.
// Prepared for a person to edit and approve. Nothing is ever sent.

import { formatDate, type IsoDate } from '../../core/src/index.ts';
import type { ContractsPreset } from './preset.ts';
import { clauseNumber } from './record.ts';
import type { Register, RegisterKeyDate } from './register.ts';
import type { Renewal } from './types.ts';

export interface ReminderDraft {
  to: string;
  subject: string;
  body: string;
  items: RegisterKeyDate[];
  /** Passed notice deadlines where the agreement continues month to month. */
  notes: string[];
}

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function daysText(days: number): string {
  return days === 0 ? 'today' : days > 0 ? `${plural(days, 'day', 'days')} away` : `${plural(-days, 'day', 'days')} ago`;
}

export function reminderDraft(reg: Register, asAt: IsoDate, preset: ContractsPreset): ReminderDraft {
  const t = preset.reminders;
  const upcoming = preset.alertWindows.upcoming;
  const items = reg.keyDates.filter((d) => d.status === 'attention' || d.status === 'upcoming');

  const lines = items.map((d, i) =>
    fill(t.item, {
      n: i + 1,
      date: formatDate(d.date!),
      days: daysText(d.days!),
      counterparty: d.counterparty,
      type: d.type.toLowerCase(),
      ref: d.ref,
      label: d.label,
      what: d.what.replace(/\.$/, ''),
      clause: d.clause ?? `p.${d.derivation.noticeSource?.page ?? d.derivation.base?.sources[0]?.page ?? '?'}`,
    }),
  );

  const notes = reg.keyDates
    .filter((d) => d.status === 'passed' && d.tags.includes('notice'))
    .flatMap((d) => {
      const renewal = reg.rows.find((r) => r.id === d.agreementId)?.record.fields.renewal;
      if (renewal?.status !== 'recorded' || (renewal.value as Renewal).kind !== 'month_to_month') return [];
      const source = renewal.current !== undefined ? renewal.candidates[renewal.current] : undefined;
      const num = clauseNumber(source?.clause);
      const where = num ? `clause ${num}` : source ? `page ${source.page}` : 'the agreement';
      return [`${d.ref}'s notice deadline passed on ${formatDate(d.date!)}; ${where} says the agreement continues month to month.`];
    });

  const subject = fill(t.subject, { upcoming, asAt: formatDate(asAt) });
  const main = items.length ? `${fill(t.intro, { upcoming })}\n\n${lines.join('\n\n')}` : fill(t.empty, { upcoming });
  const body = `To: ${t.to}\nSubject: ${subject}\n\n${main}${notes.length ? `\n\n${notes.join('\n')}` : ''}\n\n${t.outro}`;
  return { to: t.to, subject, body, items, notes };
}
