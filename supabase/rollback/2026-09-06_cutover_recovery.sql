-- ============================================================================
-- 2026-09-06 の本番切り替えで、失敗した地点ごとに戻すための SQL
-- ============================================================================
--
-- 【この日は1本も実行しない】
--   ここに書いてあるのは「もし落ちたらこれを流す」という控えである。
--   手順そのものは docs/prod-runbook.md にある。**どの節を流すかは、
--   その節の見出しに書いた症状が実際に出たときにだけ決める。**
--
-- 【流し方】
--   必要な節だけを選んで、その節ごと1回のトランザクションで流す。
--   ファイル全体をまとめて流さない。節どうしは独立している。
--
-- 【共通の性質】
--   ・A から F まで、**データを1行も消さない。書き換えもしない。**
--     触るのは関数の定義と権限だけである。
--   ・どれも何度流しても同じ結果になる（`create or replace` と `grant`）。
--
-- 【この SQL で戻らないもの】
--   掃除（cleanup）が既に消したものは、ここでは戻らない。
--   Supabase のバックアップから復元する。手順書の 2-L。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- A. 症状: 旧い画面の作品一覧（/works）が 500 になる
--    原因の疑い: get_public_works の旧5引数版が消えている
-- ----------------------------------------------------------------------------
--
-- 旧5引数版を、新6引数版を呼ぶだけの入口として入れ直す。
-- 返す列は本番の従来のものと1列も違わない。未回答フィルタは掛けない。

begin;

create or replace function public.get_public_works(
  p_division     text default null,
  p_sort         text default 'new',
  p_limit        int  default 24,
  p_offset       int  default 0,
  p_completeness text default null
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  completeness        text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.get_public_works(
    p_division, p_sort, p_limit, p_offset, p_completeness, false
  );
$$;

revoke all on function public.get_public_works(text, text, int, int, text)
  from public, anon, authenticated;
grant execute on function public.get_public_works(text, text, int, int, text)
  to anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- B. 症状: 旧い画面のモード選択（/play）が 500 になる
--    原因の疑い: draft_modes.quiz_question_count の列か、その読み取り権限が無い
-- ----------------------------------------------------------------------------
--
-- 列そのものが消えている場合は、まず列を戻す。既定値3で入れ直す。
-- **既存の行の値は戻らない**（消した時点で失われている）ので、
-- 列が消えていたときは、その事実を検証記録に残すこと。

begin;

alter table public.draft_modes
  add column if not exists quiz_question_count int not null default 3;

alter table public.draft_sessions
  add column if not exists quiz_question_count int;

revoke all on table public.draft_modes from public, anon, authenticated;
grant select (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
              sort_order, uses_two_stage, word_count_min, word_count_max, morph_max)
  on public.draft_modes to anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- C. 症状: 「次の作品」が 500 になる／旧い画面から2引数で呼べない
--    原因の疑い: get_next_work の旧2引数版が消えている
-- ----------------------------------------------------------------------------
--
-- 2番目の引数は受け取るだけで使わない。**既定値を付けないこと。**
-- 付けると引数1個の呼び出しが両方に当てはまり、新旧どちらも失敗する。

begin;

create or replace function public.get_next_work(
  p_current_work_id uuid,
  p_division        text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.get_next_work(p_current_work_id);
$$;

revoke all on function public.get_next_work(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_next_work(uuid, text) to anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- D. 症状: 一覧や次の作品が「function is not unique」で失敗する
--    原因の疑い: 新版に既定値が付いていて、旧版と行き先が割れている
-- ----------------------------------------------------------------------------
--
-- 新6引数版から既定値を全部外す。既定値の付け外しは
-- create or replace ではできないので、drop してから作り直す。
-- **同じトランザクションの中なので、関数が無い時間は外から見えない。**
--
-- 中身は 20260906090000 のものと同じ。ここに写しを置くのは、
-- 落ちている最中に migration ファイルを探させないため。

begin;

drop function if exists public.get_public_works(text, text, int, int, text, boolean);

create function public.get_public_works(
  p_division         text,
  p_sort             text,
  p_limit            int,
  p_offset           int,
  p_completeness     text,
  p_unanswered_only  boolean
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  completeness        text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id, w.title, w.image_path, w.image_width, w.image_height,
    w.division, w.completeness, w.source_title, w.source_character,
    w.fanart_note, w.actual_time_seconds,
    p.time_limit_seconds, p.mode_key, p.was_rerolled,
    w.likes_count, w.saves_count, w.answers_count, w.created_at,
    pr.id, pr.handle, pr.display_name
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and case
          when p_division is null  then w.division <> 'ai'
          when p_division = 'all'  then true
          else w.division = p_division
        end
    and (p_completeness is null or w.completeness = p_completeness)
    and (
      not coalesce(p_unanswered_only, false)
      or (select auth.uid()) is null
      or not exists (select 1 from public.answers a
                      where a.work_id = w.id
                        and a.user_id = (select auth.uid()))
    )
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.get_public_works(text, text, int, int, text, boolean)
  from public, anon, authenticated;
grant execute on function public.get_public_works(text, text, int, int, text, boolean)
  to anon, authenticated;

commit;


-- ----------------------------------------------------------------------------
-- E. 症状: permission denied / 匿名の回答が通らない
--    原因の疑い: 公開する関数の実行権限が配り直されていない
-- ----------------------------------------------------------------------------
--
-- 未サインインでも通す必要があるものだけを、名前で並べて配り直す。
-- **ここに無い関数へは権限を足さない。**

begin;

do $$
declare
  v_sig text;
begin
  for v_sig in
    select p.oid::regprocedure::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'get_public_works', 'get_work_detail', 'get_work_quiz',
         'get_public_profile', 'get_public_answers', 'get_user_works',
         'get_rankings', 'get_handle_redirect', 'get_current_documents',
         'get_next_work', 'next_work_candidates', 'record_usage_event'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', v_sig);
    execute format('grant execute on function %s to anon, authenticated', v_sig);
  end loop;
end $$;

commit;


-- ----------------------------------------------------------------------------
-- F. 症状: 作品の投稿が「期限切れ」で拒まれる（旧い画面が動いている時間帯）
--    原因の疑い: 制作の期限のガードが、タイマーを知らない画面に当たっている
-- ----------------------------------------------------------------------------
--
-- 【これは機能を一時的に止める。実行にはユーザーの承認が要る】
--   ガードを外すと、期限を過ぎた投稿が通るようになる。
--   データは1行も変わらない。**新しい画面を出したら、必ず戻す。**
--
--   戻すときは 20260904094000 の該当部分を当て直す。

-- 外す（承認が要る）
-- drop trigger if exists works_guard_prompt_deadline_trigger on public.works;

-- 戻す（新しい画面を出したあと）
-- create trigger works_guard_prompt_deadline_trigger
--   before insert on public.works
--   for each row execute function public.works_guard_prompt_deadline();

-- **上の2行はコメントのままにしてある。**
-- 承認を受けてから、その場でコメントを外して流すこと。
