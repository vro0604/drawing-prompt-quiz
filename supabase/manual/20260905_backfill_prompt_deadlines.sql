-- ============================================================================
-- 既存の制作挑戦へ期限を遡及して入れる（承認が要る。migration ではない）
-- ============================================================================
--
-- **標準の `npm run db:deploy` では走らない。**手で実行したときだけ動く。
--
-- 先に 20260905_inspect_prompt_deadlines.sql を実行して、
-- would_fail（投稿できなくなるお題の件数）と affected_users（影響する人数）を
-- 読むこと。読まずに実行しない。
--
-- 【何をするか】
--   status = 'active' で、有限の制限時間を持ち、まだ期限が入っていないお題に
--     started_at  = created_at（記録。20260905090000 で既に入っている）
--     deadline_at = started_at + T
--   を書き込む。
--
-- 【何をしないか】
--   status は書き換えない。作品も画像も触らない。
--   「時間切れ」にするのは掃除（expire_overdue_prompts）の役目で、
--   この SQL を実行しただけでは、まだ誰も投稿できなくならない。
--   掃除が回った時点で、猶予を過ぎているものが failed になる。
--
-- 【戻せるか】
--   戻せる。下の「取り消し」を実行すると deadline_at を null に戻せる。
--   ただし掃除が先に回って status='failed' になった行は、
--   status も戻す必要がある（取り消しの2本目）。

begin;

update public.prompts p
   set deadline_at = p.started_at + make_interval(secs => p.time_limit_seconds)
 where p.status = 'active'
   and p.time_limit_seconds is not null
   and p.deadline_at is null;

-- 何件入ったかを見てから commit する
select count(*) as prompts_with_deadline
  from public.prompts
 where status = 'active' and deadline_at is not null;

commit;


-- ----------------------------------------------------------------------------
-- 取り消し（実行しないこと。必要になったときだけ）
-- ----------------------------------------------------------------------------
--
-- update public.prompts set deadline_at = null
--  where status = 'active' and deadline_at is not null;
--
-- update public.prompts set status = 'active', failed_at = null, elapsed_seconds = null
--  where status = 'failed';
