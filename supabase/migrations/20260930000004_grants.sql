-- Explicit table privileges for the API roles. Supabase no longer grants these by default,
-- so every grant here is deliberate. Row-level security still filters every row.
--   anon           nothing
--   authenticated  read its organisation's rows; create runs; attach/remove documents
--   service_role   server-side functions (still blocked by the timeline guard triggers)

revoke all on all tables in schema public from anon, authenticated;

grant select on
  public.orgs, public.memberships, public.presets, public.runs, public.documents, public.lines,
  public.matches, public.exceptions, public.journals, public.decisions, public.checklist_items,
  public.timeline_events
to authenticated;

grant insert on public.runs to authenticated;
grant insert, delete on public.documents to authenticated;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
