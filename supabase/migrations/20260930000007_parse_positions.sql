-- Contracts: reading the pages (parse) and keeping the originals safe.
--   1. Parse bookkeeping on agreement_files and parsed_pages (page positions, unreadable pages).
--   2. Original files can't be overwritten or deleted by uploaders once uploaded, and the file row that
--      points at one can't be changed or removed by a client.
--   3. A private bucket for the parser's raw output (service role only).
--   4. The server-side functions the contracts-process edge function calls. Each one changes state and
--      writes its timeline event in one transaction, following private.store_matching.

-- ---------------------------------------------------------------------------
-- 1. Parse bookkeeping
-- ---------------------------------------------------------------------------
alter table public.agreement_files
  add column parser_version text,     -- what the parser's 'latest' resolved to (LlamaParse: metadata.version)
  add column parse_credits numeric,   -- credits the job reported using; null when it didn't say
  add column sidecar_path text,       -- object path in the parse-artifacts bucket: the raw parser output
  add column file_sha256 text,        -- SHA-256 of the file as first read by the server; never changes afterwards
  add constraint agreement_files_sidecar_path_check
    check (sidecar_path is null or sidecar_path like org_id::text || '/' || agreement_id::text || '/%'),
  add constraint agreement_files_sha256_check
    check (file_sha256 is null or file_sha256 ~ '^[0-9a-f]{64}$');

-- Word boxes stay in PDF points (parsed_pages.width/height are in the same units). A page the parser could
-- not read has no text or words and says why.
alter table public.parsed_pages
  add column positions_ok boolean not null default true,
  add column positions_error text,
  add constraint parsed_pages_positions_error_check check (positions_ok or positions_error is not null);

-- Clients attach a file; everything the server records about it starts empty.
drop policy agreement_files_insert on public.agreement_files;
create policy agreement_files_insert on public.agreement_files for insert to authenticated
  with check (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and uploaded_by = (select auth.uid())
    and parse_job_id is null and parse_status is null and parser is null and parser_tier is null and parsed_at is null
    and parser_version is null and parse_credits is null and sidecar_path is null and file_sha256 is null
    and exists (
      select 1 from public.agreements a
      where a.id = agreement_id and a.org_id = agreement_files.org_id and a.status = 'uploaded'
    )
  );

-- ---------------------------------------------------------------------------
-- 2. Originals are kept as uploaded
-- ---------------------------------------------------------------------------
-- Overwriting: Storage overwrites (upsert) need an UPDATE policy on storage.objects. There is none, so a
-- client cannot replace a file in place. Deleting and re-uploading is what closes the door, so:
--
-- Clients may still delete objects in a Month-End run folder (<org>/<run_id>/…: documents can be replaced
-- until the run is approved, see 20260930000002_month_end.sql). Every other object in the documents bucket
-- is not deletable by a client. That covers Contracts originals (<org>/<agreement_id>/…), including the
-- ones left behind if an agreement row is ever removed. Removing an original is a server-side act.
drop policy documents_objects_delete on storage.objects;
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (select private.has_role(private.path_org(name), array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and exists (
      select 1 from public.runs r
      where r.id::text = (storage.foldername(name))[2] and r.org_id = private.path_org(name)
    )
  );

-- An agreement that has files can't be deleted by a client (deleting it would drop the rows that point at
-- its originals). Only an agreement with no files yet can be removed.
drop policy agreements_delete on public.agreements;
create policy agreements_delete on public.agreements for delete to authenticated
  using (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and status in ('uploaded', 'failed')
    and not exists (select 1 from public.agreement_files f where f.agreement_id = agreements.id)
  );

-- The row that points at an original can't be re-pointed, renamed or re-hashed, by anyone.
create function private.agreement_file_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.storage_path is distinct from old.storage_path
     or new.filename is distinct from old.filename
     or new.agreement_id is distinct from old.agreement_id
     or new.org_id is distinct from old.org_id
     or new.ord is distinct from old.ord
     or new.role is distinct from old.role then
    raise exception 'An uploaded file cannot be changed or replaced' using errcode = 'insufficient_privilege';
  end if;
  if old.file_sha256 is not null and new.file_sha256 is distinct from old.file_sha256 then
    raise exception 'The recorded fingerprint of an uploaded file cannot change' using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;
create trigger agreement_files_immutable
  before update on public.agreement_files
  for each row execute function private.agreement_file_guard();

-- Uploads are recorded on the timeline (clients can't write it directly), like Month-End's documents.
create function private.agreement_file_timeline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.timeline_events (org_id, agreement_id, actor, event, detail)
  values (new.org_id, new.agreement_id, new.uploaded_by, 'file_received',
          jsonb_build_object('filename', new.filename, 'role', new.role, 'order', new.ord));
  return new;
end;
$$;
create trigger agreement_files_timeline
  after insert on public.agreement_files
  for each row execute function private.agreement_file_timeline();

-- ---------------------------------------------------------------------------
-- 3. Raw parser output. No policies on storage.objects for this bucket: only the service role can use it.
-- Object paths are <org_id>/<agreement_id>/<file_id>/grounding.jsonl. Fixture parses for local testing live
-- under <org_id>/<agreement_id>/_fixtures/, here and not in the documents bucket, because uploaders can
-- write to that one.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('parse-artifacts', 'parse-artifacts', false, 52428800)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- 4. Server-side steps (service role only)
-- ---------------------------------------------------------------------------

-- uploaded → parsing, once. A second caller gets claimed = false and must not submit anything.
create function private.contracts_claim_parse(p_agreement uuid, p_actor uuid, p_preset jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreements;
begin
  select * into v from public.agreements where id = p_agreement for update;
  if not found then raise exception 'Agreement % not found', p_agreement using errcode = 'no_data_found'; end if;
  if v.status <> 'uploaded' then
    return jsonb_build_object('claimed', false, 'status', v.status);
  end if;
  -- The preset as it was when processing began, so later preset edits never change this agreement.
  update public.agreements
     set status = 'parsing', preset_snapshot = coalesce(preset_snapshot, p_preset), error = null, updated_at = now()
   where id = p_agreement;
  return jsonb_build_object('claimed', true, 'status', 'parsing');
end;
$$;

-- The first time the server reads an original, its fingerprint is pinned. Every later read must match it.
create function private.contracts_pin_file(p_file uuid, p_sha256 text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreement_files;
begin
  select * into v from public.agreement_files where id = p_file for update;
  if not found then raise exception 'File % not found', p_file using errcode = 'no_data_found'; end if;
  if v.file_sha256 is null then
    update public.agreement_files set file_sha256 = p_sha256 where id = p_file;
  elsif v.file_sha256 <> p_sha256 then
    raise exception 'The file changed since it was first read' using errcode = 'check_violation';
  end if;
end;
$$;

-- One file has been sent to the parser.
create function private.contracts_record_submitted(
  p_file uuid, p_actor uuid, p_job_id text, p_parser text, p_tier text, p_pages int, p_sha256 text, p_credits_estimate numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreement_files;
begin
  select * into v from public.agreement_files where id = p_file for update;
  if not found then raise exception 'File % not found', p_file using errcode = 'no_data_found'; end if;
  if v.file_sha256 is not null and v.file_sha256 <> p_sha256 then
    raise exception 'The file changed since it was first read' using errcode = 'check_violation';
  end if;
  update public.agreement_files
     set parse_job_id = p_job_id, parse_status = 'parsing', parser = p_parser, parser_tier = p_tier,
         page_count = p_pages, file_sha256 = coalesce(file_sha256, p_sha256)
   where id = p_file;
  insert into public.timeline_events (org_id, agreement_id, actor, event, detail)
  values (v.org_id, v.agreement_id, p_actor, 'parse_submitted', jsonb_build_object(
    'filename', v.filename, 'parser', p_parser, 'tier', p_tier, 'pages', p_pages,
    'credits_estimate', p_credits_estimate, 'sha256', p_sha256));
end;
$$;

-- One file's result: its pages, and the file marked parsed. The last file moves the agreement to parsed.
-- p_pages: [{ page, width, height, text, words, positions_ok, positions_error }]
-- p_meta:  { version, credits, sidecar_path }
create function private.contracts_store_parsed_file(p_file uuid, p_actor uuid, p_pages jsonb, p_meta jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_file public.agreement_files;
  v_agr public.agreements;
  v_left int;
  v_detail jsonb;
begin
  select * into v_file from public.agreement_files where id = p_file for update;
  if not found then raise exception 'File % not found', p_file using errcode = 'no_data_found'; end if;
  select * into v_agr from public.agreements where id = v_file.agreement_id for update;
  if v_agr.status <> 'parsing' then
    raise exception 'Agreement is %, a parse result is not expected', v_agr.status using errcode = 'check_violation';
  end if;
  -- A second caller that fetched the same result finds it already stored.
  if v_file.parse_status = 'parsed' then
    return jsonb_build_object('stored', false, 'status', v_agr.status);
  end if;

  delete from public.parsed_pages where file_id = p_file;
  insert into public.parsed_pages (org_id, file_id, page, width, height, text, words, positions_ok, positions_error)
  select v_file.org_id, p_file, x.page, x.width, x.height, coalesce(x.text, ''), coalesce(x.words, '[]'::jsonb),
         coalesce(x.positions_ok, true), x.positions_error
  from jsonb_to_recordset(p_pages)
    as x (page int, width double precision, height double precision, text text, words jsonb, positions_ok boolean, positions_error text);

  update public.agreement_files
     set parse_status = 'parsed', parsed_at = now(), page_count = jsonb_array_length(p_pages),
         parser_version = p_meta ->> 'version', parse_credits = (p_meta ->> 'credits')::numeric,
         sidecar_path = p_meta ->> 'sidecar_path'
   where id = p_file;

  select count(*) into v_left
    from public.agreement_files where agreement_id = v_file.agreement_id and parse_status is distinct from 'parsed';
  if v_left > 0 then
    return jsonb_build_object('stored', true, 'status', 'parsing');
  end if;

  update public.agreements set status = 'parsed', updated_at = now() where id = v_file.agreement_id;
  select jsonb_build_object(
    'files', count(*),
    'pages', coalesce(sum(page_count), 0),
    'tier', min(parser_tier),
    'parser', min(parser),
    'credits', sum(parse_credits),
    'unreadable_pages', (select count(*) from public.parsed_pages pp
                          join public.agreement_files f2 on f2.id = pp.file_id
                         where f2.agreement_id = v_file.agreement_id and not pp.positions_ok)
  ) into v_detail
  from public.agreement_files where agreement_id = v_file.agreement_id;
  insert into public.timeline_events (org_id, agreement_id, actor, event, detail)
  values (v_file.org_id, v_file.agreement_id, p_actor, 'parsed', v_detail);
  return jsonb_build_object('stored', true, 'status', 'parsed');
end;
$$;

-- Processing stopped: the plain-language reason is kept on the agreement.
create function private.contracts_fail(p_agreement uuid, p_actor uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreements;
begin
  select * into v from public.agreements where id = p_agreement for update;
  if not found then raise exception 'Agreement % not found', p_agreement using errcode = 'no_data_found'; end if;
  if v.status not in ('uploaded', 'parsing', 'parsed', 'extracting') then return; end if;
  update public.agreements set status = 'failed', error = p_error, updated_at = now() where id = p_agreement;
  insert into public.timeline_events (org_id, agreement_id, actor, event, detail)
  values (v.org_id, p_agreement, p_actor, 'processing_failed', jsonb_build_object('error', p_error));
end;
$$;

-- failed → uploaded: clears what processing produced, keeps the files (and their fingerprints).
create function private.contracts_retry(p_agreement uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.agreements;
begin
  select * into v from public.agreements where id = p_agreement for update;
  if not found then raise exception 'Agreement % not found', p_agreement using errcode = 'no_data_found'; end if;
  if v.status <> 'failed' then
    raise exception 'Only a failed agreement can be tried again (it is %)', v.status using errcode = 'check_violation';
  end if;
  delete from public.review_items where agreement_id = p_agreement;
  delete from public.key_dates where agreement_id = p_agreement;
  delete from public.agreement_fields where agreement_id = p_agreement;
  delete from public.parsed_pages where file_id in (select id from public.agreement_files where agreement_id = p_agreement);
  update public.agreement_files
     set parse_job_id = null, parse_status = null, parser = null, parser_tier = null, parsed_at = null,
         page_count = null, parser_version = null, parse_credits = null, sidecar_path = null
   where agreement_id = p_agreement;
  update public.agreements set status = 'uploaded', error = null, updated_at = now() where id = p_agreement;
  insert into public.timeline_events (org_id, agreement_id, actor, event, detail)
  values (v.org_id, p_agreement, p_actor, 'processing_retried', '{}'::jsonb);
end;
$$;

revoke execute on function private.contracts_pin_file(uuid, text) from public, anon, authenticated;
grant execute on function private.contracts_pin_file(uuid, text) to service_role;
revoke execute on function private.contracts_claim_parse(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function private.contracts_record_submitted(uuid, uuid, text, text, text, int, text, numeric) from public, anon, authenticated;
revoke execute on function private.contracts_store_parsed_file(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function private.contracts_fail(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function private.contracts_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function private.contracts_claim_parse(uuid, uuid, jsonb) to service_role;
grant execute on function private.contracts_record_submitted(uuid, uuid, text, text, text, int, text, numeric) to service_role;
grant execute on function private.contracts_store_parsed_file(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function private.contracts_fail(uuid, uuid, text) to service_role;
grant execute on function private.contracts_retry(uuid, uuid) to service_role;

-- PostgREST only exposes public; thin public wrappers that only the service role may call.
create function public.contracts_pin_file(p_file uuid, p_sha256 text)
returns void language sql security invoker set search_path = ''
as $$ select private.contracts_pin_file(p_file, p_sha256); $$;
revoke execute on function public.contracts_pin_file(uuid, text) from public, anon, authenticated;
grant execute on function public.contracts_pin_file(uuid, text) to service_role;

create function public.contracts_claim_parse(p_agreement uuid, p_actor uuid, p_preset jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.contracts_claim_parse(p_agreement, p_actor, p_preset); $$;
create function public.contracts_record_submitted(
  p_file uuid, p_actor uuid, p_job_id text, p_parser text, p_tier text, p_pages int, p_sha256 text, p_credits_estimate numeric)
returns void language sql security invoker set search_path = ''
as $$ select private.contracts_record_submitted(p_file, p_actor, p_job_id, p_parser, p_tier, p_pages, p_sha256, p_credits_estimate); $$;
create function public.contracts_store_parsed_file(p_file uuid, p_actor uuid, p_pages jsonb, p_meta jsonb)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.contracts_store_parsed_file(p_file, p_actor, p_pages, p_meta); $$;
create function public.contracts_fail(p_agreement uuid, p_actor uuid, p_error text)
returns void language sql security invoker set search_path = ''
as $$ select private.contracts_fail(p_agreement, p_actor, p_error); $$;
create function public.contracts_retry(p_agreement uuid, p_actor uuid)
returns void language sql security invoker set search_path = ''
as $$ select private.contracts_retry(p_agreement, p_actor); $$;

revoke execute on function public.contracts_claim_parse(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.contracts_record_submitted(uuid, uuid, text, text, text, int, text, numeric) from public, anon, authenticated;
revoke execute on function public.contracts_store_parsed_file(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.contracts_fail(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.contracts_retry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.contracts_claim_parse(uuid, uuid, jsonb) to service_role;
grant execute on function public.contracts_record_submitted(uuid, uuid, text, text, text, int, text, numeric) to service_role;
grant execute on function public.contracts_store_parsed_file(uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.contracts_fail(uuid, uuid, text) to service_role;
grant execute on function public.contracts_retry(uuid, uuid) to service_role;
