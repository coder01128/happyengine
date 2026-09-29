// Service-neutral document pipeline: parser adapters, extractor adapters and the quote check.
// The local PDF.js parser is Node only and lives at '@happy/documents/pdfjs' (src/parsers/pdfjs.ts).
export * from './types.ts';
export * from './errors.ts';
export * from './grounding.ts';
export * from './positions.ts';
export * from './value-check.ts';
export * from './parsers/fixture.ts';
export * from './parsers/llamaparse.ts';
export * from './extract/fixture.ts';
export * from './extract/claude.ts';
