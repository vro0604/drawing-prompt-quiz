-- ============================================================================
-- 20260912100000_system_answer_out_of_analysis_and_import.sql
--   システム回答を、作者向けの分析と取り込み枠から外す
-- ============================================================================
--
-- 【何のためか】
--   Phase 1（20260911090000）で、回答に「何が答えたか」（answer_source）を持たせ、
--   人間の回答だけが回答数・伝達率・枠ごとの集計・順位・配給・成績を動かすようにした。
--
--   ところが Phase 1 を作った土台には無く、本番には入っている機能がある。
--   作者向けの分析（20260908120000 / 20260908160000）と、取り込み枠
--   （20260909090000）である。この2つは answer_source を知らないので、
--   システム回答を人間の回答と同じに扱う。
--     ・自動取り込みが入っている作品では、システム回答が作者の枠を1つ使う
--     ・作者の分析・回答一覧・掘り下げに、システム回答が1人分として混ざる
--
--   出所: ユーザー指示（2026-09-11）「システム回答は：作者向け分析に含めない／
--   取り込み枠を消費しない」「システム回答は、『初回に結果を見せるための補助回答』
--   であり、人間回答の代替統計データではない。」
--
-- 【直し方: 母集団を決める場所で絞る】
--   分析の母集団を決める関数は2本しかない。
--     ・analysis_all_answers      … 無料の集計が数える相手
--     ・analysis_advanced_answers … 掘り下げが数える相手
--   作者の集計（get_work_answer_analysis）・掘り下げ（get_work_drilldown）・
--   語ごとの数（answer_word_stats）は、この2本が返した回答だけを読む。
--   だから**この2本で人間に絞れば、下流の3本は触らずに済む。**
--
--   母集団の関数を通らずに answers を直接読んでいる関数が4本ある。
--   それぞれの読み取りに同じ絞り込みを足す。
--     ・get_work_answer_list    … 作者向けの回答一覧（通し番号を振る）
--     ・set_answer_excluded     … 番号を指定して分析から外す（同じ番号を使う）
--     ・get_work_import_state   … 枠の状態（回答の総数・未取り込みの数）
--     ・get_my_answer_analysis  … 答え終わった本人に返す集計（他の回答との一致）
--
--   取り込み枠は2か所で止める。
--     ・answers_after_insert_auto_import … 回答が入った瞬間の自動取り込み。
--       システム回答なら、枠を読みにも行かずに帰る
--     ・consume_import_capacity … 取り込む回答を選ぶ唯一の場所。
--       手動の取り込み（import_answers）もここを通る
--   自動取り込みの側だけで止めると、システム回答が入った瞬間に
--   「まだ取り込んでいない古い人間の回答」を1件取り込んでしまう
--   （選ぶ関数は、入った回答ではなく古い順に選ぶため）。だから入口でも止める。
--
-- 【番号と、分析から外す操作】
--   回答一覧の通し番号と、分析から外す操作の番号は、同じ数え方でなければ
--   別の回答を外してしまう。**2本とも人間の回答だけに番号を振る。**
--   システム回答には番号が無いので、外す操作では指定できない。
--   存在しない番号を渡したときは、今までどおり ANSWER_NOT_FOUND で断る
--   （新しい失敗の名前は作らない）。
--
-- 【関数の中身は手で書き写していない】
--   61本（本番相当59本＋Phase 1・2）を当てた検査用DBから定義を取り出し、
--   answer_source の絞り込みを足す箇所だけを置き換えた。置き換えは
--   「ちょうど決めた回数だけ当たる」ことを確かめてから書いている。
--   取り出した定義は、本番の定義と中身が一致することを 2026-09-11 に確かめた
--   （本番の読み取り監査。空白を除いて一致）。
--   署名・持ち主の資格（SECURITY DEFINER）・search_path・権限は変えていない。
--   CREATE OR REPLACE は権限を引き継ぐ。
--
-- 【人間の回答だけの作品では、何も変わらない】
--   足したのは「answer_source = 'human'」の条件だけで、既存の回答はすべて human。
--   本番にはまだ system の回答が1件も無い（Phase 1 自体が本番未適用）。
--
-- 【触っていないもの】
--   出所: ユーザー指示（2026-09-11）「以下は混ぜない：migration history 180000
--   repair / billing / legal / Stripe / provider / opt-out / onboarding state /
--   queue auto-enqueue / UI / notices/result表示 / smoke-race flaky /
--   unrelated ACL cleanup」。
--   回答の知らせ（has_unseen_results / list_unseen_result_works）と、
--   運営の利用状況（get_usage_summary）は、answers を読むがここでは触らない。
--
-- 【版番号の選び方】
--   本番の履歴の最大は 20260910210000（読み取り監査、2026-09-11）。
--   全作業木・全ローカルブランチ・全リモートブランチの最大は 20260912090000
--   （Phase 2）。20260912100000 はどこにも無い（実測 2026-09-11）。
--
-- 【戻し方】
--   直前の定義は、7本が 20260909090000_import_capacity.sql、
--   get_my_answer_analysis が 20260908160000_analysis_drilldown.sql にある。
--   その CREATE OR REPLACE を流し直せば戻る。表と行には触れていない。

begin;

-- ── 1. 取り込み枠: 入口と、取り込む回答を選ぶ場所 ────────────────

CREATE OR REPLACE FUNCTION public.answers_after_insert_auto_import()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_on boolean;
begin
  -- 人間の回答だけが取り込み枠を使う（D196）。システム回答では何もしない
  if new.answer_source is distinct from 'human' then
    return null;
  end if;

  select s.auto_import into v_on
    from public.work_import_state s
   where s.work_id = new.work_id;

  if coalesce(v_on, false) then
    perform public.consume_import_capacity(new.work_id, 'auto', 1);
  end if;

  return null;
end;
$function$;

CREATE OR REPLACE FUNCTION public.consume_import_capacity(p_work_id uuid, p_source text, p_limit integer DEFAULT NULL::integer)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_remaining int;
  v_take      int;
  v_done      int;
begin
  perform public.ensure_work_import_state(p_work_id);

  -- **ここが錠。**同じ作品への取り込みは、必ずこの行で順番待ちになる
  perform 1 from public.work_import_state s
    where s.work_id = p_work_id
    for update;

  v_remaining := public.work_remaining_capacity(p_work_id);
  if v_remaining <= 0 then
    return 0;
  end if;

  v_take := v_remaining;
  if p_limit is not null and p_limit < v_take then
    v_take := p_limit;
  end if;
  if v_take <= 0 then
    return 0;
  end if;

  with target as (
    select a.id
      from public.answers a
     where a.work_id = p_work_id
       and a.answer_source = 'human'
       and not exists (
         select 1 from public.analysis_imports i where i.answer_id = a.id
       )
     order by a.created_at, a.id
     limit v_take
  )
  insert into public.analysis_imports (answer_id, work_id, source)
  select t.id, p_work_id, p_source from target t
  on conflict (answer_id) do nothing;

  get diagnostics v_done = row_count;

  if v_done > 0 then
    perform public.record_capacity_thresholds(p_work_id);
  end if;

  return v_done;
end;
$function$;

-- ── 2. 分析の母集団と、answers を直接読む窓口 ──────────────

CREATE OR REPLACE FUNCTION public.analysis_all_answers(p_work_id uuid)
 RETURNS TABLE(answer_id bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id from public.answers a where a.work_id = p_work_id and a.answer_source = 'human';
$function$;

CREATE OR REPLACE FUNCTION public.analysis_advanced_answers(p_work_id uuid)
 RETURNS TABLE(answer_id bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id
    from public.answers a
    join public.analysis_imports i on i.answer_id = a.id
   where a.work_id = p_work_id
     and a.answer_source = 'human'
     and not exists (
       select 1 from public.analysis_exclusions x where x.answer_id = a.id
     );
$function$;

CREATE OR REPLACE FUNCTION public.get_work_answer_list(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid    uuid := (select auth.uid());
  v_prompt uuid;
  v_questions int;
begin
  if v_uid is null then
    return null;
  end if;

  select w.prompt_id into v_prompt
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  return (
    with numbered as (
      select a.id,
             a.created_at,
             row_number() over (order by a.created_at, a.id) as no
        from public.answers a
       where a.work_id = p_work_id
         and a.answer_source = 'human'
    ),
    per as (
      select n.id, n.no, n.created_at,
             count(*) filter (where ai.is_correct) as corrects,
             count(*) as items,
             count(*) filter (where ai.answer_mode = 'exact' and ai.is_correct)
               as exact_corrects
        from numbered n
        join public.answer_items ai on ai.answer_id = n.id
       group by n.id, n.no, n.created_at
    )
    select jsonb_build_object(
      'total',          (select count(*) from numbered),
      'excluded_count', (
        select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
      ),
      'imported_count', public.work_imported_count(p_work_id),
      'question_count', v_questions,
      'answers', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'no',               p.no,
                   'answered_at',      p.created_at,
                   'correct_sections', p.corrects,
                   'question_count',   p.items,
                   'is_perfect_exact',
                     p.items = v_questions and p.exact_corrects = v_questions,
                   'is_excluded', exists (
                     select 1 from public.analysis_exclusions x where x.answer_id = p.id
                   ),
                   'is_imported', exists (
                     select 1 from public.analysis_imports i where i.answer_id = p.id
                   )
                 )
                 order by p.no
               )
          from per p
      ), '[]'::jsonb)
    )
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.set_answer_excluded(p_work_id uuid, p_answer_nos integer[], p_excluded boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_ids bigint[];
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if not exists (
    select 1 from public.works w
     where w.id = p_work_id and w.user_id = v_uid and w.deleted_at is null
  ) then
    raise exception 'NOT_WORK_OWNER: 自分の作品の分析だけが変えられます。';
  end if;

  if p_answer_nos is null or cardinality(p_answer_nos) = 0 then
    raise exception 'NO_TARGET: 対象が選ばれていません。';
  end if;

  with numbered as (
    select a.id, row_number() over (order by a.created_at, a.id) as no
      from public.answers a
     where a.work_id = p_work_id
       and a.answer_source = 'human'
  )
  select coalesce(array_agg(n.id), array[]::bigint[])
    into v_ids
    from numbered n
   where n.no = any (p_answer_nos);

  if cardinality(v_ids) <> cardinality(p_answer_nos) then
    raise exception 'ANSWER_NOT_FOUND: 指定した回答が見つかりません。画面を開き直してください。';
  end if;

  if p_excluded then
    insert into public.analysis_exclusions (answer_id, work_id, excluded_by)
    select id, p_work_id, v_uid from unnest(v_ids) as u(id)
    on conflict (answer_id) do nothing;
  else
    delete from public.analysis_exclusions x where x.answer_id = any (v_ids);
  end if;

  return jsonb_build_object(
    'changed',        cardinality(v_ids),
    'excluded_count', (
      select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
    ),
    -- 高度分析の対象になる回答の数（取り込み済み かつ 外していない）
    'analysed_count', (
      select count(*) from public.analysis_advanced_answers(p_work_id)
    ),
    -- **枠は戻らない。**確かめられるように、そのままの数を返す
    'remaining_capacity', public.work_remaining_capacity(p_work_id)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_work_import_state(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid   uuid := (select auth.uid());
  v_state record;
begin
  if v_uid is null then
    return null;
  end if;

  if not exists (
    select 1 from public.works w where w.id = p_work_id and w.user_id = v_uid
  ) then
    return null;
  end if;

  select s.auto_import, s.epoch, s.epoch_base into v_state
    from public.work_import_state s
   where s.work_id = p_work_id;

  return jsonb_build_object(
    'granted_total', public.work_granted_capacity(p_work_id),
    'imported',      public.work_imported_count(p_work_id),
    'remaining',     public.work_remaining_capacity(p_work_id),
    'auto_import',   coalesce(v_state.auto_import, false),
    'epoch',         coalesce(v_state.epoch, 0),
    'epoch_base',    coalesce(v_state.epoch_base, 0),

    'answers_total', (
      select count(*) from public.answers a where a.work_id = p_work_id and a.answer_source = 'human'
    ),
    'unimported', (
      select count(*) from public.answers a
       where a.work_id = p_work_id
         and a.answer_source = 'human'
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),
    'excluded', (
      select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
    ),
    'advanced', (select count(*) from public.analysis_advanced_answers(p_work_id)),

    -- 未取り込みの回答が、いつからいつまでのものか
    'oldest_unimported_at', (
      select min(a.created_at) from public.answers a
       where a.work_id = p_work_id
         and a.answer_source = 'human'
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),
    'latest_unimported_at', (
      select max(a.created_at) from public.answers a
       where a.work_id = p_work_id
         and a.answer_source = 'human'
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),

    'grants', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',          g.id,
                 'quantity',    g.quantity,
                 'source_type', g.source_type,
                 'source_ref',  g.source_ref,
                 'created_at',  g.created_at
               )
               order by g.created_at desc, g.id desc
             )
        from public.work_capacity_grants g
       where g.work_id = p_work_id
    ), '[]'::jsonb),

    'notifications', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'kind',       n.kind,
                 'epoch',      n.epoch,
                 'remaining',  n.remaining_at_event,
                 'base',       n.base_at_event,
                 'created_at', n.created_at,
                 'email_sent', n.email_sent_at is not null
               )
               order by n.created_at desc
             )
        from public.capacity_notifications n
       where n.work_id = p_work_id
    ), '[]'::jsonb)
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_answer_analysis(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid       uuid := (select auth.uid());
  v_answer_id bigint;
  v_prompt    uuid;
  v_questions int;
  v_all       bigint[];
begin
  if v_uid is null then
    return null;
  end if;

  select a.id into v_answer_id
    from public.answers a
   where a.work_id = p_work_id and a.user_id = v_uid;

  if not found then
    return null;
  end if;

  select w.prompt_id into v_prompt from public.works w where w.id = p_work_id;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  -- **外した回答も入れる。**作者の都合で他人の見え方を変えない
  select coalesce(array_agg(a.id), array[]::bigint[])
    into v_all
    from public.answers a
   where a.work_id = p_work_id and a.answer_source = 'human';

  return (
    with sets as (
      select ai.answer_id,
             ai.question_id,
             (
               select array_agg(u.x order by u.x)
                 from unnest(array[ai.selected_tag_id, ai.selected_tag_id_2]) as u(x)
                where u.x is not null
             ) as tags
        from public.answer_items ai
        join public.answers a on a.id = ai.answer_id
       where a.work_id = p_work_id
         and a.answer_source = 'human'
    ),
    mine as (
      select question_id, tags from sets where answer_id = v_answer_id
    ),
    matches as (
      select o.answer_id,
             count(*) filter (where o.tags = m.tags) as n
        from sets o
        join mine m on m.question_id = o.question_id
       where o.answer_id <> v_answer_id
       group by o.answer_id
    ),
    per_answer as (
      select a.id as answer_id,
             string_agg(
               case when ai.is_correct then '1' else '0' end, ''
               order by qq.position
             ) as pattern,
             count(*) as items,
             count(*) filter (
               where ai.answer_mode = 'exact' and ai.is_correct
             ) as exact_corrects
        from public.answers a
        join public.answer_items ai   on ai.answer_id = a.id
        join public.quiz_questions qq on qq.id = ai.question_id
       where a.work_id = p_work_id
         and a.answer_source = 'human'
       group by a.id
    )
    select jsonb_build_object(
      'answers_count',  (select count(*) from public.answers a where a.work_id = p_work_id and a.answer_source = 'human'),
      'others_count',   (select count(*) from matches),
      'question_count', v_questions,
      'my_pattern',     (select p.pattern from per_answer p where p.answer_id = v_answer_id),
      'is_perfect_exact', (
        select p.items = v_questions and p.exact_corrects = v_questions
          from per_answer p where p.answer_id = v_answer_id
      ),
      'perfect_exact_count', (
        select count(*) from per_answer p
         where p.items = v_questions and p.exact_corrects = v_questions
      ),
      'match_histogram', coalesce((
        select jsonb_agg(x.obj order by x.matches desc)
          from (
            select mt.n as matches,
                   jsonb_build_object('matches', mt.n, 'count', count(*)) as obj
              from matches mt
             group by mt.n
          ) x
      ), '[]'::jsonb),
      'sections', public.answer_word_stats(p_work_id, v_all)
    )
  );
end;
$function$;

-- ── 3. ここまでを自分で検算する ────────────────────────

do $check$
declare
  v int;
  v_names text[] := array[
    'answers_after_insert_auto_import', 'consume_import_capacity',
    'analysis_all_answers', 'analysis_advanced_answers',
    'get_work_answer_list', 'set_answer_excluded',
    'get_work_import_state', 'get_my_answer_analysis'];
  v_windows text[] := array[
    'get_work_answer_list', 'set_answer_excluded',
    'get_work_import_state', 'get_my_answer_analysis'];
begin
  -- (1) 8本とも1つずつ。署名が増えていない（重ね定義を作っていない）
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_names);
  if v <> 8 then raise exception '検算1: 対象の関数が %本（8本のはず）', v; end if;

  -- (2) 8本とも、人間の回答に絞る条件を持つ
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_names)
     and p.prosrc like '%answer_source%';
  if v <> 8 then raise exception '検算2: 人間に絞った関数が %本（8本のはず）', v; end if;

  -- (3) 持ち主の資格と、空の search_path が保たれている
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_names)
     and p.prosecdef and array_to_string(p.proconfig, ',') = 'search_path=""';
  if v <> 8 then raise exception '検算3: 資格か search_path が崩れた関数がある（%本が正常）', v; end if;

  -- (4) 匿名は8本のどれも呼べない
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_names)
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v <> 0 then raise exception '検算4: 匿名が呼べる関数が %本', v; end if;

  -- (5) 利用者が呼べるのは、もとから窓口だった4本だけ
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_names)
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v <> 4 then raise exception '検算5: 利用者が呼べる関数が %本（4本のはず）', v; end if;

  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = any (v_windows)
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v <> 4 then raise exception '検算6: 窓口4本のうち呼べるのが %本', v; end if;

  -- (6) 自動取り込みの引き金は、回答の表に付いたまま
  select count(*) into v
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
   where c.relname = 'answers' and t.tgname = 'answers_after_insert_auto_import'
     and not t.tgisinternal;
  if v <> 1 then raise exception '検算7: 自動取り込みの引き金が %本', v; end if;

  -- (7) システム回答が取り込み済みになっていない（ここで入った行は無い）
  select count(*) into v
    from public.analysis_imports i join public.answers a on a.id = i.answer_id
   where a.answer_source <> 'human';
  if v <> 0 then raise exception '検算8: システム回答が %件取り込まれている', v; end if;

  select count(*) into v
    from public.analysis_exclusions x join public.answers a on a.id = x.answer_id
   where a.answer_source <> 'human';
  if v <> 0 then raise exception '検算9: システム回答が %件、分析から外す印を持っている', v; end if;

  raise notice '検算: 9項目すべて合いました';
end $check$;

commit;
