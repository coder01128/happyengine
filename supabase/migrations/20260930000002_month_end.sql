-- Happy Month-End: presets, runs, uploaded documents, engine output, review state.
-- Engine output (lines, matches, exceptions, journals, checklist) is written only by
-- private.store_matching, called by the run-matching edge function with the service role.
-- Clients read it through RLS and act on it through the review RPCs below.

create table public.presets (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  service text not null check (service in ('month_end')),
  version int not null check (version > 0),
  config jsonb not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (org_id, service, version),
  unique (id, org_id)
);
create unique index presets_one_active on public.presets (org_id, service) where active;

create type public.run_status as enum ('draft', 'matched', 'approved');

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  label text not null check (length(trim(label)) > 0),
  period_end date not null,
  opening_bank bigint not null,
  opening_ledger bigint not null,
  status public.run_status not null default 'draft',
  preset_id uuid not null,
  -- The preset as it was when matching ran, so later preset edits never change a past run.
  preset_snapshot jsonb,
  -- Bumped by every review action; approval refuses if it changed since the checks were computed.
  review_version int not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  matched_at timestamptz,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  foreign key (preset_id, org_id) references public.presets (id, org_id),
  unique (id, org_id)
);
create index runs_org_idx on public.runs (org_id, period_end desc);

alter table public.timeline_events
  add foreign key (run_id, org_id) references public.runs (id, org_id);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  side text not null check (side in ('bank', 'ledger')),
  storage_path text not null unique,
  filename text not null,
  uploaded_by uuid default auth.uid() references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  unique (run_id, side),
  check (storage_path like org_id::text || '/' || run_id::text || '/%')
);

create table public.lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  side text not null check (side in ('bank', 'ledger')),
  ext_id text not null, -- s1, s2 … / l1, l2 … in file order
  date date not null,
  description text not null,
  reference text not null default '',
  amount bigint not null, -- cents; positive = money in
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  unique (run_id, ext_id),
  unique (id, run_id)
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  bank_line_id uuid not null,
  ledger_line_id uuid not null,
  rule smallint not null check (rule in (1, 2)),
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  foreign key (bank_line_id, run_id) references public.lines (id, run_id) on delete cascade,
  foreign key (ledger_line_id, run_id) references public.lines (id, run_id) on delete cascade
);

create table public.exceptions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  engine_id text not null,
  type text not null check (type in (
    'suggested_match', 'amount_difference', 'possible_duplicate', 'timing', 'not_in_ledger', 'not_on_statement'
  )),
  bank_line_id uuid,
  ledger_line_id uuid,
  duplicate_of_line_id uuid,
  timing_kind text check (timing_kind in ('deposit_in_transit', 'outstanding_payment')),
  amount bigint not null,
  reason text not null,
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  foreign key (bank_line_id, run_id) references public.lines (id, run_id) on delete cascade,
  foreign key (ledger_line_id, run_id) references public.lines (id, run_id) on delete cascade,
  foreign key (duplicate_of_line_id, run_id) references public.lines (id, run_id) on delete cascade,
  unique (run_id, engine_id),
  unique (id, run_id)
);

create table public.journals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  exception_id uuid not null,
  bank_line_id uuid not null,
  label text not null,
  amount bigint not null,
  approved_by uuid references auth.users (id) on delete set null,
  approved_at timestamptz,
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  foreign key (exception_id, run_id) references public.exceptions (id, run_id) on delete cascade,
  foreign key (bank_line_id, run_id) references public.lines (id, run_id) on delete cascade
);

create table public.decisions (
  exception_id uuid primary key,
  org_id uuid not null,
  run_id uuid not null,
  option_id text not null,
  note text,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz not null default now(),
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  foreign key (exception_id, run_id) references public.exceptions (id, run_id) on delete cascade
);

create table public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  run_id uuid not null,
  item_key text not null,
  position int not null,
  task text not null,
  owner text not null,
  due text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'done')),
  completed_by text check (completed_by in ('bank_reconciliation')),
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  unique (run_id, item_key)
);

-- Row-level security: members read; writes are narrow.
alter table public.presets enable row level security;
alter table public.runs enable row level security;
alter table public.documents enable row level security;
alter table public.lines enable row level security;
alter table public.matches enable row level security;
alter table public.exceptions enable row level security;
alter table public.journals enable row level security;
alter table public.decisions enable row level security;
alter table public.checklist_items enable row level security;

create policy presets_select on public.presets for select to authenticated using ((select private.is_member(org_id)));
create policy runs_select on public.runs for select to authenticated using ((select private.is_member(org_id)));
create policy documents_select on public.documents for select to authenticated using ((select private.is_member(org_id)));
create policy lines_select on public.lines for select to authenticated using ((select private.is_member(org_id)));
create policy matches_select on public.matches for select to authenticated using ((select private.is_member(org_id)));
create policy exceptions_select on public.exceptions for select to authenticated using ((select private.is_member(org_id)));
create policy journals_select on public.journals for select to authenticated using ((select private.is_member(org_id)));
create policy decisions_select on public.decisions for select to authenticated using ((select private.is_member(org_id)));
create policy checklist_select on public.checklist_items for select to authenticated using ((select private.is_member(org_id)));

-- Any member role may start a run (as a draft, as themselves).
create policy runs_insert on public.runs for insert to authenticated
  with check (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and status = 'draft'
    and created_by = (select auth.uid())
    and preset_snapshot is null
    and review_version = 0
    and approved_by is null
  );

-- Documents can be attached or replaced until the run is approved.
create policy documents_insert on public.documents for insert to authenticated
  with check (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and uploaded_by = (select auth.uid())
    and exists (select 1 from public.runs r where r.id = run_id and r.org_id = documents.org_id and r.status <> 'approved')
  );
create policy documents_delete on public.documents for delete to authenticated
  using (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and exists (select 1 from public.runs r where r.id = run_id and r.status <> 'approved')
  );

-- Uploads and removals are recorded on the timeline (clients can't write it directly).
create function private.document_timeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.timeline_events (org_id, run_id, actor, event, detail)
    values (new.org_id, new.run_id, new.uploaded_by, 'document_received',
            jsonb_build_object('side', new.side, 'filename', new.filename));
    return new;
  end if;
  -- Skip when the whole organisation is being deleted.
  if exists (select 1 from public.runs where id = old.run_id) then
    insert into public.timeline_events (org_id, run_id, actor, event, detail)
    values (old.org_id, old.run_id, auth.uid(), 'document_removed',
            jsonb_build_object('side', old.side, 'filename', old.filename));
  end if;
  return old;
end;
$$;
create trigger documents_timeline
  after insert or delete on public.documents
  for each row execute function private.document_timeline();

-- ---------------------------------------------------------------------------
-- Server-side: store one matching result atomically (service role only).
-- ---------------------------------------------------------------------------
create function private.store_matching(p_run uuid, p_actor uuid, p_preset jsonb, p_result jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs;
  v_rerun boolean;
  v_summary jsonb;
begin
  select * into v_run from public.runs where id = p_run for update;
  if not found then raise exception 'Run % not found', p_run using errcode = 'no_data_found'; end if;
  if v_run.status = 'approved' then
    raise exception 'Run is approved; matching can no longer change it' using errcode = 'check_violation';
  end if;
  v_rerun := v_run.status = 'matched';

  -- A re-run replaces all engine output and any review decisions made on it.
  delete from public.lines where run_id = p_run;
  delete from public.checklist_items where run_id = p_run;

  insert into public.lines (org_id, run_id, side, ext_id, date, description, reference, amount)
  select v_run.org_id, p_run, l.side, l.id, l.date, l.description, l.reference, l.amount
  from jsonb_to_recordset(p_result -> 'lines')
    as l (id text, side text, date date, description text, reference text, amount bigint);

  insert into public.matches (org_id, run_id, bank_line_id, ledger_line_id, rule)
  select v_run.org_id, p_run, b.id, g.id, m.rule
  from jsonb_to_recordset(p_result -> 'matched') as m ("bankId" text, "ledgerId" text, rule smallint)
  join public.lines b on b.run_id = p_run and b.ext_id = m."bankId"
  join public.lines g on g.run_id = p_run and g.ext_id = m."ledgerId";

  insert into public.exceptions
    (org_id, run_id, engine_id, type, bank_line_id, ledger_line_id, duplicate_of_line_id, timing_kind, amount, reason)
  select v_run.org_id, p_run, e.id, e.type, b.id, g.id, d.id, e."timingKind", e.amount, e.reason
  from jsonb_to_recordset(p_result -> 'exceptions')
    as e (id text, type text, "bankId" text, "ledgerId" text, "duplicateOf" text, "timingKind" text, amount bigint, reason text)
  left join public.lines b on b.run_id = p_run and b.ext_id = e."bankId"
  left join public.lines g on g.run_id = p_run and g.ext_id = e."ledgerId"
  left join public.lines d on d.run_id = p_run and d.ext_id = e."duplicateOf";

  insert into public.journals (org_id, run_id, exception_id, bank_line_id, label, amount)
  select v_run.org_id, p_run, x.id, b.id, j.label, j.amount
  from jsonb_to_recordset(p_result -> 'journals')
    as j ("exceptionId" text, "bankId" text, label text, amount bigint)
  join public.exceptions x on x.run_id = p_run and x.engine_id = j."exceptionId"
  join public.lines b on b.run_id = p_run and b.ext_id = j."bankId";

  insert into public.checklist_items (org_id, run_id, item_key, position, task, owner, due, status, completed_by)
  select v_run.org_id, p_run, c.item ->> 'id', c.ord::int, c.item ->> 'task', c.item ->> 'owner', c.item ->> 'due',
         case when c.item ->> 'completedBy' = 'bank_reconciliation' then 'in_progress' else 'open' end,
         c.item ->> 'completedBy'
  from jsonb_array_elements(p_preset -> 'checklist') with ordinality as c (item, ord);

  update public.runs
     set status = 'matched', preset_snapshot = p_preset, matched_at = now(), review_version = review_version + 1
   where id = p_run;

  select jsonb_build_object(
    'lines', (select count(*) from public.lines where run_id = p_run),
    'matched', (select count(*) from public.matches where run_id = p_run),
    'exceptions', (select jsonb_object_agg(type, n) from (
        select type, count(*) as n from public.exceptions where run_id = p_run group by type) t),
    'journals', (select count(*) from public.journals where run_id = p_run),
    'rerun', v_rerun
  ) into v_summary;

  insert into public.timeline_events (org_id, run_id, actor, event, detail)
  values (v_run.org_id, p_run, p_actor, case when v_rerun then 'matching_rerun' else 'matching_run' end, v_summary);

  return v_summary;
end;
$$;

-- ---------------------------------------------------------------------------
-- Server-side: approve a run after the edge function has re-checked it with the engine.
-- ---------------------------------------------------------------------------
create function private.approve_run(p_run uuid, p_actor uuid, p_review_version int, p_panel jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.runs;
begin
  select * into v_run from public.runs where id = p_run for update;
  if not found then raise exception 'Run % not found', p_run using errcode = 'no_data_found'; end if;
  if v_run.status <> 'matched' then
    raise exception 'Run is %, not matched', v_run.status using errcode = 'check_violation';
  end if;
  if v_run.review_version <> p_review_version then
    raise exception 'The review changed while approval was being checked; check again' using errcode = 'serialization_failure';
  end if;

  update public.runs set status = 'approved', approved_by = p_actor, approved_at = now() where id = p_run;
  update public.checklist_items set status = 'done' where run_id = p_run and completed_by = 'bank_reconciliation';

  insert into public.timeline_events (org_id, run_id, actor, event, detail)
  values (v_run.org_id, p_run, p_actor, 'reconciliation_approved', jsonb_build_object('panel', p_panel));
end;
$$;

revoke execute on function private.store_matching(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function private.approve_run(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function private.store_matching(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function private.approve_run(uuid, uuid, int, jsonb) to service_role;

-- PostgREST only exposes public; thin public wrappers that only the service role may call.
create function public.store_matching(p_run uuid, p_actor uuid, p_preset jsonb, p_result jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.store_matching(p_run, p_actor, p_preset, p_result); $$;
create function public.approve_run(p_run uuid, p_actor uuid, p_review_version int, p_panel jsonb)
returns void language sql security invoker set search_path = ''
as $$ select private.approve_run(p_run, p_actor, p_review_version, p_panel); $$;
revoke execute on function public.store_matching(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.approve_run(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.store_matching(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.approve_run(uuid, uuid, int, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- Review RPCs, called by reviewers directly.
-- ---------------------------------------------------------------------------
create function public.record_decision(p_exception_id uuid, p_option_id text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_exc public.exceptions;
  v_run public.runs;
  v_option jsonb;
begin
  select * into v_exc from public.exceptions where id = p_exception_id;
  if not found or not private.is_member(v_exc.org_id) then
    raise exception 'Exception not found' using errcode = 'no_data_found';
  end if;
  if not private.has_role(v_exc.org_id, array['reviewer', 'admin']::public.org_role[]) then
    raise exception 'Only reviewers can record decisions' using errcode = 'insufficient_privilege';
  end if;
  select * into v_run from public.runs where id = v_exc.run_id for update;
  if v_run.status <> 'matched' then
    raise exception 'Run is %, decisions are closed', v_run.status using errcode = 'check_violation';
  end if;

  select o into v_option
  from jsonb_array_elements(v_run.preset_snapshot -> 'resolutions' -> v_exc.type) o
  where o ->> 'id' = p_option_id;
  if v_option is null then
    raise exception 'Option "%" is not available for %', p_option_id, v_exc.type using errcode = 'invalid_parameter_value';
  end if;
  if (v_option ->> 'noteRequired')::boolean and length(trim(coalesce(p_note, ''))) = 0 then
    raise exception 'A note is required for this option' using errcode = 'invalid_parameter_value';
  end if;

  insert into public.decisions (exception_id, org_id, run_id, option_id, note, decided_by, decided_at)
  values (v_exc.id, v_exc.org_id, v_exc.run_id, p_option_id, nullif(trim(p_note), ''), auth.uid(), now())
  on conflict (exception_id) do update
    set option_id = excluded.option_id, note = excluded.note, decided_by = excluded.decided_by, decided_at = excluded.decided_at;

  update public.runs set review_version = review_version + 1 where id = v_run.id;

  insert into public.timeline_events (org_id, run_id, actor, event, detail)
  values (v_exc.org_id, v_exc.run_id, auth.uid(), 'decision_recorded', jsonb_build_object(
    'exception', v_exc.engine_id, 'type', v_exc.type, 'option', p_option_id, 'note', nullif(trim(p_note), '')));
end;
$$;

create function public.approve_journal(p_journal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_j public.journals;
  v_run public.runs;
begin
  select * into v_j from public.journals where id = p_journal_id;
  if not found or not private.is_member(v_j.org_id) then
    raise exception 'Journal not found' using errcode = 'no_data_found';
  end if;
  if not private.has_role(v_j.org_id, array['reviewer', 'admin']::public.org_role[]) then
    raise exception 'Only reviewers can approve journals' using errcode = 'insufficient_privilege';
  end if;
  select * into v_run from public.runs where id = v_j.run_id for update;
  if v_run.status <> 'matched' then
    raise exception 'Run is %, journals are closed', v_run.status using errcode = 'check_violation';
  end if;
  if v_j.approved_at is not null then return; end if;

  update public.journals set approved_by = auth.uid(), approved_at = now() where id = v_j.id;
  update public.runs set review_version = review_version + 1 where id = v_run.id;

  insert into public.timeline_events (org_id, run_id, actor, event, detail)
  values (v_j.org_id, v_j.run_id, auth.uid(), 'journal_approved', jsonb_build_object(
    'label', v_j.label, 'amount', v_j.amount, 'posted', false));
end;
$$;

revoke execute on function public.record_decision(uuid, text, text) from public, anon;
revoke execute on function public.approve_journal(uuid) from public, anon;
grant execute on function public.record_decision(uuid, text, text) to authenticated;
grant execute on function public.approve_journal(uuid) to authenticated;
