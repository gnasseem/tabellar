-- Simplify merge_bucket_draft_actions to avoid long-held row locks.
--
-- The previous version used SELECT ... FOR UPDATE which held the session row
-- lock for the duration of a complex UNION ALL + DISTINCT ON query. With up to
-- 4 parallel sub-agents all finalising near the same time and calling this
-- function concurrently, the lock contention blocked alloc_agent_turn_idx
-- (also needs the same row) in still-running buckets, causing those HTTP
-- requests to hang and leaving those sub-agent promises pending forever in
-- Promise.allSettled.
--
-- Fix: single UPDATE using the || operator for jsonb array concatenation.
-- The UPDATE acquires the row lock only for the statement duration (< 1ms),
-- eliminating contention. Deduplication by action id is intentionally omitted
-- here because:
--   a) each bucket proposes different action ids (uid() is unique per call)
--   b) the orchestrator's mergeDraftsById already deduplicates before writing
--      the final session state, so any rare duplicates from edge cases are
--      harmless.

create or replace function public.merge_bucket_draft_actions(
  p_session_id uuid,
  p_actions    jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  update agent_sessions
  set    draft_actions = draft_actions || p_actions
  where  id = p_session_id;
$$;

revoke all on function public.merge_bucket_draft_actions(uuid, jsonb) from public;
grant execute on function public.merge_bucket_draft_actions(uuid, jsonb) to service_role;
