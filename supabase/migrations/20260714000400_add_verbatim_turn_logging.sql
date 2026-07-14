-- Verbatim turn logging.
-- Previously the AI-to-AI handoff carried only a self-written summary. Store the
-- user's exact prompt and the AI's exact full response so the other AI reads the
-- real conversation (tagged by agent name and created_at), not a lossy summary.

alter table public.turn_summaries
  add column if not exists user_prompt text,
  add column if not exists response_text text;

-- Summary is now optional (verbatim text is the primary record).
alter table public.turn_summaries alter column summary drop not null;

-- Generous ceilings; the worker truncates to 100k before insert.
alter table public.turn_summaries
  add constraint turn_summaries_user_prompt_len check (user_prompt is null or length(user_prompt) <= 200000),
  add constraint turn_summaries_response_text_len check (response_text is null or length(response_text) <= 200000);

-- Replace record_agent_turn with a signature that carries the verbatim fields.
drop function if exists public.record_agent_turn(text, bigint, text, text[]);

create or replace function public.record_agent_turn(
  p_agent text,
  p_seen_sequence bigint,
  p_user_prompt text,
  p_response_text text,
  p_summary text,
  p_affected_paths text[]
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare v_id uuid;
begin
  insert into public.turn_summaries (agent, seen_sequence, user_prompt, response_text, summary, affected_paths)
  values (p_agent, p_seen_sequence, p_user_prompt, p_response_text, p_summary, coalesce(p_affected_paths, '{}'))
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

revoke execute on function public.record_agent_turn(text, bigint, text, text, text, text[]) from public, anon, authenticated;
grant execute on function public.record_agent_turn(text, bigint, text, text, text, text[]) to service_role;
