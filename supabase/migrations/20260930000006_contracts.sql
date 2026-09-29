-- Happy Contracts: agreements, their files, parsed pages, extracted fields, key dates, review items
-- and reminder drafts. Clients create agreements and attach files; everything the pipeline produces
-- is written by private.* functions called with the service role (added with the edge functions).
-- Also widens three shared tables: presets.service, orgs.offshore_processing_approved and
-- timeline_events.agreement_id.

-- ---------------------------------------------------------------------------
-- Shared tables
-- ---------------------------------------------------------------------------
alter table public.presets drop constraint presets_service_check;
alter table public.presets add constraint presets_service_check check (service in ('contracts', 'month_end'));

-- The offshore-processing gate: documents from an organisation go to LlamaParse or Claude only when
-- this is true. Clients can't change it: authenticated has no update grant or policy on orgs.
alter table public.orgs add column offshore_processing_approved boolean not null default false;
comment on column public.orgs.offshore_processing_approved is
  'Set by happyai only after the POPIA template pack and the client''s consent are in place.';

-- ---------------------------------------------------------------------------
-- Agreements and their files
-- ---------------------------------------------------------------------------
create type public.agreement_status as enum (
  'uploaded', 'parsing', 'parsed', 'extracting', 'ready', 'flagged', 'reviewed', 'with_legal', 'failed'
);

create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  preset_id uuid not null,
  -- The preset as it was when processing ran, so later preset edits never change a past agreement.
  preset_snapshot jsonb,
  title text not null check (length(trim(title)) > 0),
  status public.agreement_status not null default 'uploaded',
  -- Set at upload. A scanned agreement is parsed with the preset's scannedTier.
  scanned boolean not null default false,
  error text,
  -- Bumped by every review action, like runs.review_version.
  review_version int not null default 0,
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (preset_id, org_id) references public.presets (id, org_id),
  unique (id, org_id)
);
create index agreements_org_idx on public.agreements (org_id, created_at desc);

create table public.agreement_files (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agreement_id uuid not null,
  ord int not null check (ord >= 1), -- 1 = main agreement, 2+ = addenda in date order
  role text not null check (role in ('main', 'addendum')),
  storage_path text not null unique,
  filename text not null check (length(trim(filename)) > 0),
  page_count int check (page_count > 0),
  parse_job_id text,
  parse_status text,
  parser text check (parser in ('fixture', 'pdfjs', 'llamaparse')),
  parser_tier text,
  parsed_at timestamptz,
  uploaded_by uuid default auth.uid() references auth.users (id) on delete set null,
  uploaded_at timestamptz not null default now(),
  foreign key (agreement_id, org_id) references public.agreements (id, org_id) on delete cascade,
  unique (agreement_id, ord),
  unique (id, org_id),
  check ((ord = 1) = (role = 'main')),
  check (storage_path like org_id::text || '/' || agreement_id::text || '/%')
);

-- Parser output per page: text and word positions (PDF points, top-left origin). Service role writes.
create table public.parsed_pages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  file_id uuid not null,
  page int not null check (page >= 1),
  width double precision not null check (width > 0),
  height double precision not null check (height > 0),
  text text not null default '',
  words jsonb not null default '[]'::jsonb check (jsonb_typeof(words) = 'array'),
  foreign key (file_id, org_id) references public.agreement_files (id, org_id) on delete cascade,
  unique (file_id, page)
);

-- ---------------------------------------------------------------------------
-- Pipeline output (service role writes)
-- ---------------------------------------------------------------------------
create table public.agreement_fields (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agreement_id uuid not null,
  key text not null check (length(trim(key)) > 0),
  -- One or more candidate values, each with its sources and grounding result.
  "values" jsonb not null default '[]'::jsonb check (jsonb_typeof("values") = 'array'),
  status text not null check (status in ('recorded', 'not_stated', 'blank', 'conflict', 'not_verified')),
  tags text[] not null default '{}',
  foreign key (agreement_id, org_id) references public.agreements (id, org_id) on delete cascade,
  unique (agreement_id, key)
);

create table public.key_dates (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agreement_id uuid not null,
  key text not null check (length(trim(key)) > 0),
  label text not null check (length(trim(label)) > 0),
  date date, -- null while pending review
  derivation jsonb not null default '{}'::jsonb, -- base, rule, wording, sources
  pending_reason text,
  foreign key (agreement_id, org_id) references public.agreements (id, org_id) on delete cascade,
  unique (agreement_id, key),
  check ((date is null) = (pending_reason is not null))
);

create table public.review_items (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  agreement_id uuid not null,
  kind text not null check (kind in ('blank', 'conflict', 'not_verified', 'unclear')),
  field_key text not null,
  summary text not null check (length(trim(summary)) > 0),
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  option_id text,
  chosen_value_index int check (chosen_value_index >= 0),
  note text,
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  foreign key (agreement_id, org_id) references public.agreements (id, org_id) on delete cascade,
  check ((option_id is null) = (decided_at is null))
);
create index review_items_agreement_idx on public.review_items (agreement_id);

-- Prepared for internal use. Nothing is ever sent.
create table public.reminder_drafts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  as_at date not null,
  body text not null,
  status text not null default 'draft' check (status in ('draft', 'approved', 'held')),
  decided_by uuid references auth.users (id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  check ((status = 'draft') = (decided_at is null))
);
create index reminder_drafts_org_idx on public.reminder_drafts (org_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Timeline: an event is about a run or an agreement, never both.
-- Adding the column is DDL; the append-only triggers are unchanged.
-- ---------------------------------------------------------------------------
alter table public.timeline_events add column agreement_id uuid;
alter table public.timeline_events
  add foreign key (agreement_id, org_id) references public.agreements (id, org_id);
alter table public.timeline_events
  add constraint timeline_events_one_subject check (run_id is null or agreement_id is null);
create index timeline_events_agreement_idx on public.timeline_events (agreement_id, at);

-- ---------------------------------------------------------------------------
-- Row-level security: members read; clients only create agreements and attach files.
-- ---------------------------------------------------------------------------
alter table public.agreements enable row level security;
alter table public.agreement_files enable row level security;
alter table public.parsed_pages enable row level security;
alter table public.agreement_fields enable row level security;
alter table public.key_dates enable row level security;
alter table public.review_items enable row level security;
alter table public.reminder_drafts enable row level security;

create policy agreements_select on public.agreements for select to authenticated using ((select private.is_member(org_id)));
create policy agreement_files_select on public.agreement_files for select to authenticated using ((select private.is_member(org_id)));
create policy parsed_pages_select on public.parsed_pages for select to authenticated using ((select private.is_member(org_id)));
create policy agreement_fields_select on public.agreement_fields for select to authenticated using ((select private.is_member(org_id)));
create policy key_dates_select on public.key_dates for select to authenticated using ((select private.is_member(org_id)));
create policy review_items_select on public.review_items for select to authenticated using ((select private.is_member(org_id)));
create policy reminder_drafts_select on public.reminder_drafts for select to authenticated using ((select private.is_member(org_id)));

-- Any member role may create an agreement (as uploaded, as themselves) on a Contracts preset.
create policy agreements_insert on public.agreements for insert to authenticated
  with check (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and status = 'uploaded'
    and created_by = (select auth.uid())
    and preset_snapshot is null
    and error is null
    and review_version = 0
    and exists (
      select 1 from public.presets p
      where p.id = preset_id and p.org_id = agreements.org_id and p.service = 'contracts'
    )
  );

-- An agreement can be deleted only before processing starts, or after it failed.
create policy agreements_delete on public.agreements for delete to authenticated
  using (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and status in ('uploaded', 'failed')
  );

-- Files are attached while the agreement is still uploaded. Parse details are set by the server.
create policy agreement_files_insert on public.agreement_files for insert to authenticated
  with check (
    (select private.has_role(org_id, array['uploader', 'reviewer', 'admin']::public.org_role[]))
    and uploaded_by = (select auth.uid())
    and parse_job_id is null and parse_status is null and parser is null and parser_tier is null and parsed_at is null
    and exists (
      select 1 from public.agreements a
      where a.id = agreement_id and a.org_id = agreement_files.org_id and a.status = 'uploaded'
    )
  );

-- ---------------------------------------------------------------------------
-- Grants (see 20260930000004_grants.sql): explicit, RLS still filters every row.
-- ---------------------------------------------------------------------------
revoke all on
  public.agreements, public.agreement_files, public.parsed_pages, public.agreement_fields,
  public.key_dates, public.review_items, public.reminder_drafts
from anon, authenticated;

grant select on
  public.agreements, public.agreement_files, public.parsed_pages, public.agreement_fields,
  public.key_dates, public.review_items, public.reminder_drafts
to authenticated;

grant insert, delete on public.agreements to authenticated;
grant insert on public.agreement_files to authenticated;

grant select, insert, update, delete on
  public.agreements, public.agreement_files, public.parsed_pages, public.agreement_fields,
  public.key_dates, public.review_items, public.reminder_drafts
to service_role;
