// Replays saved ParsedDocument JSON (recorded with scripts/parse-file.ts). No network. For tests and smoke.

import { ParserError } from '../errors.ts';
import type { ParsedDocument, Parser } from '../types.ts';

/** `docs` maps a filename to its saved ParsedDocument (the caller reads the JSON files). */
export function createFixtureParser(docs: Record<string, ParsedDocument>): Parser {
  return {
    async parse(_file, opts) {
      const doc = docs[opts.filename];
      if (!doc) throw new ParserError('failed', `No recorded parse for ${opts.filename}`);
      return structuredClone(doc);
    },
  };
}
