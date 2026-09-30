-- Approved Month-End runs freeze their files.
--
-- The statement and cash book uploaded for a run are audit evidence. Until the run is approved they can be replaced
-- (delete, then upload again: see 20260930000002_month_end.sql and 20260930000007_parse_positions.sql). Once the
-- run is approved nothing about them can change:
--   1. Storage: a client can no longer delete an object in the folder of an approved run, and can no longer add one.
--   2. The documents table: a guard trigger refuses to insert, change or delete a document of an approved run,
--      for every role, service role included. (The policies already stop clients; this also stops the server.)
--
-- A run that is deleted along with its organisation is not blocked: its rows go together, and the guard only acts
-- while the run still exists (the same test private.document_timeline uses).

-- 1. Storage: only the folder of a run that is not approved can be added to or removed from.
drop policy documents_objects_delete on storage.objects;
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (select private.has_role(private.path_org(name), array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and exists (
      select 1 from public.runs r
      where r.id::text = (storage.foldername(name))[2] and r.org_id = private.path_org(name) and r.status <> 'approved'
    )
  );

-- Adding an object keeps its old rule for every folder that is not the folder of an approved run. Contracts
-- originals (<org>/<agreement_id>/…) are not run folders, so they are not affected.
drop policy documents_objects_insert on storage.objects;
create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (select private.has_role(private.path_org(name), array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and not exists (
      select 1 from public.runs r
      where r.id::text = (storage.foldername(name))[2] and r.org_id = private.path_org(name) and r.status = 'approved'
    )
  );

-- 2. The documents table.
create function private.document_frozen_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run uuid := case when tg_op = 'INSERT' then new.run_id else old.run_id end;
begin
  if exists (select 1 from public.runs where id = v_run and status = 'approved') then
    raise exception 'The files of an approved reconciliation are frozen: they cannot be added, changed or removed'
      using errcode = 'P0001';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger documents_frozen
  before insert or update or delete on public.documents
  for each row execute function private.document_frozen_guard();
