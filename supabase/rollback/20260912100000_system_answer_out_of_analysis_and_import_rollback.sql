-- ============================================================================
-- 20260912100000_system_answer_out_of_analysis_and_import.sql を取り消す（20260912100000 を当てる前の状態へ戻す）
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
--
-- 【流したあと】履歴から外す: npx supabase migration repair 20260912100000 --status reverted --linked
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

-- ── 変わった関数 8 本を、当てる前の定義へ書き戻す ─────────────

-- analysis_advanced_answers(uuid)
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
     and not exists (
       select 1 from public.analysis_exclusions x where x.answer_id = a.id
     );
$function$;

-- analysis_all_answers(uuid)
CREATE OR REPLACE FUNCTION public.analysis_all_answers(p_work_id uuid)
 RETURNS TABLE(answer_id bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select a.id from public.answers a where a.work_id = p_work_id;
$function$;

-- answers_after_insert_auto_import()
CREATE OR REPLACE FUNCTION public.answers_after_insert_auto_import()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_on boolean;
begin
  select s.auto_import into v_on
    from public.work_import_state s
   where s.work_id = new.work_id;

  if coalesce(v_on, false) then
    perform public.consume_import_capacity(new.work_id, 'auto', 1);
  end if;

  return null;
end;
$function$;

-- consume_import_capacity(uuid,text,integer)
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

-- get_my_answer_analysis(uuid)
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
   where a.work_id = p_work_id;

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
       group by a.id
    )
    select jsonb_build_object(
      'answers_count',  (select count(*) from public.answers a where a.work_id = p_work_id),
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

-- get_work_answer_list(uuid)
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

-- get_work_import_state(uuid)
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
      select count(*) from public.answers a where a.work_id = p_work_id
    ),
    'unimported', (
      select count(*) from public.answers a
       where a.work_id = p_work_id
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
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),
    'latest_unimported_at', (
      select max(a.created_at) from public.answers a
       where a.work_id = p_work_id
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

-- set_answer_excluded(uuid,integer[],boolean)
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

-- ── 自己検算: 当てる前と同じになったか ─────────────────────────
do $$
begin
  if md5(pg_get_functiondef('public.analysis_advanced_answers(uuid)'::regprocedure)) <> '270860ad071b69b27c8e51d2ceafd98f' then
    raise exception '戻したはずの定義が違います: analysis_advanced_answers(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.analysis_advanced_answers(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: analysis_advanced_answers(uuid)'; end if;
  if md5(pg_get_functiondef('public.analysis_all_answers(uuid)'::regprocedure)) <> 'c19346d36d0081057bc85e3e4196fdd5' then
    raise exception '戻したはずの定義が違います: analysis_all_answers(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.analysis_all_answers(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: analysis_all_answers(uuid)'; end if;
  if md5(pg_get_functiondef('public.answers_after_insert_auto_import()'::regprocedure)) <> '337d594f0ac6d6da8afc3155a485c1e5' then
    raise exception '戻したはずの定義が違います: answers_after_insert_auto_import()'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.answers_after_insert_auto_import()'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: answers_after_insert_auto_import()'; end if;
  if md5(pg_get_functiondef('public.consume_import_capacity(uuid,text,integer)'::regprocedure)) <> '5ef317c37248c1a546b782e9430505f4' then
    raise exception '戻したはずの定義が違います: consume_import_capacity(uuid,text,integer)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.consume_import_capacity(uuid,text,integer)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres}' then
    raise exception '戻したはずの権限が違います: consume_import_capacity(uuid,text,integer)'; end if;
  if md5(pg_get_functiondef('public.get_my_answer_analysis(uuid)'::regprocedure)) <> '73174553964c1e5317ae4bbb5df94365' then
    raise exception '戻したはずの定義が違います: get_my_answer_analysis(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_my_answer_analysis(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_my_answer_analysis(uuid)'; end if;
  if md5(pg_get_functiondef('public.get_work_answer_list(uuid)'::regprocedure)) <> '41b9527e38abeba2ddc6e029e2993053' then
    raise exception '戻したはずの定義が違います: get_work_answer_list(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_work_answer_list(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_work_answer_list(uuid)'; end if;
  if md5(pg_get_functiondef('public.get_work_import_state(uuid)'::regprocedure)) <> '20dfa42eca5762f891a3191b886530ad' then
    raise exception '戻したはずの定義が違います: get_work_import_state(uuid)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.get_work_import_state(uuid)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: get_work_import_state(uuid)'; end if;
  if md5(pg_get_functiondef('public.set_answer_excluded(uuid,integer[],boolean)'::regprocedure)) <> '1949162c10da0142866bf6468cff6823' then
    raise exception '戻したはずの定義が違います: set_answer_excluded(uuid,integer[],boolean)'; end if;
  if coalesce((select proacl::text from pg_proc where oid = 'public.set_answer_excluded(uuid,integer[],boolean)'::regprocedure), '') <> '{postgres=X/postgres,service_role=X/postgres,authenticated=X/postgres}' then
    raise exception '戻したはずの権限が違います: set_answer_excluded(uuid,integer[],boolean)'; end if;
end $$;

commit;
