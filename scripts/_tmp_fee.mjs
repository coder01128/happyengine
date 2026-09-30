import { readFileSync, writeFileSync } from 'node:fs';
const f = 'packages/contracts/src/fee.ts';
let t = readFileSync(f, 'utf8');
const rep = (a, b, all = false) => { if (!t.includes(a)) throw new Error('missing ' + a.slice(0, 70)); t = all ? t.split(a).join(b) : t.replace(a, () => b); };
rep("const clean = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');",
`const clean = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// A bracket that only says which period a line is for: "(year 1)", "(months 13–24)", "(from 1 Feb 2025)", "(2025/26)".
// "(office)" and "(warehouse)" say which charge it is, so they stay.
const PERIOD_WORDS = /^(?:the\s+)?(?:years?|yrs?|months?|mths?|periods?|terms?|from|with effect|w\.?e\.?f\.?|until|till|to|ends?|starting|starts?|after|before|first|second|third|fourth|fifth|initial|renewal|final|last|current|new|previous|prior)\b/;
const PERIOD_DATES = /\b(?:19|20)\d\d\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|^\d+(?:st|nd|rd|th)?\s*(?:year|yr|month)/;
const isPeriodQualifier = (inner: string) => PERIOD_WORDS.test(inner.trim().toLowerCase()) || PERIOD_DATES.test(inner.trim().toLowerCase());

/** The charge a \`what\` names: lower case, single spaces, and without bracketed period qualifiers. */
export const chargeName = (what: string | undefined) =>
  clean((what ?? '').replace(/\(([^()]*)\)|\[([^\[\]]*)\]/g, (m, a, b) => (isPeriodQualifier(a ?? b ?? '') ? ' ' : m)));`);
// use chargeName wherever charges are grouped or compared
rep("if (isFeeLine(v) && clean(v.what)) amounts.push", "if (isFeeLine(v) && chargeName(v.what)) amounts.push");
rep("else if (isFeeText(v) && clean(v.what)) words.push", "else if (isFeeText(v) && chargeName(v.what)) words.push");
rep("const k = clean((l.line as FeeLine).what);", "const k = chargeName((l.line as FeeLine).what);");
rep("const same = kept.find((k) => clean((k.line as FeeText).what) === clean((w.line as FeeText).what));", "const same = kept.find((k) => chargeName((k.line as FeeText).what) === chargeName((w.line as FeeText).what));");
rep("const k = clean(l.what) || `#${n}`;", "const k = chargeName(l.what) || `#${n}`;");
rep("    const k = clean(m.line.what);", "    const k = chargeName(m.line.what);");
writeFileSync(f, t);
console.log('ok');
