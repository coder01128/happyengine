export type ParserErrorCode = 'no_text_layer' | 'auth' | 'credits' | 'failed' | 'bad_response' | 'too_many_pages';

export class ParserError extends Error {
  readonly code: ParserErrorCode;
  constructor(code: ParserErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ParserError';
    this.code = code;
  }
}

export class ExtractorError extends Error {
  /** The raw API response, kept for debugging. Never repaired or guessed from. */
  readonly raw?: unknown;
  constructor(message: string, raw?: unknown) {
    super(message);
    this.name = 'ExtractorError';
    this.raw = raw;
  }
}

/** Thrown by the live (offshore) adapters when the organisation hasn't been approved for offshore processing. */
export class OffshoreNotApproved extends Error {
  constructor(service: string) {
    super(`${service}: offshore processing is not approved for this organisation. Nothing was sent.`);
    this.name = 'OffshoreNotApproved';
  }
}

export function requireOffshore(allowed: boolean, service: string): void {
  if (allowed !== true) throw new OffshoreNotApproved(service);
}
