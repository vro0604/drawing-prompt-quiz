-- ============================================================================
-- 20260916120000_usage_summary_human_answers.sql
--   運営の利用状況（get_usage_summary）の回答数を、人の回答と仕組みの回答に分ける
-- ============================================================================
--
-- 【何のためか】
--   get_usage_summary の answer_completed は「期間内に作られた answers の行」を数えていた
--   （20260904096000_usage_events.sql）。D194 で回答に出所（answer_source）が付き、
--   D195 で仕組みが答える回答（system）を保存できるようになった。
--   仕組みの回答を作り始めると、この数に「人が答えた数」と「仕組みが答えた数」が混ざる。
--
--   出所: ユーザー指示（2026-09-12）「get_usage_summaryは将来C」、
--   （2026-09-16）「answer_completed = human answerのみ / answer_completed_system =
--   system answerのみ」「既存answer_completedの名前は維持」「期間条件など既存ロジックは
--   そのまま維持する」。
--
-- 【変えること（2つだけ）】
--   1. answer_completed は answer_source = 'human' の行だけを数える
--   2. answer_completed_system を足す（answer_source = 'system' の行だけ）
--
-- 【変えないこと】
--   名前・引数（p_days int default 30）・戻り値の型（jsonb）・言語（sql）・stable・
--   security definer・search_path = ''・持ち主・権限（service_role だけが呼べる）。
--   期間の数え方（greatest(1, coalesce(p_days, 30)) 日前より後）と、ほかの4つの数。
--
--   仕組みの回答が0件のあいだは、answer_completed の値は変更の前と同じ
--   （answer_source は NOT NULL で human / system の2値。D194 の制約）。
--
-- 【版番号】
--   本番の最大（20260914120000）より後ろ、かつ main にある課金の2本
--   （20260917090000 / 20260917100000。本番未適用）より前にした。
--   課金の2本より後ろの番号を先に本番へ当てると、課金の2本が「本番の最大より前」になり、
--   db:deploy（--include-all を使わない）が断るため。
--   全ブランチ・全コミット・全作業木（未追跡を含む）で 20260915〜20260916 の版は0件（2026-09-17）。
--
-- 【本番で起きること】
--   関数の定義が1本入れ替わるだけ。行は1つも書き換えない。
-- ============================================================================

create or replace function public.get_usage_summary(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'since_days', greatest(1, coalesce(p_days, 30)),
    'share_opened', (
      select count(*) from public.usage_events e
       where e.event_key = 'share_opened'
         and e.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'next_work_opened', (
      select count(*) from public.usage_events e
       where e.event_key = 'next_work_opened'
         and e.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'answer_completed', (
      select count(*) from public.answers a
       where a.answer_source = 'human'
         and a.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'answer_completed_system', (
      select count(*) from public.answers a
       where a.answer_source = 'system'
         and a.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'draft_started', (
      select count(*) from public.draft_sessions d
       where d.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'carryover_used', (
      select count(*) from public.prompt_element_origins o
       where o.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30))))
  );
$fn$;

comment on function public.get_usage_summary(int) is
  '5つの動きの件数。3つは既存の表から、2つは usage_events から数える。運営用。'
  '回答完了は人の回答（answer_completed）と仕組みの回答（answer_completed_system）を分けて数える。';

revoke all on function public.get_usage_summary(int)
  from public, anon, authenticated;
grant execute on function public.get_usage_summary(int) to service_role;

-- 自己検算: 守りが変わっていないこと。1つでも違えば、この migration ごと巻き戻る
do $$
declare
  v_secdef boolean;
  v_config text[];
  v_result text;
begin
  select p.prosecdef, p.proconfig, pg_get_function_result(p.oid)
    into v_secdef, v_config, v_result
    from pg_proc p
   where p.oid = 'public.get_usage_summary(int)'::regprocedure;

  if not v_secdef then
    raise exception 'get_usage_summary が security definer でなくなった';
  end if;
  if v_config is distinct from array['search_path=""'] then
    raise exception 'get_usage_summary の search_path が変わった: %', v_config;
  end if;
  if v_result <> 'jsonb' then
    raise exception 'get_usage_summary の戻り値が変わった: %', v_result;
  end if;
  if has_function_privilege('anon', 'public.get_usage_summary(int)', 'execute')
     or has_function_privilege('authenticated', 'public.get_usage_summary(int)', 'execute') then
    raise exception 'get_usage_summary が anon / authenticated から呼べる';
  end if;
  if not has_function_privilege('service_role', 'public.get_usage_summary(int)', 'execute') then
    raise exception 'get_usage_summary が service_role から呼べない';
  end if;

  raise notice '運営の利用状況の回答数を、人と仕組みに分けました（関数1本の差し替え）。';
end $$;
