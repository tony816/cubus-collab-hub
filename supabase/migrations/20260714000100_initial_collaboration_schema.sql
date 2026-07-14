create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create type public.document_origin as enum ('obsidian', 'approved_proposal', 'drive_import', 'system');
create type public.proposal_status as enum ('pending', 'approved', 'rejected', 'conflict');

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  path text not null unique check (length(path) between 1 and 1024),
  title text not null default '' check (length(title) <= 500),
  content text not null check (octet_length(content) <= 2000000),
  frontmatter jsonb not null default '{}'::jsonb check (jsonb_typeof(frontmatter) = 'object'),
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  byte_count integer not null check (byte_count >= 0 and byte_count <= 2000000),
  version integer not null default 1 check (version > 0),
  origin public.document_origin not null,
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.document_versions (
  id bigint generated always as identity primary key,
  document_id uuid not null references public.documents(id) on delete cascade,
  version integer not null check (version > 0),
  title text not null,
  content text not null,
  frontmatter jsonb not null,
  sha256 text not null,
  byte_count integer not null,
  origin public.document_origin not null,
  actor text not null,
  created_at timestamptz not null default now(),
  unique (document_id, version)
);

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  target_path text not null,
  base_version integer not null check (base_version > 0),
  proposed_content text not null check (octet_length(proposed_content) <= 2000000),
  proposed_frontmatter jsonb,
  proposed_sha256 text not null check (proposed_sha256 ~ '^[a-f0-9]{64}$'),
  proposed_byte_count integer not null check (proposed_byte_count >= 0 and proposed_byte_count <= 2000000),
  rationale text not null check (length(rationale) between 1 and 10000),
  agent text not null check (agent in ('chatgpt', 'claude')),
  status public.proposal_status not null default 'pending',
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table public.events (
  sequence bigint generated always as identity primary key,
  kind text not null,
  entity_type text not null,
  entity_id uuid,
  actor text not null check (actor in ('chatgpt', 'claude', 'bridge', 'user', 'system')),
  origin text not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz not null default now()
);

create table public.agent_cursors (
  agent text primary key check (agent in ('chatgpt', 'claude', 'bridge')),
  last_sequence bigint not null default 0 check (last_sequence >= 0),
  updated_at timestamptz not null default now()
);

create table public.turn_summaries (
  id uuid primary key default gen_random_uuid(),
  agent text not null check (agent in ('chatgpt', 'claude')),
  seen_sequence bigint not null check (seen_sequence >= 0),
  summary text not null check (length(summary) between 1 and 30000),
  affected_paths text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table public.conflicts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.documents(id) on delete cascade,
  path text not null,
  expected_version integer,
  actual_version integer,
  local_content text not null,
  remote_content text not null,
  origin text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index document_versions_document_version_idx on public.document_versions (document_id, version desc);
create index proposals_status_created_idx on public.proposals (status, created_at desc);
create index proposals_document_idx on public.proposals (document_id, created_at desc);
create index events_created_idx on public.events (created_at desc);
create index turn_summaries_agent_created_idx on public.turn_summaries (agent, created_at desc);
create index conflicts_status_created_idx on public.conflicts (status, created_at desc);
create index documents_title_trgm_idx on public.documents using gin (lower(title) extensions.gin_trgm_ops) where deleted = false;
create index documents_content_trgm_idx on public.documents using gin (lower(content) extensions.gin_trgm_ops) where deleted = false;

alter table public.documents enable row level security;
alter table public.document_versions enable row level security;
alter table public.proposals enable row level security;
alter table public.events enable row level security;
alter table public.agent_cursors enable row level security;
alter table public.turn_summaries enable row level security;
alter table public.conflicts enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
grant all on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.upsert_canonical_document(
  p_path text,
  p_title text,
  p_content text,
  p_frontmatter jsonb,
  p_sha256 text,
  p_byte_count integer,
  p_expected_version integer,
  p_origin public.document_origin,
  p_actor text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
  v_conflict_id uuid;
begin
  select * into v_doc from public.documents where path = p_path for update;

  if not found then
    insert into public.documents (path, title, content, frontmatter, sha256, byte_count, origin)
    values (p_path, p_title, p_content, coalesce(p_frontmatter, '{}'::jsonb), p_sha256, p_byte_count, p_origin)
    returning * into v_doc;

    insert into public.document_versions
      (document_id, version, title, content, frontmatter, sha256, byte_count, origin, actor)
    values
      (v_doc.id, v_doc.version, v_doc.title, v_doc.content, v_doc.frontmatter, v_doc.sha256, v_doc.byte_count, v_doc.origin, p_actor);

    insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
    values ('document.created', 'document', v_doc.id, p_actor, p_origin::text,
      jsonb_build_object('path', v_doc.path, 'version', v_doc.version));

    return jsonb_build_object('status', 'created', 'id', v_doc.id, 'version', v_doc.version);
  end if;

  if v_doc.sha256 = p_sha256 and not v_doc.deleted then
    return jsonb_build_object('status', 'unchanged', 'id', v_doc.id, 'version', v_doc.version);
  end if;

  if p_expected_version is null or p_expected_version <> v_doc.version then
    insert into public.conflicts
      (document_id, path, expected_version, actual_version, local_content, remote_content, origin)
    values
      (v_doc.id, p_path, p_expected_version, v_doc.version, p_content, v_doc.content, p_origin::text)
    returning id into v_conflict_id;

    insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
    values ('conflict.created', 'conflict', v_conflict_id, p_actor, p_origin::text,
      jsonb_build_object('path', p_path, 'expectedVersion', p_expected_version, 'actualVersion', v_doc.version));

    return jsonb_build_object('status', 'conflict', 'conflictId', v_conflict_id, 'actualVersion', v_doc.version);
  end if;

  update public.documents
  set title = p_title,
      content = p_content,
      frontmatter = coalesce(p_frontmatter, '{}'::jsonb),
      sha256 = p_sha256,
      byte_count = p_byte_count,
      version = version + 1,
      origin = p_origin,
      deleted = false,
      updated_at = now()
  where id = v_doc.id
  returning * into v_doc;

  insert into public.document_versions
    (document_id, version, title, content, frontmatter, sha256, byte_count, origin, actor)
  values
    (v_doc.id, v_doc.version, v_doc.title, v_doc.content, v_doc.frontmatter, v_doc.sha256, v_doc.byte_count, v_doc.origin, p_actor);

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('document.updated', 'document', v_doc.id, p_actor, p_origin::text,
    jsonb_build_object('path', v_doc.path, 'version', v_doc.version));

  return jsonb_build_object('status', 'updated', 'id', v_doc.id, 'version', v_doc.version);
end;
$$;

create or replace function public.create_document_proposal(
  p_target_path text,
  p_expected_version integer,
  p_proposed_content text,
  p_proposed_frontmatter jsonb,
  p_proposed_sha256 text,
  p_proposed_byte_count integer,
  p_rationale text,
  p_agent text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_doc public.documents%rowtype;
  v_id uuid;
begin
  select * into v_doc from public.documents where path = p_target_path and not deleted;
  if not found then
    raise exception 'Document not found: %', p_target_path using errcode = 'P0002';
  end if;
  if p_expected_version <> v_doc.version then
    raise exception 'Stale document version: expected %, actual %', p_expected_version, v_doc.version using errcode = '40001';
  end if;

  insert into public.proposals
    (document_id, target_path, base_version, proposed_content, proposed_frontmatter,
     proposed_sha256, proposed_byte_count, rationale, agent)
  values
    (v_doc.id, v_doc.path, p_expected_version, p_proposed_content, p_proposed_frontmatter,
     p_proposed_sha256, p_proposed_byte_count, p_rationale, p_agent)
  returning id into v_id;

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('proposal.created', 'proposal', v_id, p_agent, 'ai',
    jsonb_build_object('path', v_doc.path, 'baseVersion', p_expected_version, 'proposalId', v_id));

  return jsonb_build_object('status', 'pending', 'proposalId', v_id);
end;
$$;

create or replace function public.upsert_canonical_documents_batch(
  p_documents jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_documents) <> 'array' or jsonb_array_length(p_documents) > 50 then
    raise exception 'p_documents must be an array with at most 50 items' using errcode = '22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_documents)
  loop
    v_results := v_results || jsonb_build_array(public.upsert_canonical_document(
      v_item->>'path',
      coalesce(v_item->>'title', ''),
      coalesce(v_item->>'content', ''),
      coalesce(v_item->'frontmatter', '{}'::jsonb),
      v_item->>'sha256',
      (v_item->>'byteCount')::integer,
      case when v_item->>'expectedVersion' is null then null else (v_item->>'expectedVersion')::integer end,
      (coalesce(v_item->>'origin', 'obsidian'))::public.document_origin,
      'bridge'
    ));
  end loop;
  return v_results;
end;
$$;

create or replace function public.rename_canonical_document(
  p_old_path text,
  p_new_path text,
  p_expected_version integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_doc public.documents%rowtype;
begin
  select * into v_doc from public.documents where path = p_old_path and not deleted for update;
  if not found then raise exception 'Document not found: %', p_old_path using errcode = 'P0002'; end if;
  if v_doc.version <> p_expected_version then
    raise exception 'Stale document version' using errcode = '40001';
  end if;
  if exists (select 1 from public.documents where path = p_new_path and not deleted) then
    raise exception 'Destination path already exists: %', p_new_path using errcode = '23505';
  end if;

  update public.documents
  set path = p_new_path, version = version + 1, origin = 'obsidian', updated_at = now()
  where id = v_doc.id returning * into v_doc;

  insert into public.document_versions
    (document_id, version, title, content, frontmatter, sha256, byte_count, origin, actor)
  values
    (v_doc.id, v_doc.version, v_doc.title, v_doc.content, v_doc.frontmatter,
     v_doc.sha256, v_doc.byte_count, v_doc.origin, 'bridge');

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('document.renamed', 'document', v_doc.id, 'bridge', 'obsidian',
    jsonb_build_object('oldPath', p_old_path, 'path', p_new_path, 'version', v_doc.version));

  return jsonb_build_object('status', 'renamed', 'id', v_doc.id, 'version', v_doc.version);
end;
$$;

create or replace function public.delete_canonical_document(
  p_path text,
  p_expected_version integer
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_doc public.documents%rowtype;
begin
  select * into v_doc from public.documents where path = p_path and not deleted for update;
  if not found then return jsonb_build_object('status', 'unchanged'); end if;
  if v_doc.version <> p_expected_version then
    raise exception 'Stale document version' using errcode = '40001';
  end if;

  update public.documents
  set deleted = true, version = version + 1, origin = 'obsidian', updated_at = now()
  where id = v_doc.id returning * into v_doc;

  insert into public.document_versions
    (document_id, version, title, content, frontmatter, sha256, byte_count, origin, actor)
  values
    (v_doc.id, v_doc.version, v_doc.title, v_doc.content, v_doc.frontmatter,
     v_doc.sha256, v_doc.byte_count, v_doc.origin, 'bridge');

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('document.deleted', 'document', v_doc.id, 'bridge', 'obsidian',
    jsonb_build_object('path', p_path, 'version', v_doc.version));

  return jsonb_build_object('status', 'deleted', 'id', v_doc.id, 'version', v_doc.version);
end;
$$;

create or replace function public.approve_document_proposal(
  p_proposal_id uuid,
  p_instruction text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
  v_doc public.documents%rowtype;
  v_conflict_id uuid;
begin
  if length(trim(p_instruction)) = 0 then
    raise exception 'Explicit user instruction is required' using errcode = '22023';
  end if;

  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if v_proposal.status <> 'pending' then
    raise exception 'Proposal is not pending' using errcode = '22023';
  end if;

  select * into v_doc from public.documents where id = v_proposal.document_id for update;
  if v_doc.version <> v_proposal.base_version then
    insert into public.conflicts
      (document_id, path, expected_version, actual_version, local_content, remote_content, origin)
    values
      (v_doc.id, v_doc.path, v_proposal.base_version, v_doc.version,
       v_proposal.proposed_content, v_doc.content, 'approved_proposal')
    returning id into v_conflict_id;

    update public.proposals
    set status = 'conflict', resolved_at = now(), resolution_note = 'Canonical document changed before approval'
    where id = v_proposal.id;

    insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
    values ('conflict.created', 'conflict', v_conflict_id, 'user', 'proposal',
      jsonb_build_object('path', v_doc.path, 'proposalId', v_proposal.id,
        'expectedVersion', v_proposal.base_version, 'actualVersion', v_doc.version));

    return jsonb_build_object('status', 'conflict', 'conflictId', v_conflict_id);
  end if;

  update public.documents
  set content = v_proposal.proposed_content,
      frontmatter = coalesce(v_proposal.proposed_frontmatter, frontmatter),
      sha256 = v_proposal.proposed_sha256,
      byte_count = v_proposal.proposed_byte_count,
      version = version + 1,
      origin = 'approved_proposal',
      updated_at = now()
  where id = v_doc.id
  returning * into v_doc;

  insert into public.document_versions
    (document_id, version, title, content, frontmatter, sha256, byte_count, origin, actor)
  values
    (v_doc.id, v_doc.version, v_doc.title, v_doc.content, v_doc.frontmatter,
     v_doc.sha256, v_doc.byte_count, v_doc.origin, 'user');

  update public.proposals
  set status = 'approved', resolved_at = now(), resolution_note = p_instruction
  where id = v_proposal.id;

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('proposal.approved', 'proposal', v_proposal.id, 'user', 'proposal',
    jsonb_build_object('path', v_doc.path, 'proposalId', v_proposal.id, 'version', v_doc.version));

  return jsonb_build_object('status', 'approved', 'proposalId', v_proposal.id, 'version', v_doc.version);
end;
$$;

create or replace function public.reject_document_proposal(
  p_proposal_id uuid,
  p_instruction text,
  p_reason text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_proposal public.proposals%rowtype;
begin
  if length(trim(p_instruction)) = 0 or length(trim(p_reason)) = 0 then
    raise exception 'Explicit instruction and reason are required' using errcode = '22023';
  end if;
  select * into v_proposal from public.proposals where id = p_proposal_id for update;
  if not found then raise exception 'Proposal not found' using errcode = 'P0002'; end if;
  if v_proposal.status <> 'pending' then raise exception 'Proposal is not pending' using errcode = '22023'; end if;

  update public.proposals
  set status = 'rejected', resolved_at = now(), resolution_note = p_reason
  where id = v_proposal.id;

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('proposal.rejected', 'proposal', v_proposal.id, 'user', 'proposal',
    jsonb_build_object('path', v_proposal.target_path, 'proposalId', v_proposal.id));

  return jsonb_build_object('status', 'rejected', 'proposalId', v_proposal.id);
end;
$$;

create or replace function public.record_agent_turn(
  p_agent text,
  p_seen_sequence bigint,
  p_summary text,
  p_affected_paths text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_id uuid;
begin
  insert into public.turn_summaries (agent, seen_sequence, summary, affected_paths)
  values (p_agent, p_seen_sequence, p_summary, coalesce(p_affected_paths, '{}'))
  returning id into v_id;

  insert into public.agent_cursors (agent, last_sequence)
  values (p_agent, p_seen_sequence)
  on conflict (agent) do update
    set last_sequence = greatest(public.agent_cursors.last_sequence, excluded.last_sequence),
        updated_at = now();

  insert into public.events (kind, entity_type, entity_id, actor, origin, metadata)
  values ('turn.recorded', 'turn_summary', v_id, p_agent, 'ai',
    jsonb_build_object('seenSequence', p_seen_sequence, 'affectedPaths', coalesce(p_affected_paths, '{}')));

  return jsonb_build_object('status', 'recorded', 'turnSummaryId', v_id);
end;
$$;

create or replace function public.search_canonical_documents(
  p_query text,
  p_limit integer default 10
) returns setof public.documents
language sql
stable
security invoker
set search_path = ''
as $$
  select d.*
  from public.documents d
  where not d.deleted
    and (lower(d.title) like '%' || lower(p_query) || '%'
      or lower(d.content) like '%' || lower(p_query) || '%')
  order by
    greatest(
      extensions.similarity(lower(d.title), lower(p_query)),
      extensions.similarity(lower(d.content), lower(p_query))
    ) desc,
    d.updated_at desc
  limit least(greatest(p_limit, 1), 50);
$$;

revoke execute on function public.upsert_canonical_document(text,text,text,jsonb,text,integer,integer,public.document_origin,text) from public, anon, authenticated;
revoke execute on function public.create_document_proposal(text,integer,text,jsonb,text,integer,text,text) from public, anon, authenticated;
revoke execute on function public.approve_document_proposal(uuid,text) from public, anon, authenticated;
revoke execute on function public.reject_document_proposal(uuid,text,text) from public, anon, authenticated;
revoke execute on function public.record_agent_turn(text,bigint,text,text[]) from public, anon, authenticated;
revoke execute on function public.search_canonical_documents(text,integer) from public, anon, authenticated;
revoke execute on function public.upsert_canonical_documents_batch(jsonb) from public, anon, authenticated;
revoke execute on function public.rename_canonical_document(text,text,integer) from public, anon, authenticated;
revoke execute on function public.delete_canonical_document(text,integer) from public, anon, authenticated;

grant execute on function public.upsert_canonical_document(text,text,text,jsonb,text,integer,integer,public.document_origin,text) to service_role;
grant execute on function public.create_document_proposal(text,integer,text,jsonb,text,integer,text,text) to service_role;
grant execute on function public.approve_document_proposal(uuid,text) to service_role;
grant execute on function public.reject_document_proposal(uuid,text,text) to service_role;
grant execute on function public.record_agent_turn(text,bigint,text,text[]) to service_role;
grant execute on function public.search_canonical_documents(text,integer) to service_role;
grant execute on function public.upsert_canonical_documents_batch(jsonb) to service_role;
grant execute on function public.rename_canonical_document(text,text,integer) to service_role;
grant execute on function public.delete_canonical_document(text,integer) to service_role;
