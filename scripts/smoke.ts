// End-to-end check against the LOCAL Supabase stack (never a hosted project).
// Creates two throwaway organisations and test users, runs the demo month through upload →
// matching → review → approval, checks that organisation B can't see or touch A's data, checks
// the timeline can't be edited, then deletes everything it created.
//
// Usage (with `supabase start` running): npm run smoke

import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { localKeys, noSession, root } from './local.ts';

const { url, anon, service } = localKeys();
const admin = createClient(url, service, noSession);

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? '  ok  ' : '  FAIL'}  ${name}${!ok && detail !== undefined ? `  → ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures++;
}
async function must<R extends { data: unknown; error: unknown }>(p: PromiseLike<R>, what: string) {
  const { data, error } = await p;
  if (error || data == null) throw new Error(`${what}: ${JSON.stringify(error)}`);
  return data as NonNullable<R['data']>;
}

interface Person {
  id: string;
  client: SupabaseClient;
  token: string;
}
const created = { orgs: [] as string[], users: [] as string[], paths: [] as string[] };
const stamp = Date.now().toString(36);

async function person(label: string, orgId: string, role: 'uploader' | 'reviewer' | 'admin'): Promise<Person> {
  const email = `${label}-${stamp}@happyengine.test`;
  const password = randomBytes(18).toString('base64url'); // throwaway, never printed
  const { user } = await must(admin.auth.admin.createUser({ email, password, email_confirm: true }), `create ${label}`);
  if (!user) throw new Error(`create ${label}: no user returned`);
  created.users.push(user.id);
  await must(admin.from('memberships').insert({ org_id: orgId, user_id: user.id, role }).select(), `membership ${label}`);
  const client = createClient(url, anon, noSession);
  const { session } = await must(client.auth.signInWithPassword({ email, password }), `sign in ${label}`);
  if (!session) throw new Error(`sign in ${label}: no session returned`);
  return { id: user.id, client, token: session.access_token };
}

async function call(p: Person, fn: string, runId: string) {
  const res = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p.token}`, apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function main() {
  const preset = JSON.parse(readFileSync(join(root, 'presets', 'month-end.default.json'), 'utf8'));
  const orgA = await must(admin.from('orgs').insert({ name: 'Smoke test A (sample)' }).select().single(), 'org A');
  const orgB = await must(admin.from('orgs').insert({ name: 'Smoke test B (sample)' }).select().single(), 'org B');
  created.orgs.push(orgA.id, orgB.id);
  const presetA = await must(
    admin.from('presets').insert({ org_id: orgA.id, service: 'month_end', version: 1, config: preset }).select().single(),
    'preset A',
  );

  const uploader = await person('uploader-a', orgA.id, 'uploader');
  const reviewer = await person('reviewer-a', orgA.id, 'reviewer');
  const outsider = await person('reviewer-b', orgB.id, 'reviewer');

  console.log('\nUpload');
  const run = await must(
    uploader.client
      .from('runs')
      .insert({
        org_id: orgA.id,
        label: 'Business current account — Sep 2026 (sample)',
        period_end: '2026-09-30',
        opening_bank: 18_425_000,
        opening_ledger: 18_425_000,
        preset_id: presetA.id,
        created_by: uploader.id,
      })
      .select()
      .single(),
    'create run',
  );
  check('uploader creates a draft run', run.status === 'draft');
  for (const side of ['bank', 'ledger'] as const) {
    const path = `${orgA.id}/${run.id}/${side}.csv`;
    const file = readFileSync(join(root, 'eval', 'month-end', 'demo-marula', `${side}.csv`));
    const up = await uploader.client.storage.from('documents').upload(path, file, { contentType: 'text/csv' });
    created.paths.push(path);
    check(`uploader uploads ${side}.csv`, !up.error, up.error);
    const doc = await uploader.client
      .from('documents')
      .insert({ org_id: orgA.id, run_id: run.id, side, storage_path: path, filename: `${side}.csv`, uploaded_by: uploader.id });
    check(`uploader records ${side} document`, !doc.error, doc.error);
  }

  console.log('\nOrganisation isolation (B against A)');
  const seen = await outsider.client.from('runs').select('id').eq('id', run.id);
  check('B cannot see A’s run', !seen.error && seen.data?.length === 0, seen);
  const dl = await outsider.client.storage.from('documents').download(`${orgA.id}/${run.id}/bank.csv`);
  check('B cannot download A’s statement', !!dl.error);
  const up = await outsider.client.storage.from('documents').upload(`${orgA.id}/${run.id}/x.csv`, 'x', { contentType: 'text/csv' });
  check('B cannot upload into A’s folder', !!up.error);
  const ins = await outsider.client.from('runs').insert({
    org_id: orgA.id, label: 'x', period_end: '2026-09-30', opening_bank: 0, opening_ledger: 0, preset_id: presetA.id, created_by: outsider.id,
  });
  check('B cannot create a run in A', !!ins.error);
  const bMatch = await call(outsider, 'run-matching', run.id);
  check('B calling run-matching on A’s run gets 404', bMatch.status === 404, bMatch);

  console.log('\nMatching');
  const m = await call(uploader, 'run-matching', run.id);
  check('run-matching returns 200', m.status === 200, m);
  check('9 matched', m.body?.matched === 9, m.body);
  check(
    'exceptions: 1 amount difference, 1 possible duplicate, 2 timing, 2 not in ledger',
    JSON.stringify(Object.entries(m.body?.exceptions ?? {}).sort()) ===
      JSON.stringify([['amount_difference', 1], ['not_in_ledger', 2], ['possible_duplicate', 1], ['timing', 2]]),
    m.body?.exceptions,
  );
  check('2 proposed journals', m.body?.journals === 2, m.body);

  const excs = await must(reviewer.client.from('exceptions').select('id, type').eq('run_id', run.id), 'exceptions');
  const amountDiff = excs.find((e) => e.type === 'amount_difference')!.id;
  const dup = excs.find((e) => e.type === 'possible_duplicate')!.id;
  const bSees = await outsider.client.from('exceptions').select('id').eq('run_id', run.id);
  check('B cannot see A’s exceptions', bSees.data?.length === 0, bSees);
  const bDecide = await outsider.client.rpc('record_decision', { p_exception_id: amountDiff, p_option_id: 'short_paid' });
  check('B cannot decide on A’s exception', !!bDecide.error);

  console.log('\nReview');
  const blocked = await call(reviewer, 'approve-run', run.id);
  check(
    'approval refused while items are open',
    blocked.status === 409 && blocked.body?.error === '4 items still open: 2 journals, 2 differences.',
    blocked,
  );
  const upDecide = await uploader.client.rpc('record_decision', { p_exception_id: amountDiff, p_option_id: 'short_paid' });
  check('uploader cannot record decisions', !!upDecide.error);
  const noNote = await reviewer.client.rpc('record_decision', { p_exception_id: amountDiff, p_option_id: 'other' });
  check('"Other" without a note is refused', !!noNote.error && /note is required/i.test(noNote.error.message), noNote.error);
  const badOption = await reviewer.client.rpc('record_decision', { p_exception_id: amountDiff, p_option_id: 'confirmed' });
  check('an option from another exception type is refused', !!badOption.error);

  const d1 = await reviewer.client.rpc('record_decision', { p_exception_id: amountDiff, p_option_id: 'short_paid' });
  const d2 = await reviewer.client.rpc('record_decision', { p_exception_id: dup, p_option_id: 'confirmed' });
  check('reviewer records both decisions', !d1.error && !d2.error, [d1.error, d2.error]);
  const journals = await must(reviewer.client.from('journals').select('id').eq('run_id', run.id), 'journals');
  const j1 = await reviewer.client.rpc('approve_journal', { p_journal_id: journals[0]!.id });
  const partial = await call(reviewer, 'approve-run', run.id);
  check('helper text with one journal left', partial.body?.error === '1 item still open: 1 journal.', partial.body);
  const j2 = await reviewer.client.rpc('approve_journal', { p_journal_id: journals[1]!.id });
  check('reviewer approves both journals', !j1.error && !j2.error, [j1.error, j2.error]);

  console.log('\nApproval');
  const ok = await call(reviewer, 'approve-run', run.id);
  check('approve-run returns 200 at R0.00', ok.status === 200 && ok.body?.panel?.difference === 0, ok);
  const after = await must(reviewer.client.from('runs').select('status, approved_by').eq('id', run.id).single(), 'run');
  check('run is approved by the reviewer', after.status === 'approved' && after.approved_by === reviewer.id, after);
  const checklist = await must(
    reviewer.client.from('checklist_items').select('item_key, status').eq('run_id', run.id).order('position'),
    'checklist',
  );
  check(
    'bank reconciliation task is done; the rest of the close stays open',
    checklist.find((c) => c.item_key === 'bank_rec')?.status === 'done' &&
      checklist.filter((c) => c.status === 'done').length === 1 &&
      checklist.length === 7,
    checklist,
  );
  const late = await reviewer.client.rpc('record_decision', { p_exception_id: dup, p_option_id: 'not_duplicate' });
  check('decisions are closed after approval', !!late.error);
  const rematch = await call(uploader, 'run-matching', run.id);
  check('re-matching is refused after approval', rematch.status === 409, rematch);

  console.log('\nTimeline');
  const events = await must(
    reviewer.client.from('timeline_events').select('event').eq('run_id', run.id).order('id'),
    'timeline',
  );
  check(
    'every step recorded in order',
    JSON.stringify(events.map((e) => e.event)) ===
      JSON.stringify([
        'document_received', 'document_received', 'matching_run',
        'decision_recorded', 'decision_recorded', 'journal_approved', 'journal_approved', 'reconciliation_approved',
      ]),
    events.map((e) => e.event),
  );
  const edit = await admin.from('timeline_events').update({ event: 'tampered' }).eq('run_id', run.id).select();
  check('timeline cannot be edited, even with the service role', !!edit.error, edit);
  const del = await admin.from('timeline_events').delete().eq('run_id', run.id).select();
  check('timeline cannot be deleted row by row', !!del.error, del);

  console.log('\nSplit suggestion (one deposit paying two invoices)');
  const run2 = await must(
    uploader.client
      .from('runs')
      .insert({
        org_id: orgA.id,
        label: 'Split test — Aug 2026 (sample)',
        period_end: '2026-08-31',
        opening_bank: 0,
        opening_ledger: 0,
        preset_id: presetA.id,
        created_by: uploader.id,
      })
      .select()
      .single(),
    'create split run',
  );
  const files = {
    bank: 'Date,Description,Reference,Amount\n12/08/2026,IB PAYMENT FROM KGOSI LOGISTICS INV4012 4013,,18350.50\n',
    ledger:
      'Date,Reference,Description,Receipts,Payments\n' +
      '10/08/2026,INV-4012,Receipt — Kgosi Logistics,12000.00,\n' +
      '10/08/2026,INV-4013,Receipt — Kgosi Logistics,6350.50,\n',
  };
  for (const side of ['bank', 'ledger'] as const) {
    const path = `${orgA.id}/${run2.id}/${side}.csv`;
    await uploader.client.storage.from('documents').upload(path, files[side], { contentType: 'text/csv' });
    created.paths.push(path);
    await uploader.client
      .from('documents')
      .insert({ org_id: orgA.id, run_id: run2.id, side, storage_path: path, filename: `${side}.csv`, uploaded_by: uploader.id });
  }
  const m2 = await call(uploader, 'run-matching', run2.id);
  check('matching suggests one split and nothing else', JSON.stringify(m2.body?.exceptions) === '{"suggested_split":1}', m2);
  const parts = await reviewer.client.from('exception_parts').select('line_id').eq('run_id', run2.id);
  check('both cash book entries stored as parts of the split', parts.data?.length === 2, parts);
  const bParts = await outsider.client.from('exception_parts').select('line_id').eq('run_id', run2.id);
  check('B cannot see A’s split parts', bParts.data?.length === 0, bParts);
  const blocked2 = await call(reviewer, 'approve-run', run2.id);
  check('approval refused until the split is decided', blocked2.body?.error === '1 item still open: 1 suggested match.', blocked2);
  const split = await must(reviewer.client.from('exceptions').select('id').eq('run_id', run2.id).single(), 'split');
  const confirm = await reviewer.client.rpc('record_decision', { p_exception_id: split.id, p_option_id: 'confirm' });
  check('reviewer confirms the split', !confirm.error, confirm.error);
  const ok2 = await call(reviewer, 'approve-run', run2.id);
  check('approved at R0.00 after confirming', ok2.status === 200 && ok2.body?.panel?.difference === 0, ok2);

  await contracts(orgA.id, orgB.id, uploader, reviewer, outsider);
}

// Contracts tables: clients create agreements and attach files; pipeline output is written here with
// the service role (the edge functions that write it come later). B must see none of A's rows.
async function contracts(orgA: string, orgB: string, uploader: Person, reviewer: Person, outsider: Person) {
  console.log('\nContracts tables (B against A)');
  const cPreset = JSON.parse(readFileSync(join(root, 'presets', 'contracts.default.json'), 'utf8'));
  const presetA = await must(
    admin.from('presets').insert({ org_id: orgA, service: 'contracts', version: 1, config: cPreset }).select().single(),
    'contracts preset A',
  );
  const agreement = await uploader.client
    .from('agreements')
    .insert({ org_id: orgA, preset_id: presetA.id, title: 'Accounting software subscription (sample)', created_by: uploader.id })
    .select()
    .single();
  check('uploader creates an agreement', !agreement.error && agreement.data?.status === 'uploaded', agreement.error);
  const agreementId: string = agreement.data!.id;

  const path = `${orgA}/${agreementId}/c2-subscription.pdf`;
  const pdf = readFileSync(join(root, 'eval', 'contracts', 'demo-marula', 'c2-subscription.pdf'));
  const up = await uploader.client.storage.from('documents').upload(path, pdf, { contentType: 'application/pdf' });
  created.paths.push(path);
  check('uploader uploads the agreement PDF', !up.error, up.error);
  const file = await uploader.client
    .from('agreement_files')
    .insert({ org_id: orgA, agreement_id: agreementId, ord: 1, role: 'main', storage_path: path, filename: 'c2-subscription.pdf', uploaded_by: uploader.id })
    .select()
    .single();
  check('uploader attaches the file', !file.error, file.error);
  const fileId: string = file.data!.id;

  const pages = await uploader.client
    .from('parsed_pages')
    .insert({ org_id: orgA, file_id: fileId, page: 1, width: 595.9, height: 842.9, text: 'x' });
  check('a client cannot write parsed pages', !!pages.error);

  // Pipeline output, written with the service role.
  await must(admin.from('parsed_pages').insert({ org_id: orgA, file_id: fileId, page: 1, width: 595.9, height: 842.9, text: 'Order form' }).select(), 'page');
  await must(
    admin.from('agreement_fields').insert({ org_id: orgA, agreement_id: agreementId, key: 'fee', values: [{ value: { cents: 485000 } }], status: 'recorded' }).select(),
    'field',
  );
  await must(
    admin.from('key_dates').insert({ org_id: orgA, agreement_id: agreementId, key: 'renewal', label: 'Renewal date', date: '2027-03-01' }).select(),
    'key date',
  );
  await must(
    admin.from('review_items').insert({ org_id: orgA, agreement_id: agreementId, kind: 'unclear', field_key: 'feeChange', summary: 'Fee change on renewal not quantified' }).select(),
    'review item',
  );
  await must(admin.from('reminder_drafts').insert({ org_id: orgA, as_at: '2026-10-14', body: 'No contract dates.' }).select(), 'reminder draft');

  const tables = ['agreements', 'agreement_files', 'parsed_pages', 'agreement_fields', 'key_dates', 'review_items', 'reminder_drafts'] as const;
  for (const t of tables) {
    const own = await reviewer.client.from(t).select('id').eq('org_id', orgA);
    const other = await outsider.client.from(t).select('id').eq('org_id', orgA);
    check(`A reads its ${t.replace('_', ' ')}; B sees none`, own.data?.length === 1 && !other.error && other.data?.length === 0, { own, other });
  }

  const bInsert = await outsider.client
    .from('agreements')
    .insert({ org_id: orgA, preset_id: presetA.id, title: 'x', created_by: outsider.id });
  check('B cannot create an agreement in A', !!bInsert.error);
  const bDelete = await outsider.client.from('agreements').delete().eq('id', agreementId).select();
  check('B cannot delete A’s agreement', bDelete.data?.length === 0, bDelete);
  const monthEndPreset = await must(admin.from('presets').select('id').eq('org_id', orgA).eq('service', 'month_end').single(), 'month-end preset');
  const wrongPreset = await uploader.client
    .from('agreements')
    .insert({ org_id: orgA, preset_id: monthEndPreset.id, title: 'x', created_by: uploader.id });
  check('an agreement needs a Contracts preset', !!wrongPreset.error);

  await must(admin.from('agreements').update({ status: 'ready' }).eq('id', agreementId).select(), 'mark ready');
  const lateFile = await uploader.client
    .from('agreement_files')
    .insert({ org_id: orgA, agreement_id: agreementId, ord: 2, role: 'addendum', storage_path: `${orgA}/${agreementId}/late.pdf`, filename: 'late.pdf', uploaded_by: uploader.id });
  check('files cannot be attached after processing', !!lateFile.error);
  const lateDelete = await uploader.client.from('agreements').delete().eq('id', agreementId).select();
  check('a processed agreement cannot be deleted', lateDelete.data?.length === 0, lateDelete);

  const event = await admin.from('timeline_events').insert({ org_id: orgA, agreement_id: agreementId, event: 'agreement_test' }).select();
  check('timeline accepts an agreement event', !event.error, event.error);
  const someRun = await must(admin.from('runs').select('id').eq('org_id', orgA).limit(1).single(), 'a run');
  const both = await admin.from('timeline_events').insert({ org_id: orgA, run_id: someRun.id, agreement_id: agreementId, event: 'agreement_test' }).select();
  check('a timeline event is about a run or an agreement, not both', !!both.error, both);

  console.log('\nOffshore-processing gate');
  const flag = await reviewer.client.from('orgs').update({ offshore_processing_approved: true }).eq('id', orgA).select();
  const after = await must(admin.from('orgs').select('offshore_processing_approved').eq('id', orgA).single(), 'org');
  check('a client cannot set offshore_processing_approved', (!!flag.error || flag.data?.length === 0) && after.offshore_processing_approved === false, flag);
  const bFlag = await outsider.client.from('orgs').update({ offshore_processing_approved: true }).eq('id', orgB).select();
  const bAfter = await must(admin.from('orgs').select('offshore_processing_approved').eq('id', orgB).single(), 'org B');
  check('not even for its own organisation', (!!bFlag.error || bFlag.data?.length === 0) && bAfter.offshore_processing_approved === false, bFlag);
}

async function cleanup() {
  console.log('\nCleanup (organisation deletion path)');
  if (created.paths.length) await admin.storage.from('documents').remove(created.paths);
  for (const id of created.orgs) {
    const { error } = await admin.from('orgs').delete().eq('id', id);
    check(`organisation ${id.slice(0, 8)} deleted with all its data`, !error, error);
  }
  const left = await admin.from('timeline_events').select('id').in('org_id', created.orgs);
  check('no timeline rows left for deleted organisations', left.data?.length === 0, left);
  for (const id of created.users) await admin.auth.admin.deleteUser(id);
}

try {
  await main();
} catch (err) {
  failures++;
  console.error(`\n  FAIL  ${(err as Error).message}`);
} finally {
  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
}
