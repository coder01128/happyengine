-- Core: organisations, memberships, role helpers, append-only timeline.
-- Every client table carries org_id and has row-level security keyed on membership.

create schema if not exists private;
grant usage on schema private to authenticated, service_role;

create table public.orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_at timestamptz not null default now()
);

create type public.org_role as enum ('uploader', 'reviewer', 'admin');

create table public.memberships (
  org_id uuid not null references public.orgs (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.org_role not null,
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

-- Role helpers. SECURITY DEFINER so policies on memberships don't recurse into themselves.
create function private.is_member(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid())
  );
$$;

create function private.has_role(p_org uuid, p_roles public.org_role[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.memberships m
    where m.org_id = p_org and m.user_id = (select auth.uid()) and m.role = any (p_roles)
  );
$$;

revoke execute on function private.is_member(uuid) from public, anon;
revoke execute on function private.has_role(uuid, public.org_role[]) from public, anon;
grant execute on function private.is_member(uuid) to authenticated;
grant execute on function private.has_role(uuid, public.org_role[]) to authenticated;

alter table public.orgs enable row level security;
alter table public.memberships enable row level security;

-- Organisations and memberships are created by happyai (service role) during onboarding, not by clients.
create policy orgs_select on public.orgs
  for select to authenticated using ((select private.is_member(id)));
create policy memberships_select on public.memberships
  for select to authenticated using ((select private.is_member(org_id)));

-- Timeline: append-only audit log of every step, who did it and when.
create table public.timeline_events (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  run_id uuid,
  at timestamptz not null default now(),
  actor uuid references auth.users (id) on delete set null,
  event text not null,
  detail jsonb not null default '{}'::jsonb
);
create index timeline_events_run_idx on public.timeline_events (run_id, at);

-- Rows can never be changed. They can only be deleted as part of deleting the whole
-- organisation (contract end / POPIA deletion), when the org row is already gone.
create function private.timeline_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.orgs where id = old.org_id) then
    return old;
  end if;
  raise exception 'timeline_events is append-only (% refused)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger timeline_events_no_update
  before update on public.timeline_events
  for each row execute function private.timeline_guard();
create trigger timeline_events_no_delete
  before delete on public.timeline_events
  for each row execute function private.timeline_guard();

create function private.timeline_no_truncate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'timeline_events is append-only (TRUNCATE refused)' using errcode = 'insufficient_privilege';
end;
$$;
create trigger timeline_events_no_truncate
  before truncate on public.timeline_events
  for each statement execute function private.timeline_no_truncate();

alter table public.timeline_events enable row level security;
-- Members read their organisation's timeline. Only server-side functions write to it.
create policy timeline_select on public.timeline_events
  for select to authenticated using ((select private.is_member(org_id)));
revoke insert, update, delete, truncate on public.timeline_events from anon, authenticated;
