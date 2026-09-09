-- ============================================================================
-- 20260909200000_shape_assist.sql ／ 形状アシスト（D191）
-- ============================================================================
--
-- 【これは何か】
--   お題を引く前に、作者が「どういう形として描くか」の取っかかりを
--   1つだけ持てるようにする。人型／動物型／…のような発想の向き。
--
--   **正式なお題ではない。**クイズにも正解にも伝達率にも配給にも使わない。
--   守らなくても投稿できる。使わなくてもよい。
--
-- 【なぜこの形にしたか（2026-09-09 に本番を数えて決めた）】
--   1. 置き場は draft_sessions の列を1つだけ。
--      ・prompts / works に自由記述の入れ物（jsonb）は無い。実測で
--        public スキーマの jsonb 列は profiles.links の1つだけだった。
--        つまり「既存の入れ物へ足す」道は無い。
--      ・掃除（cleanup_stale_drafts）が消すのは in_progress と abandoned の
--        30日超だけで、**completed のセッション行は消さない**（定義を実測）。
--        本番でも prompts 1044件に対し、参照先の draft_sessions が
--        消えている行は0件。だから確定したお題からも後で読める。
--      ・語の一覧と重みは画面側（src/features/shape-assist/）に置く。
--        正式語彙（tags / draw_categories）へは1行も足さない。
--
--   2. クイズへ混ざらないことは、置き場所そのもので決まる。
--      build_quiz_for_prompt が読むのは prompt_cards と card_slots だけ
--      （定義を実測）。draft_sessions の列はそこへ届かない。
--      画面で隠しているのではない。**届く道が無い。**
--
--   3. 回答者へ出ないことも同じ。値を返すのは get_my_prompt だけで、
--      あれは created_by = auth.uid() で作者に限っている。
--      get_work_detail / get_public_works には1鍵も足さない。
--
--   4. 引き直し（reroll_draft）は同じセッション行を作り直すので、
--      形状アシストはそのまま残る（定義を実測）。
--
--   5. 持ち込み（art_first）の prompts は draft_session_id が null なので、
--      join した結果は必ず null になる。**触っていないので変わらない。**
--
-- 【この migration がすること】
--   ・draft_sessions に列を1つ足す
--   ・start_draft に引数を1つ足す（引数が増えるので drop してから作り直す）
--   ・draft_state_json と get_my_prompt に鍵を1つ足す
--   本体はどれも本番の定義をそのまま取り出して、上の1か所だけを差し込んである。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 置き場（列を1つ）
-- ----------------------------------------------------------------------------
--
-- null は「使わない」。既存の行はすべて null になるので、
-- これまでのお題は「形状アシスト無し」として今までどおり動く。
--
-- 中身の一覧は画面側が持つので、ここでは形だけを見る。
-- 何が入ってもクイズ・正解・伝達率・配給には届かない。

alter table public.draft_sessions
  add column if not exists shape_assist_key text;

alter table public.draft_sessions
  drop constraint if exists draft_sessions_shape_assist_key_format;

alter table public.draft_sessions
  add constraint draft_sessions_shape_assist_key_format
  check (shape_assist_key is null or shape_assist_key ~ '^[a-z][a-z_]{0,30}$');

comment on column public.draft_sessions.shape_assist_key is
  '形状アシスト（D191）。正式なお題ではない。作者向けの発想補助で、'
  'クイズ・正解・伝達率・次の作品の配り方には使わない。null は「使わない」。';


-- ----------------------------------------------------------------------------
-- 2. start_draft ／ 引数を1つ増やす
-- ----------------------------------------------------------------------------
--
-- create or replace では引数を増やせない。増やすと**別の関数がもう1本できる**ので、
-- 名前で呼ぶときにどちらか決まらなくなる。だから古いほうを消してから作り直す。
-- 1つのトランザクションの中なので、外から「関数が無い」瞬間は見えない。

drop function if exists public.start_draft(text, integer, bigint[]);

CREATE OR REPLACE FUNCTION public.start_draft(p_mode_key text, p_time_limit_seconds integer DEFAULT NULL::integer, p_carried_element_ids bigint[] DEFAULT NULL::bigint[], p_shape_assist_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid          uuid := (select auth.uid());
  v_session_id   uuid;
  v_mode         record;
  v_carried      int := 0;
  v_found        int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select dm.mode_key, dm.candidate_count, dm.max_rerolls, dm.uses_two_stage
    into v_mode
    from public.draft_modes dm
   where dm.mode_key = p_mode_key
     and dm.is_active;

  if not found then
    raise exception 'MODE_NOT_FOUND: モード % は使えません。', p_mode_key;
  end if;

  if p_time_limit_seconds is not null
     and (p_time_limit_seconds < 60 or p_time_limit_seconds > 600000) then
    raise exception 'BAD_TIME_LIMIT: 制限時間は60〜600000秒の範囲で指定してください。';
  end if;

  -- 形状アシスト（D191）。**お題ではない。**作者向けの発想補助なので、
  -- ここで見るのは形だけ。中身の一覧は画面側が持つ。
  -- 何が入っていてもクイズ・正解・伝達率・配給には触れない
  -- （それらは prompt_cards だけを読む）。
  if p_shape_assist_key is not null
     and p_shape_assist_key !~ '^[a-z][a-z_]{0,30}$' then
    raise exception 'BAD_SHAPE_ASSIST: 形状アシストの指定が読み取れません。';
  end if;

  if p_carried_element_ids is not null
     and array_length(p_carried_element_ids, 1) > 0 then

    if not v_mode.uses_two_stage then
      raise exception 'MODE_NO_CARRY: このモードでは要素を持ち出せません。';
    end if;

    v_carried := array_length(p_carried_element_ids, 1);
    if v_carried > 3 then
      raise exception
        'BAD_ELEMENT_COUNT: 1つのお題へ持ち込めるのは1〜3個です（いま %個）。', v_carried;
    end if;

    -- 本人の保存枠の中の要素で、セッション枠なら期限内であること
    select count(*) into v_found
      from public.saved_elements se
      join public.saved_carry_slots s on s.id = se.carry_slot_id
     where s.user_id = v_uid
       and se.id = any(p_carried_element_ids)
       and (s.scope <> 'session' or s.expires_at > clock_timestamp());

    if v_found <> v_carried then
      raise exception
        'ELEMENT_NOT_FOUND: 選んだ要素が見つかりません。'
        'セッション内の持ち出しは、時間が経つと使えなくなります。';
    end if;
  end if;

  if exists (
    select 1 from public.draft_sessions ds
     where ds.user_id = v_uid and ds.status = 'in_progress'
  ) then
    raise exception
      'DRAFT_IN_PROGRESS: 進行中のドラフトがあります。'
      '続けるか、破棄してから新しく始めてください。';
  end if;

  insert into public.draft_sessions
    (user_id, mode_key, candidate_count, max_rerolls, time_limit_seconds,
     shape_assist_key)
  values
    (v_uid, v_mode.mode_key, v_mode.candidate_count, v_mode.max_rerolls,
     p_time_limit_seconds, p_shape_assist_key)
  returning id into v_session_id;

  if v_carried > 0 then
    insert into public.draft_session_carried
      (session_id, position, tag_id, source_work_id, source_prompt_id,
       carry_slot_id, saved_element_id, source_is_own)
    select v_session_id,
           row_number() over (order by s.created_at, se.position, se.id),
           se.tag_id, s.source_work_id, s.source_prompt_id,
           s.id, se.id, s.source_is_own
      from public.saved_elements se
      join public.saved_carry_slots s on s.id = se.carry_slot_id
     where s.user_id = v_uid
       and se.id = any(p_carried_element_ids);
  end if;

  perform public.draft_generate_candidates(
    v_session_id, 1, v_mode.mode_key, v_mode.candidate_count);

  return public.draft_state_json(v_session_id);
end;
$function$;

-- 権限は作り直しで既定へ戻るので、元と同じ形へ入れ直す。
-- **anon を書き落とさない。**Supabase は postgres が作った関数の実行権を
-- anon へ直接配るので、from public だけでは外れない（2026-09-09 に実測）。
revoke all on function public.start_draft(text, integer, bigint[], text)
  from public, anon, authenticated;
grant execute on function public.start_draft(text, integer, bigint[], text)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 3. draft_state_json ／ 盤面へ鍵を1つ返す
-- ----------------------------------------------------------------------------
--
-- この関数は内部用（実行権は postgres と service_role だけ）。
-- create or replace なので権限はそのまま残る。

CREATE OR REPLACE FUNCTION public.draft_state_json(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'session_id',          ds.id,
    'mode_key',            ds.mode_key,
    'mode_label',          dm.label,
    'status',              ds.status,
    'candidate_count',     ds.candidate_count,
    'max_rerolls',         ds.max_rerolls,
    'reroll_count',        ds.reroll_count,
    'rerolls_left',        ds.max_rerolls - ds.reroll_count,
    'time_limit_seconds',  ds.time_limit_seconds,
    -- 【互換期間だけ返す旧い鍵】
    --   旧い画面は、二重送信で衝突したときに「いま進行中のものが、
    --   いま始めようとした条件と同じか」をこの値で見比べている
    --   （実測: HEAD の src/app/play/actions.ts が
    --    current.quiz_question_count === mode.quiz_question_count を見ている）。
    --   鍵を消すと、その比較が必ず不一致になり、合流できるはずの場面で
    --   案内文が出る。**壊れはしないが、旧い画面の振る舞いが変わる。**
    --   だから互換期間のあいだは返す。
    --
    --   値の出どころは draft_modes（モードの設定値）。
    --   旧い画面が比べる相手も draft_modes なので、比較は今までどおり成立する。
    --   **この値は出題数の決定にも採点にも使わない。**
    --   出題数はお題として確定した語の数で決まる（D165）。
    --   新しい画面の本番稼働後、旧列の削除と同じ migration でこの鍵も消す。
    'quiz_question_count', dm.quiz_question_count,
    'draft_base',          ds.draft_base,
    -- 形状アシスト（D191）。**お題ではない。**盤面に小さく出すためだけの値
    'shape_assist_key',    ds.shape_assist_key,
    'generation',          ds.current_generation,
    'current_slot_order',  ds.current_slot_order,
    'slot_count',          (
      case when dm.uses_two_stage
        then (select count(*) from public.draft_session_slots s
               where s.session_id = ds.id and s.generation = ds.current_generation)
        else (select count(*) from public.draft_mode_slots dms
               where dms.mode_key = ds.mode_key)
      end
    ),
    'carried_count',       (
      select count(*) from public.draft_session_carried c
       where c.session_id = ds.id
    ),
    'chosen_count',        (select count(*) from public.draft_candidates dc
                             where dc.session_id = ds.id
                               and dc.generation = ds.current_generation
                               and dc.is_chosen),
    'is_ready_to_complete',
      (select count(*) from public.draft_candidates dc
        where dc.session_id = ds.id
          and dc.generation = ds.current_generation
          and dc.is_chosen)
      = (
        case when dm.uses_two_stage
          then (select count(*) from public.draft_session_slots s
                 where s.session_id = ds.id and s.generation = ds.current_generation)
          else (select count(*) from public.draft_mode_slots dms
                 where dms.mode_key = ds.mode_key)
        end
      ),
    'slots', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   x.card_slot_key,
                 'card_slot_label', x.card_slot_label,
                 'category_label',  x.category_label,
                 'is_carried',      x.is_carried,
                 'candidate_count', x.candidate_count,
                 'pool_revealed',   x.pool_revealed,
                 'held_limit',      least(2, x.candidate_count - 1),
                 'slot_order',      x.slot_order,
                 'is_current',      x.slot_order = ds.current_slot_order,
                 'candidates',      x.candidates
               )
               order by x.slot_order
             )
        from (
          select dc.card_slot_key,
                 cs.label as card_slot_label,
                 tp.label as category_label,
                 coalesce(
                   (select s.source = 'carried' from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   false) as is_carried,
                 coalesce(
                   (select s.candidate_count from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   count(*)::int) as candidate_count,
                 coalesce(
                   (select s.pool_revealed_at is not null
                      from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   false) as pool_revealed,
                 dc.slot_order,
                 jsonb_agg(
                   jsonb_build_object(
                     'candidate_index', dc.candidate_index,
                     'revealed',        dc.revealed_at is not null,
                     'is_chosen',       dc.is_chosen,
                     'is_held',         dc.is_held,
                     -- めくっていないカードは中身を返さない
                     'tag_id', case when dc.revealed_at is null then null
                                    else to_jsonb(dc.tag_id) end,
                     'label',  case when dc.revealed_at is null then null
                                    else to_jsonb(tg.label) end
                   )
                   order by dc.candidate_index
                 ) as candidates
            from public.draft_candidates dc
            join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
            join public.tag_pools  tp on tp.pool_key      = cs.pool_key
            join public.tags       tg on tg.id            = dc.tag_id
           where dc.session_id = ds.id
             and dc.generation = ds.current_generation
           group by dc.session_id, dc.generation, dc.card_slot_key,
                    cs.label, tp.label, dc.slot_order
        ) x
    ), '[]'::jsonb)
  )
  from public.draft_sessions ds
  join public.draft_modes dm on dm.mode_key = ds.mode_key
  where ds.id = p_session_id;
$function$;


-- ----------------------------------------------------------------------------
-- 4. get_my_prompt ／ 作者にだけ鍵を1つ返す
-- ----------------------------------------------------------------------------
--
-- created_by = auth.uid() の行しか返さないので、回答者には出ない。
-- create or replace なので権限はそのまま残る。

CREATE OR REPLACE FUNCTION public.get_my_prompt(p_prompt_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id',                     p.id,
    'mode_key',               p.mode_key,
    'mode_label',             dm.label,
    'origin',                 p.origin,
    'time_limit_seconds',     p.time_limit_seconds,
    'was_rerolled',           p.was_rerolled,
    'reroll_count',           p.reroll_count,
    'status',                 p.status,
    'candidates_revealed_at', p.candidates_revealed_at,
    'reveal_reason',          p.reveal_reason,
    'created_at',             p.created_at,
    -- 形状アシスト（D191）。**お題ではない。**この関数は
    -- created_by = auth.uid() で作者に限っているので、回答者へは出ない。
    -- 持ち込み（draft_session_id が null）では必ず null になる
    'shape_assist_key', (select ds.shape_assist_key
                           from public.draft_sessions ds
                          where ds.id = p.draft_session_id),
    'work_id', (select w.id from public.works w where w.prompt_id = p.id),

    -- 確定カード＝お題の答え
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'pool_key',        tg.pool_key
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
       where pc.prompt_id = p.id
    ), '[]'::jsonb),

    -- 引かなかったカード。開示済みのときだけ。
    -- 持ち込み（draft_session_id が null）では、ここは必ず空になる。
    'unchosen', case
      when p.candidates_revealed_at is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'card_slot_key',   dc.card_slot_key,
                   'card_slot_label', cs.label,
                   'slot_order',      dc.slot_order,
                   'candidate_index', dc.candidate_index,
                   'tag_id',          dc.tag_id,
                   'tag_label',       tg.label
                 )
                 order by dc.slot_order, dc.candidate_index
               )
          from public.draft_candidates dc
          join public.draft_sessions ds on ds.id = dc.session_id
          join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
          join public.tags       tg on tg.id            = dc.tag_id
         where ds.id = p.draft_session_id
           and dc.generation = ds.current_generation
           and dc.is_chosen = false
      ), '[]'::jsonb)
    end
  )
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  where p.id = p_prompt_id
    and p.created_by = (select auth.uid());
$function$;


-- ----------------------------------------------------------------------------
-- 5. 投入の検証
-- ----------------------------------------------------------------------------

do $$
declare
  v int;
begin
  select count(*) into v
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'draft_sessions'
     and column_name  = 'shape_assist_key';
  if v <> 1 then raise exception 'SHAPE_ASSIST_COLUMN_MISSING'; end if;

  -- start_draft は1本だけ（drop し忘れて2本になっていないこと）
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'start_draft';
  if v <> 1 then raise exception 'START_DRAFT_NOT_UNIQUE: % 本', v; end if;

  -- anon から呼べないこと
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'start_draft'
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v <> 0 then raise exception 'START_DRAFT_ANON_CAN_EXECUTE'; end if;

  -- authenticated から呼べること
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'start_draft'
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v <> 1 then raise exception 'START_DRAFT_AUTH_CANNOT_EXECUTE'; end if;

  -- クイズを作る関数が形状アシストを見ていないこと。
  -- **思い出す形にしない。**定義文を毎回数える
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('build_quiz_for_prompt', 'next_work_candidates',
                       'get_work_detail', 'get_public_works', 'get_work_quiz')
     and pg_get_functiondef(p.oid) like '%shape_assist%';
  if v <> 0 then raise exception 'SHAPE_ASSIST_LEAKED_INTO_QUIZ_OR_FEED: % 本', v; end if;

  raise notice '形状アシストを足しました（列1つ・関数3本）。';
end $$;
