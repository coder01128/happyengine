-- Rule 6: split suggestions (one statement line = the sum of several cash book entries).
-- The parts live in their own table with real foreign keys, not in an array column.

alter table public.exceptions drop constraint exceptions_type_check;
alter table public.exceptions add constraint exceptions_type_check check (type in (
  'suggested_match', 'suggested_split', 'amount_difference', 'possible_duplicate', 'timing', 'not_in_ledger', 'not_on_statement'
));

create table public.exception_parts (
  exception_id uuid not null,
  line_id uuid not null,
  org_id uuid not null,
  run_id uuid not null,
  primary key (exception_id, line_id),
  foreign key (run_id, org_id) references public.runs (id, org_id) on delete cascade,
  foreign key (exception_id, run_id) references public.exceptions (id, run_id) on delete cascade,
  foreign key (line_id, run_id) references public.lines (id, run_id) on delete cascade
);

alter table public.exception_parts enable row level security;
create policy exception_parts_select on public.exception_parts
  for select to authenticated using ((select private.is_member(org_id)));
grant select on public.exception_parts to authenticated;
grant select, insert, update, delete on public.exception_parts to service_role;

-- Same as before, plus the exception_parts insert. CREATE OR REPLACE keeps the existing grants.
create or replace function private.store_matching(p_run uuid, p_actor uuid, p_preset jsonb, p_result jsonb)
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

  insert into public.exception_parts (exception_id, line_id, org_id, run_id)
  select x.id, l.id, v_run.org_id, p_run
  from jsonb_to_recordset(p_result -> 'exceptions') as e (id text, "ledgerIds" jsonb)
  cross join lateral jsonb_array_elements_text(coalesce(e."ledgerIds", '[]'::jsonb)) as part (ext_id)
  join public.exceptions x on x.run_id = p_run and x.engine_id = e.id
  join public.lines l on l.run_id = p_run and l.ext_id = part.ext_id;

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
