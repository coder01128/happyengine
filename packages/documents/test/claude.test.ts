import { describe, expect, it } from 'vitest';
import { createClaudeExtractor, createFixtureExtractor, ExtractorError, OffshoreNotApproved, pagesMessage, type ExtractRequest } from '../src/index.ts';

const req: ExtractRequest = {
  instructions: 'Extract the fee.',
  schema: { type: 'object', properties: { fee: { type: 'object' } }, required: ['fee'] },
  pages: [
    { file: 'c2-subscription.pdf', page: 1, text: '5 · Subscription Fee R4 850.00 per month' },
    { file: 'c2-subscription.pdf', page: 2, text: 'Master subscription terms' },
  ],
};
const toolOutput = { fee: { value: 485000, quote: 'R4 850.00 per month', file: 'c2-subscription.pdf', page: 1 } };
const message = (content: unknown[], extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ model: 'claude-test-model', stop_reason: 'tool_use', content, usage: { input_tokens: 120, output_tokens: 40 }, ...extra }), { status: 200 });
const toolUse = (input: unknown) => ({ type: 'tool_use', id: 'toolu_1', name: 'record_extraction', input });

function mockFetch(responses: Response[]) {
  const bodies: Record<string, any>[] = [];
  const headers: Record<string, string>[] = [];
  const fn = (async (_url: string | URL | Request, init: RequestInit = {}) => {
    bodies.push(JSON.parse(String(init.body)));
    headers.push(init.headers as Record<string, string>);
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  }) as typeof fetch;
  return { fn, bodies, headers };
}
const make = (fetchFn: typeof fetch, extra = {}) =>
  createClaudeExtractor({ apiKey: 'sk-test', model: 'claude-test-model', offshoreAllowed: true, fetch: fetchFn, retryDelayMs: 0, ...extra });

describe('claude extractor', () => {
  it('sends the pages, instructions and schema, and returns the tool input', async () => {
    const m = mockFetch([message([toolUse(toolOutput)])]);
    const result = await make(m.fn).extract(req);
    expect(result).toEqual({ output: toolOutput, model: 'claude-test-model', usage: { input: 120, output: 40 } });

    const body = m.bodies[0]!;
    expect(m.headers[0]).toMatchObject({ 'x-api-key': 'sk-test', 'anthropic-version': '2023-06-01' });
    expect(body.model).toBe('claude-test-model');
    expect(body).not.toHaveProperty('temperature');
    expect(body.tools).toEqual([expect.objectContaining({ name: 'record_extraction', input_schema: req.schema })]);
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.system).toMatch(/^Extract the fee\./);
    expect(body.system).toMatch(/character for character/);
    expect(body.messages[0].content).toBe(pagesMessage(req.pages));
    expect(body.messages[0].content).toContain('<page file="c2-subscription.pdf" n="1">\n5 · Subscription Fee R4 850.00 per month\n</page>');
  });

  it('sends a temperature only when one is set', async () => {
    const m = mockFetch([message([toolUse(toolOutput)])]);
    await make(m.fn, { temperature: 0 }).extract(req);
    expect(m.bodies[0]!.temperature).toBe(0);
  });

  it('retries once when the API is overloaded', async () => {
    const m = mockFetch([new Response('{"type":"error","error":{"type":"overloaded_error"}}', { status: 529 }), message([toolUse(toolOutput)])]);
    expect((await make(m.fn).extract(req)).output).toEqual(toolOutput);
    expect(m.bodies).toHaveLength(2);
  });

  it('gives up after one retry', async () => {
    const m = mockFetch([new Response('{}', { status: 429 }), new Response('{"error":{"type":"rate_limit_error"}}', { status: 429 })]);
    await expect(make(m.fn).extract(req)).rejects.toThrow(/429/);
    expect(m.bodies).toHaveLength(2);
  });

  it('explains a bad key', async () => {
    const m = mockFetch([new Response('{"error":{"type":"authentication_error"}}', { status: 401 })]);
    await expect(make(m.fn).extract(req)).rejects.toThrow('Anthropic key missing or wrong');
  });

  it('fails without guessing when the tool is not called, keeping the raw response', async () => {
    const m = mockFetch([message([{ type: 'text', text: 'The fee is R4 850.00.' }], { stop_reason: 'end_turn' })]);
    const err = await make(m.fn).extract(req).catch((e) => e);
    expect(err).toBeInstanceOf(ExtractorError);
    expect(err.message).toMatch(/Expected one record_extraction call, got 0/);
    expect(err.raw.content[0].text).toBe('The fee is R4 850.00.');
  });

  it('fails on malformed or incomplete tool input', async () => {
    await expect(make(mockFetch([message([toolUse('not an object')])]).fn).extract(req)).rejects.toThrow(/not an object/);
    await expect(make(mockFetch([message([toolUse({ other: 1 })])]).fn).extract(req)).rejects.toThrow(/missing fee/);
    await expect(make(mockFetch([message([toolUse(toolOutput)], { stop_reason: 'max_tokens' })]).fn).extract(req)).rejects.toThrow(/incomplete/);
    await expect(make(mockFetch([message([], { stop_reason: 'refusal' })]).fn).extract(req)).rejects.toThrow(/declined/);
  });

  it('needs a model from the environment', () => {
    expect(() => createClaudeExtractor({ apiKey: 'sk-test', model: '', offshoreAllowed: true })).toThrow(/ANTHROPIC_MODEL/);
  });

  it('refuses to run for an organisation not approved for offshore processing', () => {
    expect(() => createClaudeExtractor({ apiKey: 'sk-test', model: 'claude-test-model', offshoreAllowed: false })).toThrow(OffshoreNotApproved);
  });
});

describe('fixture extractor', () => {
  it('returns the saved output', async () => {
    expect(await createFixtureExtractor(toolOutput).extract(req)).toEqual({ output: toolOutput, model: 'fixture', usage: { input: 0, output: 0 } });
  });
});
