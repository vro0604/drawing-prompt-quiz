-- ============================================================================
-- 20260912090000_system_answer_queue.sql を取り消す（20260912090000 を当てる前の状態へ戻す）
-- ============================================================================
--
-- 【この SQL は、まだどこにも流していない（使い捨ての DB を除く）】
--   本番へ流すかどうかは人が決める。流し方と順番は docs/landing-d194-d196.md の「取り消し」。
--
-- 【作り方】
--   本番と同じ60本を当てた使い捨ての PostgreSQL 17.6 で、この1本を当てる前と後の
--   部品の一覧を取り、その差から機械的に作った（pg17/repro.mjs gen）。
--   変わった関数は「当てる前の定義」をそのまま書き戻す。増えた部品は消す。
--
-- 【安全条件】どれか1つでも満たさなければ、何も変えずに止まる
--   - システム回答が0件（answers.answer_source が human 以外の行が無い）
--   - 待ち行列が0行（system_answer_queue に行が無い）
--   - D196（20260912100000）を先に取り消してある
--
-- 【流したあと】履歴から外す: npx supabase migration repair 20260912090000 --status reverted --linked
--   （着地後の main の clean checkout から打つ。docs/landing-d194-d196.md）
-- ============================================================================

begin;

-- ── 1. 安全条件 ──────────────────────────────────────────────
do $$
declare
  v_system bigint := 0;
  v_queue  bigint := 0;
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'answers'
                and column_name = 'answer_source') then
    execute $q$select count(*) from public.answers where answer_source is distinct from 'human'$q$ into v_system;
  end if;
  if to_regclass('public.system_answer_queue') is not null then
    execute 'select count(*) from public.system_answer_queue' into v_queue;
  end if;
  if v_system > 0 then
    raise exception '取り消しを止めました: システム回答が % 件あります（0件のときだけ戻せる）', v_system;
  end if;
  if v_queue > 0 then
    raise exception '取り消しを止めました: 待ち行列に % 行あります（0行のときだけ戻せる）', v_queue;
  end if;
end $$;

-- ── 2. 順番の条件（新しいものから戻す）────────────────────────
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('answers_after_insert_auto_import', 'consume_import_capacity', 'analysis_all_answers', 'analysis_advanced_answers', 'get_work_answer_list', 'set_answer_excluded', 'get_work_import_state', 'get_my_answer_analysis')
                and pg_get_functiondef(p.oid) ~ 'answer_source') then
    raise exception '取り消しを止めました: 先に 20260912100000（D196）を取り消してください';
  end if;
end $$;

-- ── 引き金を外す ────────────────────────────────────────────
drop trigger if exists system_answer_queue_touch on public.system_answer_queue;

-- ── 増えた関数 8 本を消す ──────────────────────────────
drop function if exists public.cancel_system_answer_job(uuid,text);
drop function if exists public.claim_system_answer_jobs(integer);
drop function if exists public.enqueue_system_answer(uuid);
drop function if exists public.get_system_answer_job(uuid);
drop function if exists public.mark_system_answer_failed(uuid,text);
drop function if exists public.retry_system_answer_job(uuid);
drop function if exists public.save_system_answer(uuid,jsonb);
drop function if exists public.system_answer_queue_touch();

-- ── 増えた制約・索引・列を消す ────────────────────────────────

-- ── 増えた表を消す（行は安全条件で0行と確かめてある）─────────────
drop table if exists public.system_answer_queue;

-- ── 自己検算: 当てる前と同じになったか ─────────────────────────
do $$
begin
  if to_regprocedure('public.cancel_system_answer_job(uuid,text)') is not null then raise exception '消えていません: cancel_system_answer_job(uuid,text)'; end if;
  if to_regprocedure('public.claim_system_answer_jobs(integer)') is not null then raise exception '消えていません: claim_system_answer_jobs(integer)'; end if;
  if to_regprocedure('public.enqueue_system_answer(uuid)') is not null then raise exception '消えていません: enqueue_system_answer(uuid)'; end if;
  if to_regprocedure('public.get_system_answer_job(uuid)') is not null then raise exception '消えていません: get_system_answer_job(uuid)'; end if;
  if to_regprocedure('public.mark_system_answer_failed(uuid,text)') is not null then raise exception '消えていません: mark_system_answer_failed(uuid,text)'; end if;
  if to_regprocedure('public.retry_system_answer_job(uuid)') is not null then raise exception '消えていません: retry_system_answer_job(uuid)'; end if;
  if to_regprocedure('public.save_system_answer(uuid,jsonb)') is not null then raise exception '消えていません: save_system_answer(uuid,jsonb)'; end if;
  if to_regprocedure('public.system_answer_queue_touch()') is not null then raise exception '消えていません: system_answer_queue_touch()'; end if;
  if exists (select 1 from pg_trigger where tgname = 'system_answer_queue_touch' and not tgisinternal and tgrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 引き金 system_answer_queue_touch'; end if;
  if to_regclass('public.system_answer_queue_one_per_work') is not null then raise exception '消えていません: 索引 system_answer_queue_one_per_work'; end if;
  if to_regclass('public.system_answer_queue_pending_idx') is not null then raise exception '消えていません: 索引 system_answer_queue_pending_idx'; end if;
  if to_regclass('public.system_answer_queue_pkey') is not null then raise exception '消えていません: 索引 system_answer_queue_pkey'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_attempts_positive' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_attempts_positive'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_one_per_work' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_one_per_work'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_owner_user_id_fkey' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_owner_user_id_fkey'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_pkey' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_pkey'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_status_valid' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_status_valid'; end if;
  if exists (select 1 from pg_constraint where conname = 'system_answer_queue_work_id_fkey' and conrelid = to_regclass('public.system_answer_queue')) then raise exception '消えていません: 制約 system_answer_queue_work_id_fkey'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'attempts') then raise exception '消えていません: 列 system_answer_queue.attempts'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'enqueued_at') then raise exception '消えていません: 列 system_answer_queue.enqueued_at'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'id') then raise exception '消えていません: 列 system_answer_queue.id'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'last_attempt_at') then raise exception '消えていません: 列 system_answer_queue.last_attempt_at'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'last_error') then raise exception '消えていません: 列 system_answer_queue.last_error'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'owner_user_id') then raise exception '消えていません: 列 system_answer_queue.owner_user_id'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'status') then raise exception '消えていません: 列 system_answer_queue.status'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'updated_at') then raise exception '消えていません: 列 system_answer_queue.updated_at'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'system_answer_queue' and column_name = 'work_id') then raise exception '消えていません: 列 system_answer_queue.work_id'; end if;
  if to_regclass('public.system_answer_queue') is not null then raise exception '消えていません: system_answer_queue'; end if;
  if to_regclass('public.system_answer_queue_id_seq') is not null then raise exception '消えていません: system_answer_queue_id_seq'; end if;
end $$;

commit;
