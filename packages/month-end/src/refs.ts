/** Uppercase, alphanumerics only: "inv-3104" and "INV 3104" both become "INV3104". */
export function normaliseRef(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((p) => new RegExp(p, 'i'));
}

/**
 * The key two lines are compared on. Bank references are often buried in free text
 * ("APP PMT NDLOVU INV3104"), so preset patterns are tried against reference + description
 * first; otherwise the reference field itself is used. Empty key = no reference.
 */
export function referenceKey(reference: string, description: string, patterns: RegExp[]): string {
  const haystack = `${reference} ${description}`;
  for (const p of patterns) {
    const m = haystack.match(p);
    if (m) return normaliseRef(m[0]);
  }
  return normaliseRef(reference);
}
