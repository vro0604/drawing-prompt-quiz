-- ============================================================================
-- next_work_and_cleanup ／ 回答後の「次の作品」と、時間切れの掃除を足す
-- ============================================================================
--
-- 【なぜ「次の作品」がRPCなのか】
--   一覧から選ばせると、答えたばかりの人が「もう一度探す」ところから始まる。
--   その手間で流れが切れる。**まだ答えていない作品を1件だけ返す**関数を置いて、
--   画面はそれを開くだけにする。
--
-- 【何を返すか】
--   ・公開されていて、審査OKで、削除されていない作品
--   ・自分の作品ではない
--   ・自分がまだ回答していない
--   ・いま見ている作品ではない
--   ・AI部門は既定で混ぜない（既存の一覧と同じ分け方。C1〜C5）
--
-- 【並び順】
--   回答数の少ないものを先に返す。**新しく投稿された作品に回答が付かないと、
--   作者に結果が返らない。**回答の行き先を、まだ答えられていない作品へ寄せる。
--   同数のときは無作為。
--
-- 【返り値に正解は含まれない】
--   返すのは作品IDだけ。お題にもクイズにも触れない。
--
-- ============================================================================


create or replace function public.get_next_work(
  p_current_work_id uuid default null,
  p_division        text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
begin
  select w.id into v_id
    from public.works w
   where w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null
     and (p_current_work_id is null or w.id <> p_current_work_id)
     and (
       case
         when p_division is null    then w.division <> 'ai'
         when p_division = 'all'    then true
         else w.division = p_division
       end
     )
     and (v_uid is null or w.user_id <> v_uid)
     and (v_uid is null
          or not exists (select 1 from public.answers a
                          where a.work_id = w.id and a.user_id = v_uid))
   order by w.answers_count asc, random()
   limit 1;

  if v_id is null then
    return jsonb_build_object('work_id', null, 'has_next', false);
  end if;

  return jsonb_build_object('work_id', v_id, 'has_next', true);
end;
$fn$;

comment on function public.get_next_work(uuid, text) is
  'まだ回答していない公開作品を1件返す。自作と回答済みは外す。'
  '回答数の少ない作品を先に返す。返り値は作品IDだけで、お題も正解も含まない。';

revoke all on function public.get_next_work(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_next_work(uuid, text) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 掃除の窓に「猶予を使い切ったお題」を足す
-- ----------------------------------------------------------------------------
--
-- **数が見えないと、掃除が動いていないことに気づけない。**
-- 既存の6項目に1項目足すだけで、ほかの数え方は1文字も変えていない。

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
                          and p.status in ('active', 'abandoned')
                          and not exists (select 1 from public.works w
                                           where w.prompt_id = p.id)),
    'overdue_prompts', (
      select count(*) from public.prompts p
       where p.status = 'active'
         and p.time_limit_seconds is not null
         and p.deadline_at is not null
         and clock_timestamp() > p.deadline_at + make_interval(
               secs => (p.time_limit_seconds
                        * (select tp.ratio from public.time_policy tp
                            where tp.policy_key = 'grace_ratio'))::double precision)),
    'stale_drafts', (select count(*) from public.draft_sessions s
                      where (s.status = 'in_progress'
                             and s.updated_at < now() - interval '30 days')
                         or (s.status = 'abandoned'
                             and s.abandoned_at < now() - interval '30 days')),
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
  '掃除の残り件数。減っていることを確かめるための窓。'
  '2026-09-04 に overdue_prompts（猶予を使い切った制作挑戦）を足した。';

revoke all on function public.cleanup_status() from public, anon, authenticated;
grant execute on function public.cleanup_status() to service_role;
