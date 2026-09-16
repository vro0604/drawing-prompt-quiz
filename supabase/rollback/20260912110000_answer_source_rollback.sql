-- ============================================================================
-- 20260912110000_answer_source.sql を取り消す（20260912110000 を当てる前の状態へ戻す）
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
--   - D196 と D195（20260912130000 / 20260912120000）を先に取り消してある
--
-- 【流したあと】履歴から外す: npx supabase migration repair 20260912110000 --status reverted --linked
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
    raise exception '取り消しを止めました: 先に 20260912130000（D196）を取り消してください';
  end if;
  if to_regclass('public.system_answer_queue') is not null then
    raise exception '取り消しを止めました: 先に 20260912120000（D195）を取り消してください';
  end if;
end $$;

-- ── 引き金を外す ────────────────────────────────────────────
drop trigger if exists answers_guard_source_immutable on public.answers;

-- ── 変わった関数 9 本を、当てる前の定義へ書き戻す ─────────────

-- answer_items_after_insert_hint_stats()
CREATE OR REPLACE FUNCTION public.answer_items_after_insert_hint_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_work_id uuid;
  v_hint    boolean;
begin
  select a.work_id, a.hint_used into v_work_id, v_hint
    from public.answers a where a.id = new.answer_id;

  insert into public.work_hint_stats (work_id, hint_used, total_items, correct_items)
  values (v_work_id, v_hint, 1, case when new.is_correct then 1 else 0 end)
  on conflict (work_id, hint_used) do update
    set total_items   = work_hint_stats.total_items + 1,
        correct_items = work_hint_stats.correct_items
                        + case when new.is_correct then 1 else 0 end,
        updated_at    = clock_timestamp();
  return null;
end;
$function$;

-- answer_items_after_insert_stats()
CREATE OR REPLACE FUNCTION public.answer_items_after_insert_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_work_id uuid;
  v_user_id uuid;
  v_correct int := case when new.is_correct then 1 else 0 end;
  v_exact   int := case when new.answer_mode = 'exact' then 1 else 0 end;
  v_pair    int := case when new.answer_mode = 'pair'  then 1 else 0 end;
  v_exact_c int := case when new.answer_mode = 'exact' and new.is_correct then 1 else 0 end;
  v_pair_c  int := case when new.answer_mode = 'pair'  and new.is_correct then 1 else 0 end;
begin
  select a.work_id, a.user_id
    into v_work_id, v_user_id
    from public.answers a
   where a.id = new.answer_id;

  insert into public.work_slot_stats as st
    (work_id, card_slot_key, attempts, corrects,
     exact_attempts, exact_corrects, pair_attempts, pair_corrects, updated_at)
  values (v_work_id, new.card_slot_key, 1, v_correct,
          v_exact, v_exact_c, v_pair, v_pair_c, now())
  on conflict (work_id, card_slot_key) do update
    set attempts       = st.attempts + 1,
        corrects       = st.corrects + v_correct,
        exact_attempts = st.exact_attempts + v_exact,
        exact_corrects = st.exact_corrects + v_exact_c,
        pair_attempts  = st.pair_attempts + v_pair,
        pair_corrects  = st.pair_corrects + v_pair_c,
        updated_at     = now();

  if v_user_id is not null then
    insert into public.user_stats as us
      (user_id, total_items, total_correct_items,
       exact_items, exact_correct_items, pair_items, pair_correct_items, updated_at)
    values (v_user_id, 1, v_correct, v_exact, v_exact_c, v_pair, v_pair_c, now())
    on conflict (user_id) do update
      set total_items         = us.total_items + 1,
          total_correct_items = us.total_correct_items + v_correct,
          exact_items         = us.exact_items + v_exact,
          exact_correct_items = us.exact_correct_items + v_exact_c,
          pair_items          = us.pair_items + v_pair,
          pair_correct_items  = us.pair_correct_items + v_pair_c,
          updated_at          = now();

    insert into public.user_slot_stats as uss
      (user_id, card_slot_key, attempts, corrects,
       exact_attempts, exact_corrects, pair_attempts, pair_corrects, updated_at)
    values (v_user_id, new.card_slot_key, 1, v_correct,
            v_exact, v_exact_c, v_pair, v_pair_c, now())
    on conflict (user_id, card_slot_key) do update
      set attempts       = uss.attempts + 1,
          corrects       = uss.corrects + v_correct,
          exact_attempts = uss.exact_attempts + v_exact,
          exact_corrects = uss.exact_corrects + v_exact_c,
          pair_attempts  = uss.pair_attempts + v_pair,
          pair_corrects  = uss.pair_corrects + v_pair_c,
          updated_at     = now();
  end if;

  return null;
end;
$function$;

-- answers_after_insert_hint_stats()
CREATE OR REPLACE FUNCTION public.answers_after_insert_hint_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  insert into public.work_hint_stats (work_id, hint_used, answers_count)
  values (new.work_id, new.hint_used, 1)
  on conflict (work_id, hint_used) do update
    set answers_count = work_hint_stats.answers_count + 1,
        updated_at    = clock_timestamp();
  return null;
end;
$function$;

-- answers_after_insert_stats()
CREATE OR REPLACE FUNCTION public.answers_after_insert_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  update public.works w
     set answers_count = w.answers_count + 1
   where w.id = new.work_id;

  if new.user_id is not null then
    insert into public.user_stats as us (user_id, total_answers, updated_at)
    values (new.user_id, 1, now())
    on conflict (user_id) do update
      set total_answers = us.total_answers + 1,
          updated_at    = now();
  end if;

  return null;   -- after トリガーなので戻り値は使われない
end;
$function$;

-- get_my_answer(uuid)
CREATE OR REPLACE FUNCTION public.get_my_answer(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'work_id',        w.id,
    'work_title',     w.title,
    'correct_count',  a.correct_count,
    'question_count', a.question_count,
    'exact_attempts', a.exact_attempts,
    'exact_corrects', a.exact_corrects,
    'pair_attempts',  a.pair_attempts,
    'pair_corrects',  a.pair_corrects,
    'scoring_version', a.scoring_version,
    'answered_at',    a.created_at,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',       ai.question_id,
                 'card_slot_key',     ai.card_slot_key,
                 'card_slot_label',   cs.label,
                 'answer_mode',       ai.answer_mode,
                 'selected_tag_id',   ai.selected_tag_id,
                 'selected_label',    sel.label,
                 'selected_tag_id_2', ai.selected_tag_id_2,
                 'selected_label_2',  sel2.label,
                 'is_correct',        ai.is_correct,
                 'correct_tag_id',    pc.tag_id,
                 'correct_label',     cor.label
               )
               order by q.position
             )
        from public.answer_items ai
        join public.quiz_questions q  on q.id = ai.question_id
        join public.card_slots    cs  on cs.card_slot_key = ai.card_slot_key
        join public.tags          sel on sel.id = ai.selected_tag_id
        left join public.tags     sel2 on sel2.id = ai.selected_tag_id_2
        join public.prompt_cards  pc  on pc.prompt_id = q.prompt_id
                                     and pc.card_slot_key = q.card_slot_key
        join public.tags          cor on cor.id = pc.tag_id
       where ai.answer_id = a.id
    ), '[]'::jsonb)
  )
  from public.answers a
  join public.works w on w.id = a.work_id
  where a.work_id = p_work_id
    and a.user_id = (select auth.uid());
$function$;

-- get_my_answers(integer,integer)
CREATE OR REPLACE FUNCTION public.get_my_answers(p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS TABLE(work_id uuid, work_title text, image_path text, correct_count integer, item_count bigint, answered_at timestamp with time zone, author_handle text, author_display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    w.id,
    w.title,
    w.image_path,
    a.correct_count,
    (select count(*) from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.handle,
    pr.display_name
  from public.answers a
  join public.works    w  on w.id  = a.work_id
  join public.profiles pr on pr.id = w.user_id
  where a.user_id = (select auth.uid())
  order by a.created_at desc, a.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

-- get_my_work_result(uuid)
CREATE OR REPLACE FUNCTION public.get_my_work_result(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
begin
  if v_uid is null then
    return null;
  end if;

  select true into v_ok
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  return (
    with ans as (
      select a.id, a.correct_count, a.question_count, a.scoring_version
        from public.answers a
       where a.work_id = p_work_id
    ),
    items as (
      select ai.card_slot_key, ai.selected_tag_id, ai.selected_tag_id_2,
             ai.is_correct, ai.answer_mode
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
    ),
    per_answer as (
      select ai.answer_id, count(*) as total, sum((ai.is_correct)::int) as corrects
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
       group by ai.answer_id
    ),
    -- 誤答に選ばれた語。2択当ての2語目も数える（どちらも「そう読まれた」ため）
    picked as (
      select i.card_slot_key, i.selected_tag_id as tag_id from items i where not i.is_correct
      union all
      select i.card_slot_key, i.selected_tag_id_2 from items i
       where not i.is_correct and i.selected_tag_id_2 is not null
    )
    select jsonb_build_object(
      'answers_count', (select count(*) from ans),
      'blind_count', (
        select count(*) from per_answer pa where pa.corrects = 0
      ),

      -- **分母は実際に出題された問の数。**3で割らない（D165）
      'total_items',   (select count(*) from items),
      'correct_items', (select count(*) from items i where i.is_correct),

      -- 方式別。重みを付けて1つにまとめない（D165 の 11-2）
      'exact_items',   (select count(*) from items i where i.answer_mode = 'exact'),
      'exact_correct', (select count(*) from items i where i.answer_mode = 'exact' and i.is_correct),
      'pair_items',    (select count(*) from items i where i.answer_mode = 'pair'),
      'pair_correct',  (select count(*) from items i where i.answer_mode = 'pair' and i.is_correct),

      -- 枠ごとの方式別。「どの要素が断定で伝わり、どの要素は2つまでしか
      -- 絞られなかったか」を作者へ返す（D165 の 5 / 6）
      'slots', coalesce((
        select jsonb_agg(x.obj order by x.priority)
          from (
            select cs.quiz_priority as priority,
                   jsonb_build_object(
                     'card_slot_key',   i.card_slot_key,
                     'card_slot_label', cs.label,
                     'attempts',        count(*),
                     'corrects',        count(*) filter (where i.is_correct),
                     'exact_attempts',  count(*) filter (where i.answer_mode = 'exact'),
                     'exact_corrects',  count(*) filter (where i.answer_mode = 'exact' and i.is_correct),
                     'pair_attempts',   count(*) filter (where i.answer_mode = 'pair'),
                     'pair_corrects',   count(*) filter (where i.answer_mode = 'pair' and i.is_correct)
                   ) as obj
              from items i
              join public.card_slots cs on cs.card_slot_key = i.card_slot_key
             group by i.card_slot_key, cs.label, cs.quiz_priority
          ) x
      ), '[]'::jsonb),

      -- 旧方式の回答が混ざっているか。混ぜて平均を取らせないための印
      'legacy_answers', (
        select count(*) from ans where ans.scoring_version = 'v1_fixed_count'
      ),

      'misreads', coalesce((
        select jsonb_agg(x.obj order by x.n desc, x.label)
          from (
            select cs.label   as slot_label,
                   t.label    as label,
                   count(*)   as n,
                   jsonb_build_object(
                     'slot_label', cs.label,
                     'tag_label',  t.label,
                     'count',      count(*)
                   ) as obj
              from picked i
              join public.tags t        on t.id = i.tag_id
              join public.card_slots cs on cs.card_slot_key = i.card_slot_key
             group by cs.label, t.label
          ) x
      ), '[]'::jsonb)
    )
  );
end;
$function$;

-- get_public_answers(uuid,integer,integer)
CREATE OR REPLACE FUNCTION public.get_public_answers(p_user_id uuid, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS TABLE(work_id uuid, title text, image_path text, image_width integer, image_height integer, division text, correct_count integer, item_count integer, answered_at timestamp with time zone, author_id uuid, author_handle text, author_display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    a.correct_count,
    (select count(*)::int from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.answers a
    join public.works    w  on w.id  = a.work_id
    join public.profiles pr on pr.id = w.user_id
  where a.user_id = p_user_id
    and (
      p_user_id = (select auth.uid())
      or exists (
        select 1 from public.profiles o
         where o.id = p_user_id
           and o.is_anonymous = false
           and o.handle is not null
           and o.show_answer_history
      )
    )
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by a.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;

-- next_work_candidates(uuid)
CREATE OR REPLACE FUNCTION public.next_work_candidates(p_current_work_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(work_id uuid, band integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := (select auth.uid());
  v_division text;
begin
  -- いま答えた作品の部門を、**その作品の行から**取る。
  -- クライアントは部門を渡せない（引数が無い）。
  if p_current_work_id is not null then
    select w.division
      into v_division
      from public.works w
     where w.id = p_current_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null;

    -- 非公開・審査未通過・削除済み・存在しないID。
    -- **どれも同じ「候補なし」で返す。**理由を分けると、
    -- そのIDの作品が在るのか無いのかを外から数えられてしまう（D40）。
    --
    -- 判定に FOUND を使う。行が無いとき select into は変数を NULL にするので、
    -- 「見つかったか」を自前の真偽値で持つと `not NULL` が真にならず、
    -- **素通りする**（実測: 存在しないIDで次の作品が返った）。
    if not found then
      return;
    end if;
  end if;

  return query
    select w.id,
           case when exists (select 1 from public.answers a where a.work_id = w.id)
                then 2 else 1 end
      from public.works w
     where w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
       -- いま見ている作品そのものは出さない
       and (p_current_work_id is null or w.id <> p_current_work_id)
       -- 部門。**現在の作品と同じものだけ**（D169 の12）。
       -- 現在の作品が無いとき（直接呼ばれたとき）だけ、
       -- 一覧の既定と同じ「AI以外」に落とす。AI を常に除く条件は残さない。
       and (
         case
           when v_division is not null then w.division = v_division
           else w.division <> 'ai'
         end
       )
       -- 自分の作品には答えられない（D28）
       and (v_uid is null or w.user_id <> v_uid)
       -- すでに答えた作品は出さない
       and (v_uid is null
            or not exists (select 1 from public.answers a
                            where a.work_id = w.id and a.user_id = v_uid));
end;
$function$;

-- ── 増えた関数 1 本を消す ──────────────────────────────
drop function if exists public.answers_guard_source_immutable();

-- ── 増えた制約・索引・列を消す ────────────────────────────────
alter table public.answers drop constraint if exists answers_answer_source_valid;
drop index if exists public.answers_one_system_per_work;
alter table public.answers drop column if exists answer_source;

-- ── 自己検算: 当てる前と同じになったか ─────────────────────────
do $$
begin
  if md5(pg_get_functiondef('public.answer_items_after_insert_hint_stats()'::regprocedure)) <> 'fe7c8c3cf9f436fa5a190b806c7aa642' then
    raise exception '戻したはずの定義が違います: answer_items_after_insert_hint_stats()'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.answer_items_after_insert_hint_stats()'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: answer_items_after_insert_hint_stats()'; end if;
  if md5(pg_get_functiondef('public.answer_items_after_insert_stats()'::regprocedure)) <> 'fa63284e60895e30e4d735ec2ed1210a' then
    raise exception '戻したはずの定義が違います: answer_items_after_insert_stats()'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.answer_items_after_insert_stats()'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: answer_items_after_insert_stats()'; end if;
  if md5(pg_get_functiondef('public.answers_after_insert_hint_stats()'::regprocedure)) <> '69f8d4eb575b2d35a1f56561062d67b6' then
    raise exception '戻したはずの定義が違います: answers_after_insert_hint_stats()'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.answers_after_insert_hint_stats()'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: answers_after_insert_hint_stats()'; end if;
  if md5(pg_get_functiondef('public.answers_after_insert_stats()'::regprocedure)) <> 'e3bdbc37812c5a683ee20f876a23d553' then
    raise exception '戻したはずの定義が違います: answers_after_insert_stats()'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.answers_after_insert_stats()'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: answers_after_insert_stats()'; end if;
  if md5(pg_get_functiondef('public.get_my_answer(uuid)'::regprocedure)) <> 'c29b7befa97672161a69071570cb4121' then
    raise exception '戻したはずの定義が違います: get_my_answer(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_my_answer(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_my_answer(uuid)'; end if;
  if md5(pg_get_functiondef('public.get_my_answers(integer,integer)'::regprocedure)) <> '12165fc04cb3da0b624a9859020df543' then
    raise exception '戻したはずの定義が違います: get_my_answers(integer,integer)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_my_answers(integer,integer)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_my_answers(integer,integer)'; end if;
  if md5(pg_get_functiondef('public.get_my_work_result(uuid)'::regprocedure)) <> '6fca19c26456314865358c953ba03fdf' then
    raise exception '戻したはずの定義が違います: get_my_work_result(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_my_work_result(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_my_work_result(uuid)'; end if;
  if md5(pg_get_functiondef('public.get_public_answers(uuid,integer,integer)'::regprocedure)) <> '0da1a7b9e51f98a77cb3f32f1651784f' then
    raise exception '戻したはずの定義が違います: get_public_answers(uuid,integer,integer)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_public_answers(uuid,integer,integer)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_public_answers(uuid,integer,integer)'; end if;
  if md5(pg_get_functiondef('public.next_work_candidates(uuid)'::regprocedure)) <> '4f47c2b6bd6e90b242be3803940aefff' then
    raise exception '戻したはずの定義が違います: next_work_candidates(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.next_work_candidates(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,anon=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: next_work_candidates(uuid)'; end if;
  if to_regprocedure('public.answers_guard_source_immutable()') is not null then raise exception '消えていません: answers_guard_source_immutable()'; end if;
  if exists (select 1 from pg_trigger where tgname = 'answers_guard_source_immutable' and not tgisinternal and tgrelid = to_regclass('public.answers')) then raise exception '消えていません: 引き金 answers_guard_source_immutable'; end if;
  if to_regclass('public.answers_one_system_per_work') is not null then raise exception '消えていません: 索引 answers_one_system_per_work'; end if;
  if exists (select 1 from pg_constraint where conname = 'answers_answer_source_valid' and conrelid = to_regclass('public.answers')) then raise exception '消えていません: 制約 answers_answer_source_valid'; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'answers' and column_name = 'answer_source') then raise exception '消えていません: 列 answers.answer_source'; end if;
end $$;

commit;
