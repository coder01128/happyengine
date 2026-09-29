// One made-up contract, end to end through contracts-process on the LOCAL Supabase stack, with the real
// LlamaParse (EU). Proves: the file is sent, the pages and word positions are stored, the raw sidecar
// lands in the private parse-artifacts bucket, and no client can reach it. Also prints what the job says
// about its version and credits (names and values of those two fields only; never a key).
//
// Needs: `supabase start`, and `supabase functions serve` started with PARSER=llamaparse and the LlamaParse
// key in its environment. Costs LlamaParse credits (a 5-page contract at the cost-effective tier: about 15).
// Usage: node scripts/live-parse-check.ts [pdf under eval/contracts/demo-marula, default c2-subscription.pdf]

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadSecrets } from './env.ts';
import { localKeys, noSession, root } from './local.ts';

loadSecrets();
const { url, anon, service } = localKeys();
const admin = createClient(url, service, noSession);
const filename = process.argv[2] ?? 'c2-subscription.pdf';
const stamp = Date.now().toString(36);

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
};
async function must<R extends { data: unknown; error: unknown }>(p: PromiseLike<R>, what: string) {
  const { data, error } = await p;
  if (error || data == null) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<R['data']>;
}

const created = { org: '', user: '', paths: [] as string[], artifacts: [] as string[] };

async function main() {
  const org = await must(admin.from('orgs').insert({ name: 'Live parse check (sample)', offshore_processing_approved: true }).select().single(), 'org');
  created.org = org.id;
  const email = `live-${stamp}@happyengine.test`;
  const password = randomBytes(18).toString('base64url');
  const { user } = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), 'user');
  created.user = user!.id;
  await must(admin.from('memberships').insert({ org_id: org.id, user_id: user!.id, role: 'uploader' }).select(), 'membership');
  const client = createClient(url, anon, noSession);
  const { session } = await must(client.auth.signInWithPassword({ email, password }), 'sign in');
  const preset = JSON.parse(readFileSync(join(root, 'presets', 'contracts.default.json'), 'utf8'));
  const presetRow = await must(admin.from('presets').insert({ org_id: org.id, service: 'contracts', version: 1, config: preset }).select().single(), 'preset');

  const agreement = await must(client.from('agreements').insert({ org_id: org.id, preset_id: presetRow.id, title: 'Live parse check (sample)', created_by: user!.id }).select().single(), 'agreement');
  const path = `${org.id}/${agreement.id}/${filename}`;
  const pdf = readFileSync(join(root, 'eval', 'contracts', 'demo-marula', filename));
  const up = await client.storage.from('documents').upload(path, pdf, { contentType: 'application/pdf' });
  created.paths.push(path);
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const file = await must(client.from('agreement_files').insert({ org_id: org.id, agreement_id: agreement.id, ord: 1, role: 'main', storage_path: path, filename, uploaded_by: user!.id }).select().single(), 'file');

  const call = async () => {
    const res = await fetch(`${url}/functions/v1/contracts-process`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session!.access_token}`, apikey: anon, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agreementId: agreement.id }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as { status?: string; error?: string } | null };
  };

  console.log(`\nSending ${filename} through contracts-process (PARSER must be llamaparse in the served functions)…`);
  let last = await call();
  check('first call sends the file to LlamaParse: status parsing', last.status === 200 && last.body?.status === 'parsing', last);
  const started = Date.now();
  while (last.body?.status === 'parsing' && Date.now() - started < 4 * 60_000) {
    await new Promise((r) => setTimeout(r, 3000));
    last = await call();
  }
  console.log(`  … ${Math.round((Date.now() - started) / 1000)} s from first poll to the last`);
  check('the file is read: status parsed', last.body?.status === 'parsed', last);
  if (last.body?.status !== 'parsed') return;

  const f = await must(admin.from('agreement_files').select('*').eq('id', file.id).single(), 'file row');
  console.log('\nWhat was recorded on the file:');
  console.log(`  parser=${f.parser} tier=${f.parser_tier} pages=${f.page_count} version=${f.parser_version ?? '(not reported)'} credits used=${f.parse_credits ?? '(not reported)'}`);
  check('parser is llamaparse (not the saved fixture)', f.parser === 'llamaparse', f.parser);

  const pages = await must(admin.from('parsed_pages').select('page, width, height, positions_ok, words').eq('file_id', file.id).order('page'), 'pages');
  check(`${f.page_count} pages stored with word positions`, pages.length === f.page_count && pages.every((p) => p.positions_ok && (p.words as unknown[]).length > 0), pages.map((p) => [p.page, p.positions_ok]));
  console.log(`  page size ${pages[0]!.width} × ${pages[0]!.height}; page 1 has ${(pages[0]!.words as unknown[]).length} words`);

  // The sidecar, in the real bucket.
  check('sidecar path recorded on the file', f.sidecar_path === `${org.id}/${agreement.id}/${file.id}/grounding.jsonl`, f.sidecar_path);
  if (f.sidecar_path) {
    created.artifacts.push(f.sidecar_path);
    const dl = await admin.storage.from('parse-artifacts').download(f.sidecar_path);
    check('sidecar object exists in the parse-artifacts bucket', !dl.error && !!dl.data, dl.error);
    const text = dl.data ? await dl.data.text() : '';
    const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as { page_number: number; success: boolean; page_width: number });
    console.log(`  sidecar: ${text.length} bytes, ${rows.length} lines`);
    check('one JSONL line per page, all readable', rows.length === f.page_count && rows.every((r) => r.success === true), rows.map((r) => [r.page_number, r.success]));
    check('sidecar page numbers match the stored pages', JSON.stringify(rows.map((r) => r.page_number).sort()) === JSON.stringify(pages.map((p) => p.page)));
    const stored = await admin.from('parsed_pages').select('page, width').eq('file_id', file.id);
    check('sidecar page sizes match the stored page sizes', rows.every((r) => stored.data?.find((p) => p.page === r.page_number)?.width === r.page_width));
    const asClient = await client.storage.from('parse-artifacts').download(f.sidecar_path);
    check('the uploader cannot read the sidecar', !!asClient.error, asClient);
  }

  const ev = await must(admin.from('timeline_events').select('event, detail').eq('agreement_id', agreement.id).order('id'), 'timeline');
  console.log(`\nTimeline: ${ev.map((e) => e.event).join(' → ')}`);
  console.log(`  parse_submitted: ${JSON.stringify(ev.find((e) => e.event === 'parse_submitted')?.detail)}`);
  console.log(`  parsed: ${JSON.stringify(ev.find((e) => e.event === 'parsed')?.detail)}`);
  check('timeline: file received, sent, parsed', JSON.stringify(ev.map((e) => e.event)) === JSON.stringify(['file_received', 'parse_submitted', 'parsed']));

  // What the job itself says about version and usage: the shape the docs don't give.
  console.log('\nWhat LlamaParse reports for this job (metadata and usage only):');
  const base = (process.env.LLAMA_CLOUD_BASE_URL || 'https://api.cloud.eu.llamaindex.ai').replace(/\/+$/, '');
  for (const expand of ['items,metadata,usage', 'items']) {
    const res = await fetch(`${base}/api/v2/parse/${encodeURIComponent(f.parse_job_id)}?expand=${expand}`, { headers: { Authorization: `Bearer ${process.env.LLAMA_CLOUD_API_KEY}` } });
    const body: any = await res.json().catch(() => null);
    console.log(`  expand=${expand} → HTTP ${res.status}; top-level keys: ${body ? Object.keys(body).join(', ') : '(not JSON)'}`);
    if (res.ok && body) {
      console.log(`    metadata: ${JSON.stringify(body.metadata)?.slice(0, 400)}`);
      console.log(`    usage: ${JSON.stringify(body.usage)?.slice(0, 400)}`);
      console.log(`    job keys: ${Object.keys(body.job ?? {}).join(', ')}`);
    } else console.log(`    error: ${JSON.stringify(body)?.slice(0, 300)}`);
  }
}

async function cleanup() {
  if (created.paths.length) await admin.storage.from('documents').remove(created.paths);
  if (created.artifacts.length) await admin.storage.from('parse-artifacts').remove(created.artifacts);
  if (created.org) await admin.from('orgs').delete().eq('id', created.org);
  if (created.user) await admin.auth.admin.deleteUser(created.user);
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(`\n  FAIL  ${(err as Error).message}`);
} finally {
  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed (test data removed)');
  process.exit(failures ? 1 : 0);
}
