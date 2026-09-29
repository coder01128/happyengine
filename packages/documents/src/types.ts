// Shapes shared by every parser, the extractor and the quote check. Nothing here knows about any service.

/** Box in the page's own units, top-left origin. Viewers scale by (x / page.width) × rendered width,
 *  so the unit (points or pixels) never matters as long as box and page use the same one. */
export interface Box { x: number; y: number; w: number; h: number }
export interface Word { text: string; start: number; end: number; box: Box } // start/end: offsets into page.text
export interface ParsedPage { page: number; width: number; height: number; text: string; words: Word[] }
export interface ParsedDocument {
  parser: 'fixture' | 'pdfjs' | 'llamaparse';
  tier?: string;
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
