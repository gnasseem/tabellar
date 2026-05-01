-- Atomic per-bucket draft-action merge for the parallel Auto-Resolve agent.
--
-- When a parallel sub-agent bucket finalises, it calls this function to
-- atomically merge its proposed actions into the session's draft_actions
-- column. Each action is keyed by its 'id' field; the incoming action wins
-- on conflict (allows revisions to overwrite stale staged versions).
--
-- Called with the service role key (auth.uid() is null), so no user-ownership
-- check is applied here -- the session_id is already validated by the edge
-- function before it gets this far.

create or replace function public.merge_bucket_draft_actions(
  p_session_id uuid,
  p_actions    jsonb          -- JSON array of DraftAction objects
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing jsonb;
  v_merged   jsonb;
begin
  -- Fetch current draft_actions under a row lock so concurrent bucket
  -- finalizations don't clobber each other.
  select draft_actions
  into   v_existing
  from   agent_sessions
  where  id = p_session_id
  for update;

  if not found then
    raise exception 'session not found' using errcode = 'P0002';
  end if;

  -- Build merged array: combine existing + incoming, deduplicate by 'id'
  -- using a lateral unnest so duplicates (same id) keep the INCOMING value
  -- (p_actions comes last, DISTINCT ON picks the last occurrence by sort).
  select coalesce(jsonb_agg(a order by src, pos), '[]'::jsonb)
  into   v_merged
  from (
    -- existing actions first (src=1)
    select value as a, 1 as src, ordinality as pos
    from   jsonb_array_elements(coalesce(v_existing, '[]'::jsonb))
           with ordinality
    union all
    -- incoming actions second (src=2) — wins on duplicate id
    select value as a, 2 as src, ordinality as pos
    from   jsonb_array_elements(coalesce(p_actions, '[]'::jsonb))
           with ordinality
  ) all_actions
  where a->>'id' is not null;

  -- Deduplicate: keep the last entry per id (incoming wins over existing).
  select jsonb_agg(a)
  into   v_merged
  from (
    select distinct on (a->>'id') a
    from (
      select value as a, 1 as src
      from   jsonb_array_elements(coalesce(v_existing, '[]'::jsonb))
      union all
      select value as a, 2 as src
      from   jsonb_array_elements(coalesce(p_actions, '[]'::jsonb))
    ) combined
    order by a->>'id', src desc   -- src=2 (incoming) wins
  ) deduped;

  update agent_sessions
  set    draft_actions = coalesce(v_merged, '[]'::jsonb)
  where  id = p_session_id;
end;
$$;

revoke all on function public.merge_bucket_draft_actions(uuid, jsonb) from public;
grant execute on function public.merge_bucket_draft_actions(uuid, jsonb) to service_role;
