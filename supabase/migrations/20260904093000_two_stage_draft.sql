-- ============================================================================
-- two_stage_draft ／ カテゴリを先に引いてから語彙を引く（D158 / D159 / D161）
-- ============================================================================
--
-- 【いままでの作り】
--   モードごとに枠が固定されていた（draft_mode_slots）。
--   「モチーフA・主カラー・ジャンル類型」という並びが先にあり、
--   その枠へ語彙を流し込んでいた。
--
-- 【これからの作り】
--   1回のドラフトのたびに、
--     ① 何語のお題にするか、そのうちモーフを何個にするかを引く
--     ② どの状態カテゴリを使うかを引く
--     ③ 決まったカテゴリごとに語彙を引く
--   という順で組み立てる。①②の結果は draft_session_slots に書く。
--
-- 【この順番で得られること】
--   同じ状態カテゴリが2回出る、モーフが3個出る、といった構成が作れる。
--   枠が固定だと、その構成は表を作り直さない限り出せない。
--
-- 【持ち出しとの関係（D161）】
--   持ち出した要素は①より前に確定していて、**①②の制限を受けない。**
--   モーフ3個を持ち出したら、通常モードの「主に1〜2個」に縛られず3個使える。
--   自動抽選の制限が効くのは、持ち出したあとの不足分だけ。
--
-- 【値が入る先】
--   ・構成そのもの        … draft_session_slots（このファイルで作る）
--   ・持ち出しの控え      … draft_session_carried（このファイルで作る）
--   ・確率               … draw_config（20260904090000 で作った。暫定初期値）
--   ・派生関係           … prompt_element_origins（20260904092000 で作った）
--
-- 【旧方式を消さない】
--   easy / standard の2モードと draft_mode_slots はそのまま残す。
--   過去1,050件のお題がこのモードを指しているため。
--   分岐は draft_modes.uses_two_stage の1か所だけで行う。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 1回のドラフトで使う枠（＝抽選されたカテゴリの並び）
-- ----------------------------------------------------------------------------

create table if not exists public.draft_session_slots (
  session_id uuid not null
    references public.draft_sessions (id) on delete cascade on update restrict,

  -- 引き直すと世代が1つ進む。構成そのものを引き直すので世代ごとに持つ
  generation int not null
    constraint draft_session_slots_generation_positive check (generation >= 1),

  slot_order int not null
    constraint draft_session_slots_order_positive check (slot_order >= 1),

  category_key text not null
    references public.draw_categories (category_key) on delete restrict on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 'lottery' = 抽選で引く枠 ／ 'carried' = 持ち出しで埋まっている枠
  source text not null default 'lottery'
    constraint draft_session_slots_source_valid check (source in ('lottery', 'carried')),

  -- 持ち出しの枠だけ、最初から中身が決まっている
  fixed_tag_id bigint
    references public.tags (id) on delete restrict on update restrict,

  created_at timestamptz not null default now(),

  constraint draft_session_slots_pkey primary key (session_id, generation, slot_order),
  constraint draft_session_slots_slot_unique unique (session_id, generation, card_slot_key),
  constraint draft_session_slots_fixed_pair check (
    (source = 'carried' and fixed_tag_id is not null)
    or
    (source = 'lottery' and fixed_tag_id is null)
  )
);

comment on table public.draft_session_slots is
  '1回のドラフトで使うカテゴリの並び（D159 の①②の結果）。'
  'fixed_tag_id を持つため公開しない。RPC 経由でのみ読む。';

alter table public.draft_session_slots enable row level security;
revoke all on table public.draft_session_slots from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. そのドラフトへ持ち出した要素
-- ----------------------------------------------------------------------------
--
-- saved_elements（利用者の手持ち）から、このドラフトで使うぶんだけを写す。
-- 写すのは、引き直しても持ち出しが消えないようにするため。
-- 手持ちのほうは消さない（次のお題でも使える）。

create table if not exists public.draft_session_carried (
  session_id uuid not null
    references public.draft_sessions (id) on delete cascade on update restrict,

  position int not null
    constraint draft_session_carried_position_range check (position between 1 and 3),

  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  source_work_id uuid
    references public.works (id) on delete set null on update restrict,

  source_prompt_id uuid
    references public.prompts (id) on delete set null on update restrict,

  constraint draft_session_carried_pkey primary key (session_id, position),
  constraint draft_session_carried_tag_unique unique (session_id, tag_id)
);

comment on table public.draft_session_carried is
  'そのドラフトへ持ち出した要素（D161）。1〜3件。引き直しても消えない。';

alter table public.draft_session_carried enable row level security;
revoke all on table public.draft_session_carried from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 構成を引く
-- ----------------------------------------------------------------------------
--
-- 【この関数が決めること】
--   ・総語数（通常3〜4／高難度5〜6）
--   ・モーフの個数（通常は主に1〜2、3個は低確率／高難度は最大2）
--   ・状態カテゴリの並び（同じカテゴリの重複は低確率で許す）
--   ・それぞれが使う枠の名前（morph_1 / emotion_2 のような形）
--
-- 【モーフ最低1個（D158）をどこで保証しているか】
--   「持ち出したモーフ ＋ 新しく引くモーフ」が0のとき、
--   新しく引くモーフを1個に引き上げる。ここが唯一の保証箇所。
--
-- 【持ち出しが制限を上書きする場所（D161）】
--   総語数が「持ち出しの数 ＋ 必要なモーフの数」を下回るときは、
--   総語数のほうを広げる。持ち出しを削らない。

create or replace function public.draft_plan_slots(
  p_session_id uuid,
  p_generation int,
  p_mode_key   text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_mode           record;
  v_word_ratio     numeric;
  v_morph_1        numeric;
  v_morph_2        numeric;
  v_repeat_ratio   numeric;
  v_total          int;
  v_morph_target   int;
  v_new_morph      int;
  v_new_non_morph     int;
  v_carried_total  int;
  v_carried_morph  int;
  v_cat_keys       text[];
  v_cat_used       int[];
  v_pick           text;
  v_idx            int;
  v_slot_order     int := 0;
  v_r              numeric;
  v_i              int;
  v_carried        record;
  v_free           text[];
  v_reuse          text[];
begin
  select dm.mode_key, dm.word_count_min, dm.word_count_max, dm.morph_max
    into v_mode
    from public.draft_modes dm
   where dm.mode_key = p_mode_key;

  if not found or v_mode.word_count_min is null then
    raise exception 'MODE_NOT_TWO_STAGE: モード % は二段階抽選ではありません。', p_mode_key;
  end if;

  -- 同じ世代を作り直せるように、先に消す
  delete from public.draft_session_slots s
   where s.session_id = p_session_id and s.generation = p_generation;

  -- --- 設定値（すべて暫定初期値。draw_config の is_provisional を参照）------
  select coalesce(
           (select cfg.config_value from public.draw_config cfg
             where cfg.config_key = p_mode_key || '_word_count_'
                                    || v_mode.word_count_min::text || '_ratio'),
           0.5)
    into v_word_ratio;

  select coalesce(
           (select cfg.config_value from public.draw_config cfg
             where cfg.config_key = p_mode_key || '_morph_1_ratio'), 0.5)
    into v_morph_1;

  select coalesce(
           (select cfg.config_value from public.draw_config cfg
             where cfg.config_key = p_mode_key || '_morph_2_ratio'), 1.0)
    into v_morph_2;

  select coalesce(
           (select cfg.config_value from public.draw_config cfg
             where cfg.config_key = 'state_category_repeat_ratio'), 0.1)
    into v_repeat_ratio;

  -- --- 持ち出しの内訳 -------------------------------------------------------
  select count(*),
         count(*) filter (where dc.kind = 'morph')
    into v_carried_total, v_carried_morph
    from public.draft_session_carried c
    join public.tags t on t.id = c.tag_id
    join public.draw_categories dc on dc.pool_key = t.pool_key
   where c.session_id = p_session_id;

  -- --- ① 総語数 ------------------------------------------------------------
  if random() < v_word_ratio then
    v_total := v_mode.word_count_min;
  else
    v_total := v_mode.word_count_max;
  end if;

  -- --- ① モーフの個数 ------------------------------------------------------
  v_r := random();
  if v_r < v_morph_1 then
    v_morph_target := 1;
  elsif v_r < v_morph_1 + v_morph_2 then
    v_morph_target := 2;
  else
    v_morph_target := 3;
  end if;

  if v_morph_target > v_mode.morph_max then
    v_morph_target := v_mode.morph_max;
  end if;

  v_new_morph := greatest(0, v_morph_target - v_carried_morph);

  -- モーフ最低1個（D158）。持ち出しにも新規にもモーフが無い場合だけ効く
  if v_carried_morph + v_new_morph = 0 then
    v_new_morph := 1;
  end if;

  -- 持ち出しは自動抽選の制限より優先（D161）。総語数のほうを広げる
  if v_total < v_carried_total + v_new_morph then
    v_total := v_carried_total + v_new_morph;
  end if;

  v_new_non_morph := v_total - v_carried_total - v_new_morph;
  if v_new_non_morph < 0 then
    v_new_non_morph := 0;
  end if;

  -- --- カテゴリごとの使用回数を数える器 ------------------------------------
  select array_agg(dcat.category_key order by dcat.sort_order)
    into v_cat_keys
    from public.draw_categories dcat
   where dcat.is_active;

  v_cat_used := array_fill(0, array[coalesce(array_length(v_cat_keys, 1), 0)]);

  -- --- 持ち出しぶんの枠を先に置く（slot_order 1..n）------------------------
  for v_carried in
    select c.position, c.tag_id, dcat.category_key
      from public.draft_session_carried c
      join public.tags t on t.id = c.tag_id
      join public.draw_categories dcat on dcat.pool_key = t.pool_key
     where c.session_id = p_session_id
     order by c.position
  loop
    v_idx := array_position(v_cat_keys, v_carried.category_key);
    v_cat_used[v_idx] := v_cat_used[v_idx] + 1;
    v_slot_order := v_slot_order + 1;

    insert into public.draft_session_slots
      (session_id, generation, slot_order, category_key, card_slot_key,
       source, fixed_tag_id)
    values
      (p_session_id, p_generation, v_slot_order, v_carried.category_key,
       v_carried.category_key || '_' || v_cat_used[v_idx]::text,
       'carried', v_carried.tag_id);
  end loop;

  -- --- 新しく引くモーフの枠 -------------------------------------------------
  v_idx := array_position(v_cat_keys, 'morph');
  for v_i in 1 .. v_new_morph loop
    v_cat_used[v_idx] := v_cat_used[v_idx] + 1;
    v_slot_order := v_slot_order + 1;

    insert into public.draft_session_slots
      (session_id, generation, slot_order, category_key, card_slot_key, source)
    values
      (p_session_id, p_generation, v_slot_order, 'morph',
       'morph_' || v_cat_used[v_idx]::text, 'lottery');
  end loop;

  -- --- ② モーフ以外のカテゴリを引く（状態8カテゴリ ＋ カラー）---------------
  --
  -- 既定は「まだ使っていないカテゴリから引く」。
  -- state_category_repeat_ratio の確率でだけ、すでに使ったカテゴリを選び直す。
  -- D158「同じ状態カテゴリの重複は完全禁止にしないが、通常抽選では低確率」。
  --
  -- 【カラーは状態ではない】
  --   引く対象（v_free）は kind <> 'morph'。カラーもここに入る。
  --   **重複の対象（v_reuse）は kind = 'state' だけ。**
  --   カラーを重複させる道はここに無い。state_category_repeat_ratio は
  --   名前のとおり状態カテゴリの値で、カラーには当たらない。
  --   （max_per_prompt = 1 でも同じ結果になるが、確率の適用範囲を
  --    値だけに頼らず、引く側の条件としても書いておく。）
  for v_i in 1 .. v_new_non_morph loop
    -- まだ1度も使っていない、モーフ以外のカテゴリ（状態8つ ＋ カラー）
    select array_agg(dcat.category_key)
      into v_free
      from public.draw_categories dcat
     where dcat.is_active and dcat.kind <> 'morph'
       and v_cat_used[array_position(v_cat_keys, dcat.category_key)] = 0;

    -- すでに使っていて、上限に達していない**状態**カテゴリ。
    -- カラーはここに入れない（重複させない）
    select array_agg(dcat.category_key)
      into v_reuse
      from public.draw_categories dcat
     where dcat.is_active and dcat.kind = 'state'
       and v_cat_used[array_position(v_cat_keys, dcat.category_key)] between 1
           and dcat.max_per_prompt - 1;

    v_pick := null;

    if v_reuse is not null and random() < v_repeat_ratio then
      v_pick := v_reuse[1 + floor(random() * array_length(v_reuse, 1))::int];
    end if;

    if v_pick is null and v_free is not null then
      v_pick := v_free[1 + floor(random() * array_length(v_free, 1))::int];
    end if;

    if v_pick is null and v_reuse is not null then
      v_pick := v_reuse[1 + floor(random() * array_length(v_reuse, 1))::int];
    end if;

    if v_pick is null then
      raise exception
        'NO_CATEGORY_LEFT: モーフ以外に使えるカテゴリが足りません（%語目）。', v_i;
    end if;

    v_idx := array_position(v_cat_keys, v_pick);
    v_cat_used[v_idx] := v_cat_used[v_idx] + 1;
    v_slot_order := v_slot_order + 1;

    insert into public.draft_session_slots
      (session_id, generation, slot_order, category_key, card_slot_key, source)
    values
      (p_session_id, p_generation, v_slot_order, v_pick,
       v_pick || '_' || v_cat_used[v_idx]::text, 'lottery');
  end loop;

  -- --- 数え直す -------------------------------------------------------------
  if v_slot_order <> v_total then
    raise exception 'COMPOSITION_MISMATCH: 枠が%個です（必要%個）。', v_slot_order, v_total;
  end if;

  if not exists (
    select 1 from public.draft_session_slots s
     where s.session_id = p_session_id and s.generation = p_generation
       and s.category_key = 'morph'
  ) then
    raise exception 'NO_MORPH: モーフが1個も入っていません（D158 違反）。';
  end if;
end;
$fn$;

comment on function public.draft_plan_slots(uuid, int, text) is
  'D159 の①②。カテゴリ構成を抽選して draft_session_slots へ書く。'
  '持ち出しは①②の制限を受けない（D161）。内部専用（grant しない）。';

revoke all on function public.draft_plan_slots(uuid, int, text)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. 候補カードを配る（二段階抽選版を含む）
-- ----------------------------------------------------------------------------
--
-- 旧方式（draft_mode_slots で枠が固定）と新方式（draft_session_slots）を
-- ここで分岐させる。分岐の条件は draft_modes.uses_two_stage の1か所だけ。

create or replace function public.draft_generate_candidates(
  p_session_id      uuid,
  p_generation      int,
  p_mode_key        text,
  p_candidate_count int
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_two_stage  boolean;
  v_slot_count int;
  v_lottery    int;
  v_inserted   int;
  v_carried    int;
begin
  select dm.uses_two_stage into v_two_stage
    from public.draft_modes dm
   where dm.mode_key = p_mode_key;

  if v_two_stage is null then
    raise exception 'MODE_NOT_FOUND: モード % は使えません。', p_mode_key;
  end if;

  -- ======================= 旧方式（枠が固定）===============================
  if not v_two_stage then
    select count(*) into v_slot_count
      from public.draft_mode_slots dms
     where dms.mode_key = p_mode_key;

    if v_slot_count = 0 then
      raise exception 'MODE_HAS_NO_SLOTS: モード % に枠が登録されていません', p_mode_key;
    end if;

    insert into public.draft_candidates
      (session_id, generation, card_slot_key, slot_order, candidate_index, tag_id)
    with slots as (
      select dms.card_slot_key,
             dms.sort_order as slot_order,
             cs.pool_key,
             row_number() over (partition by cs.pool_key order by dms.sort_order)
               as seq_in_pool
        from public.draft_mode_slots dms
        join public.card_slots cs on cs.card_slot_key = dms.card_slot_key
       where dms.mode_key = p_mode_key
    ),
    used_pools as (select distinct pool_key from slots),
    lottery as (
      select t.id as tag_id, t.pool_key, power(random(), 1.0 / t.weight) as lot
        from public.tags t
        join used_pools up on up.pool_key = t.pool_key
       where t.is_active
    ),
    ranked as (
      select l.tag_id, l.pool_key,
             row_number() over (partition by l.pool_key order by l.lot desc) as rn
        from lottery l
    ),
    wanted as (
      select s.card_slot_key, s.slot_order, s.pool_key, gs.i as candidate_index,
             (s.seq_in_pool - 1) * p_candidate_count + gs.i + 1 as pick_rn
        from slots s
        cross join generate_series(0, p_candidate_count - 1) as gs(i)
    )
    select p_session_id, p_generation, w.card_slot_key, w.slot_order,
           w.candidate_index, r.tag_id
      from wanted w
      join ranked r on r.pool_key = w.pool_key and r.rn = w.pick_rn;

    get diagnostics v_inserted = row_count;

    if v_inserted <> v_slot_count * p_candidate_count then
      raise exception
        'NOT_ENOUGH_TAGS: 候補が %件しか作れませんでした（必要 %件）。'
        'モード % に必要なタグが不足しています。',
        v_inserted, v_slot_count * p_candidate_count, p_mode_key;
    end if;

    return;
  end if;

  -- ======================= 新方式（二段階抽選）=============================

  -- ① ② 構成を引く
  perform public.draft_plan_slots(p_session_id, p_generation, p_mode_key);

  select count(*),
         count(*) filter (where s.source = 'lottery'),
         count(*) filter (where s.source = 'carried')
    into v_slot_count, v_lottery, v_carried
    from public.draft_session_slots s
   where s.session_id = p_session_id and s.generation = p_generation;

  -- 持ち出しの枠は、最初から中身が決まっている。1枚だけ置いて開いておく
  insert into public.draft_candidates
    (session_id, generation, card_slot_key, slot_order, candidate_index,
     tag_id, is_chosen, revealed_at)
  select p_session_id, p_generation, s.card_slot_key, s.slot_order, 0,
         s.fixed_tag_id, true, clock_timestamp()
    from public.draft_session_slots s
   where s.session_id = p_session_id and s.generation = p_generation
     and s.source = 'carried';

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_carried then
    raise exception 'CARRIED_CARD_MISMATCH: 持ち出しの枠が%件です（必要%件）。',
      v_inserted, v_carried;
  end if;

  -- ③ 抽選の枠へ、カテゴリごとに候補を配る。
  --   持ち出した語は候補から外す（同じ語が2回出ないようにするため）。
  if v_lottery > 0 then
    insert into public.draft_candidates
      (session_id, generation, card_slot_key, slot_order, candidate_index, tag_id)
    with slots as (
      select s.card_slot_key, s.slot_order, dcat.pool_key,
             row_number() over (partition by dcat.pool_key order by s.slot_order)
               as seq_in_pool
        from public.draft_session_slots s
        join public.draw_categories dcat on dcat.category_key = s.category_key
       where s.session_id = p_session_id and s.generation = p_generation
         and s.source = 'lottery'
    ),
    used_pools as (select distinct pool_key from slots),
    taken as (
      select s.fixed_tag_id as tag_id
        from public.draft_session_slots s
       where s.session_id = p_session_id and s.generation = p_generation
         and s.fixed_tag_id is not null
    ),
    lottery as (
      select t.id as tag_id, t.pool_key, power(random(), 1.0 / t.weight) as lot
        from public.tags t
        join used_pools up on up.pool_key = t.pool_key
       where t.is_active
         and not exists (select 1 from taken k where k.tag_id = t.id)
    ),
    ranked as (
      select l.tag_id, l.pool_key,
             row_number() over (partition by l.pool_key order by l.lot desc) as rn
        from lottery l
    ),
    wanted as (
      select s.card_slot_key, s.slot_order, s.pool_key, gs.i as candidate_index,
             (s.seq_in_pool - 1) * p_candidate_count + gs.i + 1 as pick_rn
        from slots s
        cross join generate_series(0, p_candidate_count - 1) as gs(i)
    )
    select p_session_id, p_generation, w.card_slot_key, w.slot_order,
           w.candidate_index, r.tag_id
      from wanted w
      join ranked r on r.pool_key = w.pool_key and r.rn = w.pick_rn;

    get diagnostics v_inserted = row_count;

    if v_inserted <> v_lottery * p_candidate_count then
      raise exception
        'NOT_ENOUGH_TAGS: 候補が %件しか作れませんでした（必要 %件）。'
        '使うカテゴリの語彙が不足しています。',
        v_inserted, v_lottery * p_candidate_count;
    end if;
  end if;

  -- 持ち出しの枠はもう決まっているので、最初にめくる枠はその次から
  update public.draft_sessions ds
     set current_slot_order = v_carried + 1
   where ds.id = p_session_id;
end;
$fn$;

comment on function public.draft_generate_candidates(uuid, int, text, int) is
  '候補カードを配る。draft_modes.uses_two_stage で新旧を分岐する。'
  '新方式では先に draft_plan_slots でカテゴリ構成を引く（D159）。';

revoke all on function public.draft_generate_candidates(uuid, int, text, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. ドラフトの現在状態。枠の数え方を新旧で分ける
-- ----------------------------------------------------------------------------
--
-- 変更点は2つだけ。
--   ・slot_count と is_ready_to_complete を、その世代の実際の枠から数える
--   ・各枠にカテゴリ名を添える（画面に「感情」「モーフ」と出すため）
--
-- **未公開カードを隠す処理は1文字も変えていない。**
-- （db-checks の「draft_state_json が未公開カードを隠している」が
--   この2か所の出現回数を数えている）

create or replace function public.draft_state_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'session_id',          ds.id,
    'mode_key',            ds.mode_key,
    'mode_label',          dm.label,
    'status',              ds.status,
    'candidate_count',     ds.candidate_count,
    'max_rerolls',         ds.max_rerolls,
    'reroll_count',        ds.reroll_count,
    'rerolls_left',        ds.max_rerolls - ds.reroll_count,
    'quiz_question_count', ds.quiz_question_count,
    'time_limit_seconds',  ds.time_limit_seconds,
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
                 dc.slot_order,
                 jsonb_agg(
                   jsonb_build_object(
                     'candidate_index', dc.candidate_index,
                     'revealed',        dc.revealed_at is not null,
                     'is_chosen',       dc.is_chosen,
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
$fn$;

revoke all on function public.draft_state_json(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. start_draft ／ 持ち出しを受け取れるようにする
-- ----------------------------------------------------------------------------
--
-- 引数が1本増えるので、いったん落としてから作り直す。
-- （引数を足すと別の関数になり、古い2引数版が残ってしまうため）

drop function if exists public.start_draft(text, int);

create function public.start_draft(
  p_mode_key            text,
  p_time_limit_seconds  int      default null,
  p_carried_element_ids bigint[] default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_session_id   uuid;
  v_mode         record;
  v_carried      int := 0;
  v_found        int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select dm.mode_key, dm.candidate_count, dm.max_rerolls,
         dm.quiz_question_count, dm.uses_two_stage
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

  -- --- 持ち出しの検査 -------------------------------------------------------
  if p_carried_element_ids is not null
     and array_length(p_carried_element_ids, 1) > 0 then

    -- 登録者のみ（D164）
    v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
    if v_is_anonymous then
      raise exception
        'GUEST_CANNOT_CARRY: 要素の持ち出しにはアカウント登録が必要です。'
        'ゲストのままでもお題は引けます。';
    end if;

    if not v_mode.uses_two_stage then
      raise exception
        'MODE_NO_CARRY: このモードでは要素を持ち出せません。';
    end if;

    v_carried := array_length(p_carried_element_ids, 1);
    if v_carried > 3 then
      raise exception 'BAD_ELEMENT_COUNT: 持ち出せるのは1〜3個です（いま %個）。', v_carried;
    end if;

    select count(*) into v_found
      from public.saved_elements se
     where se.user_id = v_uid
       and se.id = any(p_carried_element_ids);

    if v_found <> v_carried then
      raise exception 'ELEMENT_NOT_FOUND: 選んだ要素が見つかりません。';
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
    (user_id, mode_key, candidate_count, max_rerolls,
     quiz_question_count, time_limit_seconds)
  values
    (v_uid, v_mode.mode_key, v_mode.candidate_count, v_mode.max_rerolls,
     v_mode.quiz_question_count, p_time_limit_seconds)
  returning id into v_session_id;

  if v_carried > 0 then
    insert into public.draft_session_carried
      (session_id, position, tag_id, source_work_id, source_prompt_id)
    select v_session_id,
           row_number() over (order by se.created_at, se.id),
           se.tag_id, se.source_work_id, se.source_prompt_id
      from public.saved_elements se
     where se.user_id = v_uid
       and se.id = any(p_carried_element_ids);
  end if;

  perform public.draft_generate_candidates(
    v_session_id, 1, v_mode.mode_key, v_mode.candidate_count);

  return public.draft_state_json(v_session_id);
end;
$fn$;

comment on function public.start_draft(text, int, bigint[]) is
  'ドラフトを始める。持ち出す要素を1〜3個渡せる（D161）。持ち出しは登録者のみ（D164）。';

revoke all on function public.start_draft(text, int, bigint[])
  from public, anon, authenticated;
grant execute on function public.start_draft(text, int, bigint[]) to authenticated;


-- ----------------------------------------------------------------------------
-- 6-b. build_quiz_for_prompt ／ 出題と4択を作る
-- ----------------------------------------------------------------------------
--
-- complete_draft から切り出した。切り出した理由は1つで、
-- **確定の経路と、試験でお題を組み立てる経路に、同じ規則を通させるため。**
-- 誤答の選び方を2か所に書くと、片方だけ直したときに試験が気づかない。
--
-- ここが守ること。
--   ・出題はそのお題のカードから quiz_priority の小さい順
--   ・誤答は同じ分類から引き、そのお題で使ったタグは外す
--   ・**正解と同じ同義グループの語は誤答にしない**（D96）
--   ・1つのお題の全選択肢でタグが重複しない
--   ・数が足りないときは重複で埋めず、失敗させて巻き戻す

create or replace function public.build_quiz_for_prompt(
  p_prompt_id      uuid,
  p_question_count int
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_prompt_id uuid := p_prompt_id;
  v_inserted  int;
  v_bad       int;
  v_distinct  int;
begin
  -- --- 3. 出題する枠 --------------------------------------------------------
  --
  -- **このお題のカードのうち**、クイズに出せる枠を quiz_priority の
  -- 小さい順に quiz_question_count 個だけ選ぶ。
  -- 旧方式ではお題のカード＝モードの固定枠なので、過去と同じ結果になる。
  insert into public.quiz_questions (prompt_id, card_slot_key, position)
  select v_prompt_id, x.card_slot_key, x.rn - 1
    from (
      select pc.card_slot_key,
             row_number() over (order by cs.quiz_priority) as rn
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
       where pc.prompt_id = v_prompt_id
         and cs.is_quiz_eligible
    ) x
   where x.rn <= p_question_count;

  get diagnostics v_inserted = row_count;
  if v_inserted <> p_question_count then
    raise exception
      'QUESTION_COUNT_MISMATCH: 出題できる枠が %個しかありません（必要 %個）。',
      v_inserted, p_question_count;
  end if;

  -- --- 4. 4択 ---------------------------------------------------------------
  --
  -- 誤答はプール単位でまとめて引き、問へブロックで配る（重複防止）。
  -- 加えて、**正解と同じ同義グループの語は誤答にしない**（D96）。
  -- 「膨張」が正解のときに「肥大」を並べると、正解が2つある問になる。
  insert into public.quiz_choices (question_id, tag_id, position, is_correct)
  with q as (
    select qq.id       as question_id,
           qq.position as position,
           cs.pool_key,
           pc.tag_id   as correct_tag_id,
           row_number() over (partition by cs.pool_key order by qq.position)
             as seq_in_pool
      from public.quiz_questions qq
      join public.card_slots   cs on cs.card_slot_key = qq.card_slot_key
      join public.prompt_cards pc on pc.prompt_id     = qq.prompt_id
                                 and pc.card_slot_key = qq.card_slot_key
     where qq.prompt_id = v_prompt_id
  ),
  used as (
    select pc.tag_id from public.prompt_cards pc where pc.prompt_id = v_prompt_id
  ),
  used_groups as (
    select distinct t.synonym_group
      from public.prompt_cards pc
      join public.tags t on t.id = pc.tag_id
     where pc.prompt_id = v_prompt_id
       and t.synonym_group is not null
  ),
  pools as (select distinct pool_key from q),
  lots as (
    select t.id as tag_id, t.pool_key, random() as lot
      from public.tags t
      join pools p on p.pool_key = t.pool_key
     where t.is_active
       and t.id not in (select u.tag_id from used u)
       and (t.synonym_group is null
            or t.synonym_group not in (select ug.synonym_group from used_groups ug))
  ),
  ranked as (
    select l.tag_id, l.pool_key,
           row_number() over (partition by l.pool_key order by l.lot) as rn
      from lots l
  ),
  distractors as (
    select q.question_id, r.tag_id, false as is_correct
      from q
      join ranked r
        on r.pool_key = q.pool_key
       and r.rn between (q.seq_in_pool - 1) * 3 + 1 and q.seq_in_pool * 3
  ),
  picked as (
    select d.question_id, d.tag_id, d.is_correct from distractors d
    union all
    select q.question_id, q.correct_tag_id, true from q
  ),
  shuffle_lots as (
    select p.question_id, p.tag_id, p.is_correct, random() as lot from picked p
  )
  select sl.question_id,
         sl.tag_id,
         (row_number() over (partition by sl.question_id order by sl.lot))::int - 1,
         sl.is_correct
    from shuffle_lots sl;

  get diagnostics v_inserted = row_count;

  if v_inserted <> p_question_count * 4 then
    raise exception
      'QUIZ_CHOICES_INSUFFICIENT: 選択肢が %件しか作れませんでした（必要 %件）。'
      '同じカテゴリを使う問の数に対して語彙が不足しています'
      '（1つのカテゴリを k 問が使うなら 4k 件以上必要）。',
      v_inserted, p_question_count * 4;
  end if;

  -- --- 5. 数え直して検算する -------------------------------------------------
  select count(*) into v_bad
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt_id
     and (
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id) <> 4
       or
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id and qc.is_correct) <> 1
     );

  if v_bad > 0 then
    raise exception 'QUIZ_BROKEN: 選択肢または正解の数が正しくない問が%件あります。', v_bad;
  end if;

  select count(distinct qc.tag_id) into v_distinct
    from public.quiz_choices qc
    join public.quiz_questions qq on qq.id = qc.question_id
   where qq.prompt_id = v_prompt_id;

  if v_distinct <> p_question_count * 4 then
    raise exception
      'QUIZ_CHOICES_DUPLICATE: 選択肢のタグが重複しています（%種類／必要 %種類）。',
      v_distinct, p_question_count * 4;
  end if;

end;
$fn$;

comment on function public.build_quiz_for_prompt(uuid, int) is
  '出題と4択を作る（complete_draft から切り出し）。誤答に正解と同じ同義グループの'
  '語を入れない（D96）。内部専用。';

revoke all on function public.build_quiz_for_prompt(uuid, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. complete_draft ／ お題とクイズを確定する
-- ----------------------------------------------------------------------------
--
-- 【旧版からの変更点】
--   (a) 枠の数を「そのモードの固定枠」ではなく「実際に選ばれたカード」で数える
--   (b) 出題する枠を、モードの枠一覧ではなく**このお題のカード**から選ぶ
--       （旧方式では両者が一致するので、過去と同じ結果になる）
--   (c) 誤答から、正解と同じ同義グループの語を外す（D96）
--   (d) 持ち出した要素の派生関係を prompt_element_origins に書く（D161）
--   (e) 持ち出しがあれば prompts.origin を 'saved' にする
--
-- 【変えていない点】
--   ・4択のうち正解はちょうど1件、選択肢はちょうど4件を数え直す
--   ・1つのお題の全選択肢でタグが重複しない
--   ・足りないときは重複で埋めず、失敗させて巻き戻す

create or replace function public.complete_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_session      record;
  v_slot_count   int;
  v_chosen_count int;
  v_prompt_id    uuid;
  v_inserted     int;
  v_bad          int;
  v_distinct     int;
  v_carried      int;
  v_two_stage    boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.reroll_count,
         ds.current_generation, ds.time_limit_seconds, ds.quiz_question_count
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  select dm.uses_two_stage into v_two_stage
    from public.draft_modes dm where dm.mode_key = v_session.mode_key;

  if v_two_stage then
    select count(*) into v_slot_count
      from public.draft_session_slots s
     where s.session_id = p_session_id
       and s.generation = v_session.current_generation;
  else
    select count(*) into v_slot_count
      from public.draft_mode_slots dms
     where dms.mode_key = v_session.mode_key;
  end if;

  select count(*) into v_chosen_count
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  if v_chosen_count <> v_slot_count then
    raise exception 'DRAFT_INCOMPLETE: まだ決まっていない枠があります（%/%）。',
      v_chosen_count, v_slot_count;
  end if;

  select count(*) into v_carried
    from public.draft_session_carried c where c.session_id = p_session_id;

  -- --- 1. お題 --------------------------------------------------------------
  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status, origin)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active',
     case when v_carried > 0 then 'saved' else 'draft' end)
  returning id into v_prompt_id;

  -- --- 2. 答えのカード ------------------------------------------------------
  insert into public.prompt_cards (prompt_id, card_slot_key, slot_order, tag_id)
  select v_prompt_id, dc.card_slot_key, dc.slot_order, dc.tag_id
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_slot_count then
    raise exception 'CARD_COUNT_MISMATCH: 答えのカードが %件です（必要 %件）。',
      v_inserted, v_slot_count;
  end if;

  -- --- 2-b. 派生関係（D161）--------------------------------------------------
  if v_carried > 0 then
    insert into public.prompt_element_origins
      (prompt_id, tag_id, source_prompt_id, source_work_id)
    select v_prompt_id, c.tag_id, c.source_prompt_id, c.source_work_id
      from public.draft_session_carried c
     where c.session_id = p_session_id
    on conflict (prompt_id, tag_id) do nothing;
  end if;

  -- --- 3〜5. 出題と4択を作る ------------------------------------------------
  --
  -- 中身は build_quiz_for_prompt にまとめてある。
  -- **確定の経路と、試験の準備の経路が同じ関数を通る**ようにするため。
  -- 別々に書くと、片方だけ直したときに試験が素通りする。
  perform public.build_quiz_for_prompt(v_prompt_id, v_session.quiz_question_count);

  -- --- 6. ドラフトを完了にする ----------------------------------------------
  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  return jsonb_build_object(
    'prompt_id',      v_prompt_id,
    'mode_key',       v_session.mode_key,
    'card_count',     v_slot_count,
    'question_count', v_session.quiz_question_count
  );
end;
$fn$;

comment on function public.complete_draft(uuid) is
  'お題とクイズを確定生成する。出題枠はこのお題のカードから quiz_priority 順に選ぶ。'
  '誤答に正解と同じ同義グループの語を入れない（D96）。持ち出しの派生関係も記録する（D161）。';

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 8. reroll_draft ／ 引き直し
-- ----------------------------------------------------------------------------
--
-- 変更点は1つだけ。current_slot_order を1に戻す処理をやめる。
-- 新方式では持ち出しの枠が先頭を占めるので、最初にめくる枠は
-- draft_generate_candidates が世代を作り終えてから決める。

create or replace function public.reroll_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_session record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.candidate_count,
         ds.max_rerolls, ds.reroll_count, ds.current_generation
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  if v_session.reroll_count >= v_session.max_rerolls then
    raise exception 'NO_REROLL_LEFT: 引き直せる回数が残っていません。';
  end if;

  update public.draft_sessions ds
     set reroll_count       = ds.reroll_count + 1,
         current_generation = ds.current_generation + 1,
         current_slot_order = 1
   where ds.id = p_session_id;

  -- 新方式では、この中で current_slot_order を持ち出しの次へ進める
  perform public.draft_generate_candidates(
    p_session_id,
    v_session.current_generation + 1,
    v_session.mode_key,
    v_session.candidate_count);

  return public.draft_state_json(p_session_id);
end;
$fn$;

revoke all on function public.reroll_draft(uuid) from public, anon, authenticated;
grant execute on function public.reroll_draft(uuid) to authenticated;
