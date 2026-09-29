// Shapes shared by every parser, the extractor and the quote check. Nothing here knows about any service.

/** Box in the page's own units, top-left origin. Viewers scale by (x / page.width) × rendered width,
 *  so the unit (points or pixels) never matters as long as box and page use the same one. */
export interface Box {
  x: number; y: number; w: number; h: number;
  /** Degrees clockwise around the box centre. Absent = upright. Comes from the parser, never derived from the page's /Rotate. */
  r?: number;
}
export interface Word {
  text: string; start: number; end: number; // start/end: offsets into page.text
  box: Box;
  /** Which visual line of the page the parser put the word on (parser's own numbering). Absent when the parser doesn't say. */
  line?: number;
}
export interface ParsedPage {
  page: number; width: number; height: number; text: string; words: Word[];
  /** False when the parser could not read this page's positions. The page then has no text and no words. */
  positionsOk?: boolean;
  positionsError?: string;
}
export interface ParsedDocument {
  parser: 'fixture' | 'pdfjs' | 'llamaparse';
  tier?: string;
  /** What the parser's version resolved to (LlamaParse: metadata.version), when it says. */
  version?: string;
  pageCount: number;
  pages: ParsedPage[];
  creditsEstimate?: number;
}

export interface Parser { parse(file: Uint8Array, opts: { tier?: string; filename: string }): Promise<ParsedDocument> }

export interface ExtractRequest {
  instructions: string; // service-specific
  schema: object; // JSON Schema for the tool input
  pages: { file: string; page: number; text: string }[];
}
export interface ExtractResult { output: unknown; model: string; usage: { input: number; output: number } }
export interface Extractor { extract(req: ExtractRequest): Promise<ExtractResult> }
