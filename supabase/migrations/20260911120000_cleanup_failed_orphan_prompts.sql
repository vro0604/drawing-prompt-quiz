-- ============================================================================
-- 時間切れ（failed）と自動破棄（discarded）のお題も、持ち主がいなければ掃除で消す
-- ============================================================================
--
-- 【何が起きていたか】
--   お題の掃除（cleanup_orphan_prompts）は 2026-08-04 に書かれ、
--   「持ち主がいない・作品が無い・status が active か abandoned」を消していた。
--   あとから入った2つの状態が、掃除の条件にも、掃除の残り件数
--   （cleanup_status の orphan_prompts）にも足されなかった。
--     failed    … 制作時間の超過で失敗（2026-09-04）
--     discarded … 長く操作が無く自動で破棄（2026-09-09）
--
--   その結果、持ち主がいなくなった failed / discarded のお題は
--     - 掃除で消えない
--     - 残り件数にも数えられない
--     - 診断 A5（submitted なのに作品が無い）にも出ない
--     - RLS が created_by = auth.uid() なので、誰の画面からも見えない
--   2026-09-11 の本番で failed が13件（検査用の利用者を消したあとに残ったもの）、
--   discarded は0件。
--
-- 【何を変えるか】
--   消す条件と数える条件の status に 'failed' と 'discarded' を足す。
--   ほかは1文字も変えない。
--
-- 【変えないもの】
--   - submitted は消さない。作品が失われた手がかりを残す（診断 A5 が拾う）
--   - 持ち主がいる行は、どの状態でも消さない。本人の記録として残す
--     （20260909150000 の「既にある status='failed' の行は書き換えない」）
--   - 作品が付いているお題は消さない（works.prompt_id は RESTRICT）
--
-- 【当てたあと】
--   次の掃除の実行で、持ち主のいない failed / discarded のお題が消える。
--   prompt_cards / quiz_questions / quiz_choices は cascade で一緒に消える。
--
-- 【戻し方】
--   20260909150000 の cleanup_status と、20260804120000 の
--   cleanup_orphan_prompts を当て直す（status の並びを active, abandoned に戻す）。
--   消えたお題は戻らない。
-- ============================================================================

create or replace function public.cleanup_orphan_prompts(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  with target as (
    select p.id
      from public.prompts p
     where p.created_by is null
       and p.status in ('active', 'abandoned', 'failed', 'discarded')
       and not exists (select 1 from public.works w where w.prompt_id = p.id)
     limit greatest(coalesce(p_limit, 500), 1)
  )
  delete from public.prompts p
   using target t
   where p.id = t.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.cleanup_orphan_prompts(int) is
  '持ち主がいなくて作品も付いていないお題を消す（P4。2026-09-11 に failed と discarded を追加）。'
  'status = submitted は消さない（作品が失われた手がかりを残すため）。';

revoke all on function public.cleanup_orphan_prompts(int) from public, anon, authenticated;
grant execute on function public.cleanup_orphan_prompts(int) to service_role;


-- 掃除の残り件数。orphan_prompts の status に 'failed' と 'discarded' を足しただけで、
-- ほかの項目は 20260909150000 と同じ。
create or replace function public.cleanup_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'orphan_prompts', (select count(*) from public.prompts p
                        where p.created_by is null
                          and p.status in ('active', 'abandoned', 'failed', 'discarded')
                          and not exists (select 1 from public.works w
                                           where w.prompt_id = p.id)),
    -- 予定終了時刻を過ぎたが、まだ知らせていないもの（失敗にはしない）
    'unnotified_overrun', (
      select count(*) from public.prompts p
       where p.status = 'active' and p.created_by is not null
         and p.deadline_at is not null
         and clock_timestamp() > p.deadline_at
         and not exists (
           select 1 from public.notification_events e
            where e.dedupe_key = 'overrun:prompt:' || p.id::text || ':'
              || floor(extract(epoch from p.deadline_at))::bigint::text)),
    -- 48時間の放置に達しているのに、まだ破棄していないもの
    'pending_inactive_discard', (
      select count(*) from (
        select public.inactivity_marks(p.last_activity_at) as m from public.prompts p
         where p.status = 'active'
        union all
        select public.inactivity_marks(ds.last_activity_at) from public.draft_sessions ds
         where ds.status = 'in_progress') t
       where clock_timestamp() >= (t.m ->> 'discard_at')::timestamptz),
    'stale_drafts', (select count(*) from public.draft_sessions s
                      where (s.status = 'in_progress'
                             and s.updated_at < now() - interval '30 days')
                         or (s.status = 'abandoned'
                             and s.abandoned_at < now() - interval '30 days')
                         or (s.status = 'discarded'
                             and s.discarded_at < now() - interval '30 days')),
    'pending_push', (select count(*) from public.notification_deliveries d
                      where d.channel = 'web_push' and d.status = 'pending'),
    'expired_agreements', (select count(*) from public.terms_agreements a
                            where a.retain_until < now()),
    'pending_images', (select count(*) from public.storage_cleanup_queue q
                        where q.deleted_at is null),
    'pending_account_deletions', (select count(*) from public.account_deletions),
    'stale_guests', (select count(*) from public.profiles p
                      where p.is_anonymous and p.account_status = 'active'
                        and p.created_at < now() - interval '30 days'
                        and not exists (select 1 from public.draft_sessions s
                                         where s.user_id = p.id
                                           and s.updated_at > now() - interval '30 days')
                        and not exists (select 1 from public.works w
                                         where w.user_id = p.id)),
    'works_missing_image_cleanup', (select count(*) from public.works w
                                     where w.deleted_at is not null
                                       and w.image_path is not null
                                       and w.image_deleted_at is null)
  )
$$;

comment on function public.cleanup_status() is
  '掃除の残り件数（2026-09-09 に猶予切れの数え方を撤去し、超過の知らせ・'
  '放置の破棄・未送信のプッシュを足した。2026-09-11 に持ち主のいない failed と'
  'discarded を orphan_prompts へ足した）。';

revoke all on function public.cleanup_status() from public, anon, authenticated;
grant execute on function public.cleanup_status() to service_role;


-- 当てた直後に、消す条件と数える条件がそろって failed と discarded を含み、
-- submitted を含まないことを確かめる。食い違えばここで止まり、何も入らない。
do $$
declare
  v_clean text;
  v_status text;
  v_list constant text := '%''active'', ''abandoned'', ''failed'', ''discarded''%';
begin
  select p.prosrc into v_clean from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cleanup_orphan_prompts';
  select p.prosrc into v_status from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'cleanup_status';

  if v_clean not like v_list or v_clean like '%submitted%' then
    raise exception 'cleanup_orphan_prompts の条件が想定と違います';
  end if;
  if v_status not like v_list then
    raise exception 'cleanup_status の orphan_prompts が failed / discarded を数えていません';
  end if;
end $$;
