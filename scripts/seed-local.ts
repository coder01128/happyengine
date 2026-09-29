// Seeds the LOCAL stack with a sample organisation for trying the review screen:
//   - "Marula Office Supplies (sample)" with the default Month-End preset
//   - a reviewer and an uploader (test users; passwords generated, written to .local/dev-users.json)
//   - two matched runs: the demo brief's September month, and a messy synthetic July month
//     (suggested matches, a split deposit, a duplicate, an old uncleared cheque)
//   - app/.env.local with the local API URL and anon key
//
// Usage: npm run seed            (does nothing if already seeded)
//        npm run seed -- --reset (deletes the sample organisation and its users, then seeds again)

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { localKeys, noSession, root } from './local.ts';

const ORG_NAME = 'Marula Office Supplies (sample)';
const USERS = [
  { email: 'reviewer@marula.test', role: 'reviewer' },
  { email: 'uploader@marula.test', role: 'uploader' },
] as const;

const { url, anon, service } = localKeys();
const admin = createClient(url, service, noSession);
const reset = process.argv.includes('--reset');
const readJson = (...p: string[]) => JSON.parse(readFileSync(join(root, ...p), 'utf8'));

async function must<R extends { data: unknown; error: unknown }>(p: PromiseLike<R>, what: string) {
  const { data, error } = await p;
  if (error || data == null) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<R['data']>;
}

async function removeExisting() {
  const orgs = await must(admin.from('orgs').select('id').eq('name', ORG_NAME), 'find org');
  for (const org of orgs) {
    const { data: docs } = await admin.from('documents').select('storage_path').eq('org_id', org.id);
    if (docs?.length) await admin.storage.from('documents').remove(docs.map((d) => d.storage_path));
    await must(admin.from('orgs').delete().eq('id', org.id).select(), 'delete org');
  }
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const u of list?.users ?? []) {
    if (USERS.some((x) => x.email === u.email)) await admin.auth.admin.deleteUser(u.id);
  }
  return orgs.length;
}

async function seedRun(opts: {
  orgId: string;
  presetId: string;
  uploader: { id: string; token: string; client: SupabaseClient };
  label: string;
  sample: string;
}) {
  const sample = readJson('eval', 'month-end', opts.sample, 'sample.json');
  const run = await must(
    opts.uploader.client
      .from('runs')
      .insert({
        org_id: opts.orgId,
        label: opts.label,
        period_end: sample.periodEnd,
        opening_bank: sample.opening.bank,
        opening_ledger: sample.opening.ledger,
        preset_id: opts.presetId,
        created_by: opts.uploader.id,
      })
      .select()
      .single(),
    `create run ${opts.label}`,
  );
  for (const side of ['bank', 'ledger'] as const) {
    const path = `${opts.orgId}/${run.id}/${side}.csv`;
    const file = readFileSync(join(root, 'eval', 'month-end', opts.sample, `${side}.csv`));
    const up = await opts.uploader.client.storage.from('documents').upload(path, file, { contentType: 'text/csv' });
    if (up.error) throw new Error(`upload ${side}: ${up.error.message}`);
    await must(
      opts.uploader.client
        .from('documents')
        .insert({ org_id: opts.orgId, run_id: run.id, side, storage_path: path, filename: `${side}.csv`, uploaded_by: opts.uploader.id })
        .select(),
      `document ${side}`,
    );
  }
  const res = await fetch(`${url}/functions/v1/run-matching`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${opts.uploader.token}`, apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId: run.id }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`run-matching ${opts.label}: ${res.status} ${JSON.stringify(body)} (is \`supabase functions serve\` running?)`);
  console.log(`  ${opts.label}: ${body.matched} matched, exceptions ${JSON.stringify(body.exceptions)}`);
}

async function main() {
  const existing = await must(admin.from('orgs').select('id').eq('name', ORG_NAME), 'find org');
  if (existing.length && !reset) {
    console.log(`Already seeded. Sign-in details are in .local/dev-users.json. Use "npm run seed -- --reset" to start over.`);
    return;
  }
  if (reset) console.log(`Removed ${await removeExisting()} existing sample organisation(s).`);

  const defaultPreset = readJson('presets', 'month-end.default.json');
  const org = await must(admin.from('orgs').insert({ name: ORG_NAME }).select().single(), 'org');
  const preset = await must(
    admin.from('presets').insert({ org_id: org.id, service: 'month_end', version: 1, config: defaultPreset }).select().single(),
    'preset',
  );
  // The synthetic sample's bank export uses a different layout: an inactive preset version for it.
  const messy = readJson('eval', 'month-end', 'synth-messy-31', 'sample.json');
  const messyPreset = await must(
    admin
      .from('presets')
      .insert({
        org_id: org.id,
        service: 'month_end',
        version: 2,
        active: false,
        config: { ...defaultPreset, sources: messy.sources, matching: { ...defaultPreset.matching, ...messy.matching } },
      })
      .select()
      .single(),
    'messy preset',
  );

  const credentials: { email: string; password: string; role: string }[] = [];
  const people: Record<string, { id: string; token: string; client: SupabaseClient }> = {};
  for (const u of USERS) {
    const password = randomBytes(12).toString('base64url');
    const { user } = await must(admin.auth.admin.createUser({ email: u.email, password, email_confirm: true }), `user ${u.email}`);
    if (!user) throw new Error(`user ${u.email}: none returned`);
    await must(admin.from('memberships').insert({ org_id: org.id, user_id: user.id, role: u.role }).select(), 'membership');
    const client = createClient(url, anon, noSession);
    const { session } = await must(client.auth.signInWithPassword({ email: u.email, password }), `sign in ${u.email}`);
    if (!session) throw new Error(`sign in ${u.email}: no session`);
    people[u.role] = { id: user.id, token: session.access_token, client };
    credentials.push({ email: u.email, password, role: u.role });
  }

  console.log('Runs:');
  await seedRun({ orgId: org.id, presetId: preset.id, uploader: people.uploader!, label: 'Business current account — Sep 2026 (sample)', sample: 'demo-marula' });
  await seedRun({ orgId: org.id, presetId: messyPreset.id, uploader: people.uploader!, label: 'Business current account — Jul 2026 (synthetic)', sample: 'synth-messy-31' });

  mkdirSync(join(root, '.local'), { recursive: true });
  writeFileSync(
    join(root, '.local', 'dev-users.json'),
    JSON.stringify({ note: 'Local test users only. Regenerated by npm run seed -- --reset.', users: credentials }, null, 2) + '\n',
  );
  const envPath = join(root, 'app', '.env.local');
  writeFileSync(envPath, `VITE_SUPABASE_URL=${url}\nVITE_SUPABASE_ANON_KEY=${anon}\n`);
  console.log(`\nSign-in details: .local/dev-users.json${existsSync(envPath) ? '\nApp settings:    app/.env.local' : ''}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
