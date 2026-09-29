-- Private bucket for uploaded statements and cash book exports.
-- Object paths are <org_id>/<run_id>/<file>; access follows organisation membership.

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 20971520)
on conflict (id) do nothing;

-- The org id from an object path, or null when the first folder isn't a uuid.
create function private.path_org(p_name text)
returns uuid
language plpgsql
immutable
set search_path = ''
as $$
begin
  return (storage.foldername(p_name))[1]::uuid;
exception when invalid_text_representation then
  return null;
end;
$$;
grant execute on function private.path_org(text) to authenticated;

create policy documents_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'documents' and (select private.is_member(private.path_org(name))));

create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documents'
    and (select private.has_role(private.path_org(name), array['uploader', 'reviewer', 'admin']::public.org_role[]))
  );

create policy documents_objects_delete on storage.objects for delete to authenticated
  using (
    bucket_id = 'documents'
    and (select private.has_role(private.path_org(name), array['uploader', 'reviewer', 'admin']::public.org_role[]))
  );
