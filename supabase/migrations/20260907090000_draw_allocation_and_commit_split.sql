-- ============================================================================
-- 20260907090000 ／ 候補枚数の配分・モーフ上限2・ドローと確定の分離・
--                   枠内の保持と残り開示
-- ============================================================================
--
-- 出所: ユーザー指示（2026-09-07）。決定記録は D170。
--
-- 【この migration が変える4つ】
--   1. 候補枚数を「1枠あたり一律5枚」から「総数を先に決めて2〜5枚で配る」へ
--   2. モーフの上限を通常・高難度とも2枠へ
--   3. めくることと決めることを分ける（hidden / revealed_pending / chosen）
--   4. 枠の中で候補を保持し、残りを開示してから選べるようにする
--
-- 【既存列の意味は変えない】
--   `draft_modes.candidate_count` と `draft_sessions.candidate_count` は
--   そのまま残す。過去1,050件のお題と889件の作品が、この列の意味で作られている。
--   新しい配分は新しい列（candidate_min / candidate_max / candidate_avg）で決める。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 配分の設定をモードへ足す
-- ----------------------------------------------------------------------------
--
-- 総ドラフト基数 = 抽選する枠の数 × candidate_avg。
-- 3枠なら9、4枠なら12、5枠なら15、6枠なら18（ユーザー指示の暫定値）。
--
-- 持ち出しの枠は数に入れない。中身が最初から決まっていて1枚しか置かないため。
-- **この除外はユーザー指示に無い。私が置いた暫定の扱い（D170 に明記）。**

alter table public.draft_modes
  add column if not exists candidate_min int not null default 2,
  add column if not exists candidate_max int not null default 5,
  add column if not exists candidate_avg int not null default 3;

comment on column public.draft_modes.candidate_min is
  '1枠に配る候補の下限（D170）。既存の candidate_count とは別の列。';
comment on column public.draft_modes.candidate_max is
  '1枠に配る候補の上限（D170）。';
comment on column public.draft_modes.candidate_avg is
  '総ドラフト基数を出すための1枠あたりの平均（D170）。総数 = 抽選枠数 × この値。';

alter table public.draft_modes
  drop constraint if exists draft_modes_candidate_range_valid;
alter table public.draft_modes
  add constraint draft_modes_candidate_range_valid check (
    candidate_min >= 1
    and candidate_max >= candidate_min
    and candidate_avg between candidate_min and candidate_max
  );

-- 総ドラフト基数は、セッションが始まった時点の値を写して持つ。
-- あとで設定を変えても、進行中のドラフトの合計は動かない。
alter table public.draft_sessions
  add column if not exists draft_base int;

comment on column public.draft_sessions.draft_base is
  'そのセッションで配り切る候補の総数（D170）。null は旧方式のセッション。';


-- ----------------------------------------------------------------------------
-- 2. モーフの上限を2へ（D158 の改訂）
-- ----------------------------------------------------------------------------
--
-- 通常も高難度も、1つのお題に入るモーフは最大2枠。
-- 3モーフの確率は削り、1モーフ60%・2モーフ40%へ寄せる（ユーザー指示の暫定値）。

update public.draft_modes set morph_max = 2 where morph_max is not null;

update public.draw_config
   set config_value = 0.60,
       note = '通常でモーフ1個（D170。3個を廃止したぶんを1個と2個へ配り直した）'
 where config_key = 'normal_morph_1_ratio';

update public.draw_config
   set config_value = 0.40,
       note = '通常でモーフ2個（D170）'
 where config_key = 'normal_morph_2_ratio';

delete from public.draw_config where config_key = 'normal_morph_3_ratio';

update public.draw_config
   set config_value = 0.60,
       note = '高難度でモーフ1個（D170）'
 where config_key = 'hard_morph_1_ratio';


-- ----------------------------------------------------------------------------
-- 3. 枠の中の保持と、残り候補の開示
-- ----------------------------------------------------------------------------
--
-- 【ここでいう「保持」は、持ち出し3区分のどれとも違う】
--   持ち出し（saved_elements）は「次のお題へ語を持っていく」もの。
--   ここでの保持は「いま見ている枠の中で、気に入った候補を残したまま
--   残りを見る」もの。**別の概念なので、別の列で持つ。**
--   混ぜると、A/B/C の上限とこの上限が同じ数を取り合う。

alter table public.draft_candidates
  add column if not exists is_held boolean not null default false;

comment on column public.draft_candidates.is_held is
  '枠の中で「残す」と印を付けた候補（D170）。持ち出し（saved_elements）とは別物。';

-- 保持できるのは、めくってある候補だけ
alter table public.draft_candidates
  drop constraint if exists draft_candidates_held_needs_reveal;
alter table public.draft_candidates
  add constraint draft_candidates_held_needs_reveal check (
    is_held = false or revealed_at is not null
  );

-- その枠の残りを開示した時刻。入っていたら、その枠の抽選はもう終わり
alter table public.draft_session_slots
  add column if not exists pool_revealed_at timestamptz;

comment on column public.draft_session_slots.pool_revealed_at is
  'その枠の残り候補を開示した時刻（D170）。入っていると、その枠は再抽選できない。';


-- ----------------------------------------------------------------------------
-- 4. 開示の理由に「制作中の開示」を足す
-- ----------------------------------------------------------------------------
--
-- 既存の3つ（投稿完了・放棄・本人の明示操作）は残す。
-- 制作中の開示は枠単位で起きるので、お題全体の reveal_reason とは別物。
-- お題の列には、制作中に開示したことを 'in_progress' として記録する。

alter table public.prompts
  drop constraint if exists prompts_reveal_reason_valid;
alter table public.prompts
  add constraint prompts_reveal_reason_valid check (
    reveal_reason is null
    or reveal_reason in ('work_submitted', 'abandoned', 'manual', 'in_progress')
  );


-- ----------------------------------------------------------------------------
-- 5. 枠ごとの候補枚数を持つ
-- ----------------------------------------------------------------------------

alter table public.draft_session_slots
  add column if not exists candidate_count int;

comment on column public.draft_session_slots.candidate_count is
  'その枠へ配った候補の枚数（D170）。抽選の枠は2〜5、持ち出しの枠は1。';


-- ----------------------------------------------------------------------------
-- 6. 配分を決める
-- ----------------------------------------------------------------------------
--
-- n 個の枠へ、合計がちょうど p_total になるように min〜max の範囲で配る。
--
-- 【やり方】
--   全部を下限で埋めてから、余りを1ずつ、上限に達していない枠へ
--   無作為に足していく。合計は必ず一致し、どの枠も範囲に収まる。
--
--   **均等配分に固定しない。**足す先を毎回引き直すので、
--   3枠・合計9なら 2/2/5 も 2/3/4 も 3/3/3 も出る。
--   （山なりに寄る性質はある。極端な偏りが出にくいという意味なので、
--    ここでは利点として扱う。）

create or replace function public.draft_allocate_counts(
  p_slots int,
  p_total int,
  p_min   int,
  p_max   int
)
returns int[]
language plpgsql
immutable
set search_path = ''
as $fn$
declare
  v_counts int[];
  v_rest   int;
  v_open   int[];
  v_pick   int;
  v_i      int;
begin
  if p_slots <= 0 then
    return array[]::int[];
  end if;

  if p_total < p_slots * p_min or p_total > p_slots * p_max then
    raise exception
      'ALLOCATION_IMPOSSIBLE: %枠へ合計%枚は配れません（範囲は%〜%枚）。',
      p_slots, p_total, p_slots * p_min, p_slots * p_max;
  end if;

  v_counts := array_fill(p_min, array[p_slots]);
  v_rest := p_total - p_slots * p_min;

  while v_rest > 0 loop
    -- まだ上限に届いていない枠の番号を集める
    select array_agg(i) into v_open
      from generate_series(1, p_slots) as g(i)
     where v_counts[g.i] < p_max;

    if v_open is null then
      raise exception 'ALLOCATION_STUCK: 配り切れませんでした（残り%枚）。', v_rest;
    end if;

    v_pick := v_open[1 + floor(random() * array_length(v_open, 1))::int];
    v_counts[v_pick] := v_counts[v_pick] + 1;
    v_rest := v_rest - 1;
  end loop;

  -- 数え直す
  select sum(v_counts[g.i]) into v_i from generate_series(1, p_slots) as g(i);
  if v_i <> p_total then
    raise exception 'ALLOCATION_MISMATCH: 合計が%枚です（必要%枚）。', v_i, p_total;
  end if;

  return v_counts;
end;
$fn$;

comment on function public.draft_allocate_counts(int, int, int, int) is
  '枠へ候補枚数を配る（D170）。合計は必ず一致し、各枠は下限〜上限に収まる。';

revoke all on function public.draft_allocate_counts(int, int, int, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. 候補を配る（新方式だけ配分制へ。旧方式は今までどおり）
-- ----------------------------------------------------------------------------

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
  v_mode       record;
  v_total      int;
  v_counts     int[];
  v_i          int;
  v_slot       record;
begin
  select dm.uses_two_stage, dm.candidate_min, dm.candidate_max, dm.candidate_avg
    into v_mode
    from public.draft_modes dm
   where dm.mode_key = p_mode_key;

  if not found then
    raise exception 'MODE_NOT_FOUND: モード % は使えません。', p_mode_key;
  end if;

  v_two_stage := v_mode.uses_two_stage;

  -- ======================= 旧方式（枠が固定）===============================
  -- **1枠あたり一律。ここは変えない。**過去のお題と同じ形で作られる。
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
      select dms.card_slot_key, dms.sort_order as slot_order, cs.pool_key,
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

  perform public.draft_plan_slots(p_session_id, p_generation, p_mode_key);

  select count(*),
         count(*) filter (where s.source = 'lottery'),
         count(*) filter (where s.source = 'carried')
    into v_slot_count, v_lottery, v_carried
    from public.draft_session_slots s
   where s.session_id = p_session_id and s.generation = p_generation;

  -- --- 持ち出しの枠は1枚だけ置いて開いておく -------------------------------
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

  update public.draft_session_slots s
     set candidate_count = 1
   where s.session_id = p_session_id and s.generation = p_generation
     and s.source = 'carried';

  -- --- 総ドラフト基数を決めて、抽選の枠へ配る（D170）-----------------------
  if v_lottery > 0 then
    v_total := v_lottery * v_mode.candidate_avg;
    v_counts := public.draft_allocate_counts(
                  v_lottery, v_total, v_mode.candidate_min, v_mode.candidate_max);

    v_i := 0;
    for v_slot in
      select s.card_slot_key
        from public.draft_session_slots s
       where s.session_id = p_session_id and s.generation = p_generation
         and s.source = 'lottery'
       order by s.slot_order
    loop
      v_i := v_i + 1;
      update public.draft_session_slots s
         set candidate_count = v_counts[v_i]
       where s.session_id = p_session_id and s.generation = p_generation
         and s.card_slot_key = v_slot.card_slot_key;
    end loop;

    -- そのセッションで配り切る総数を控える
    update public.draft_sessions ds
       set draft_base = v_total
     where ds.id = p_session_id;

    insert into public.draft_candidates
      (session_id, generation, card_slot_key, slot_order, candidate_index, tag_id)
    with slots as (
      select s.card_slot_key, s.slot_order, dcat.pool_key, s.candidate_count,
             coalesce(sum(s.candidate_count) over (
               partition by dcat.pool_key order by s.slot_order
               rows between unbounded preceding and 1 preceding), 0) as pool_offset
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
             s.pool_offset + gs.i + 1 as pick_rn
        from slots s
        cross join lateral generate_series(0, s.candidate_count - 1) as gs(i)
    )
    select p_session_id, p_generation, w.card_slot_key, w.slot_order,
           w.candidate_index, r.tag_id
      from wanted w
      join ranked r on r.pool_key = w.pool_key and r.rn = w.pick_rn;

    get diagnostics v_inserted = row_count;

    if v_inserted <> v_total then
      raise exception
        'NOT_ENOUGH_TAGS: 候補が %件しか作れませんでした（必要 %件）。'
        '使うカテゴリの語彙が不足しています。',
        v_inserted, v_total;
    end if;
  else
    update public.draft_sessions ds set draft_base = 0 where ds.id = p_session_id;
  end if;

  update public.draft_sessions ds
     set current_slot_order = coalesce((
           select min(s.slot_order) from public.draft_session_slots s
            where s.session_id = p_session_id and s.generation = p_generation
              and s.source = 'lottery'), 1)
   where ds.id = p_session_id;
end;
$fn$;

comment on function public.draft_generate_candidates(uuid, int, text, int) is
  '候補カードを配る。新方式は総ドラフト基数を2〜5枚で配分する（D170）。'
  '旧方式は1枠あたり一律のまま。';

revoke all on function public.draft_generate_candidates(uuid, int, text, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 8. 「決める」を独立した操作として足す（D170）
-- ----------------------------------------------------------------------------
--
-- カードの状態は3つになる。
--
--   hidden           revealed_at が null
--   revealed_pending revealed_at が入っていて、is_chosen が false
--   chosen           is_chosen が true
--
-- **ここでは choose_card を足すだけで、reveal_card には触らない。**
--
-- 【なぜ分けたか（本番へ出す順番の都合）】
--   reveal_card を「めくるだけ」に変えるのは、いま動いている画面と
--   噛み合わない。いまの画面はめくった時点で決まると思って作られていて、
--   決まらなくなると枠が進まず、その場で止まる。
--   DBを先に更新すると、画面が入れ替わるまでのあいだ、それが起きる。
--
--   そこで reveal_card の変更だけを別のファイル
--   （20260907110000_split_reveal_from_commit.sql）へ移した。
--   このファイルまでを当てた状態では、いまの画面はこれまでどおり動く。
--   新しい画面が本番に出てから、そのファイルを当てる。
--   **どちらの順番でも、止まる時間が生まれない。**

-- 決める。ここで初めて枠が進む
create or replace function public.choose_card(
  p_session_id      uuid,
  p_card_slot_key   text,
  p_candidate_index int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid        uuid := (select auth.uid());
  v_session    record;
  v_slot_order int;
  v_revealed   timestamptz;
  v_chosen     boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  perform public.assert_draft_not_expired(p_session_id);

  select dc.slot_order, dc.revealed_at, dc.is_chosen
    into v_slot_order, v_revealed, v_chosen
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  if v_slot_order is null then
    raise exception 'CANDIDATE_NOT_FOUND: %番のカードはありません。', p_candidate_index;
  end if;

  -- **二重確定でも壊れない。**同じカードなら、そのまま今の状態を返す
  if v_chosen then
    return public.draft_state_json(p_session_id);
  end if;

  if exists (
    select 1 from public.draft_candidates dc
     where dc.session_id = p_session_id
       and dc.generation = v_session.current_generation
       and dc.card_slot_key = p_card_slot_key
       and dc.is_chosen
  ) then
    raise exception 'ALREADY_CHOSEN: その枠はもう決まっています。';
  end if;

  if v_slot_order <> v_session.current_slot_order then
    raise exception 'WRONG_SLOT_ORDER: いま決められるのは %番目の枠です。',
      v_session.current_slot_order;
  end if;

  -- めくっていないカードは決められない。**見ていないものを確定にしない**
  if v_revealed is null then
    raise exception 'NOT_REVEALED: そのカードはまだめくられていません。';
  end if;

  update public.draft_candidates dc
     set is_chosen = true
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  -- 次の抽選枠へ。持ち出しの枠は最初から決まっているので飛ばす
  update public.draft_sessions ds
     set current_slot_order = coalesce((
           select min(s2.slot_order)
             from public.draft_session_slots s2
            where s2.session_id = p_session_id
              and s2.generation = v_session.current_generation
              and s2.source = 'lottery'
              and s2.slot_order > v_slot_order), v_slot_order + 1)
   where ds.id = p_session_id;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.choose_card(uuid, text, int) is
  'めくったカードに決める（D170）。ここで初めて枠が進む。二重確定でも壊れない。';

revoke all on function public.choose_card(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.choose_card(uuid, text, int) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. 枠の中で候補を残す（D170）
-- ----------------------------------------------------------------------------
--
-- 残せるのは min(2, その枠の候補数 - 1) 枚まで。
-- **全部は残せない。**目的は「一部を残したまま探す」ことで、
-- 「全部残して見比べる」ことではない（ユーザー指示 2026-09-07）。
--
-- ゲストと登録者で差を付けない。持ち出し（saved_elements）の A/B/C とは
-- 別の数なので、上限を取り合わない。

create or replace function public.hold_card(
  p_session_id      uuid,
  p_card_slot_key   text,
  p_candidate_index int,
  p_hold            boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid        uuid := (select auth.uid());
  v_session    record;
  v_slot_count int;
  v_held       int;
  v_limit      int;
  v_revealed   timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  select count(*), count(*) filter (where dc.is_held)
    into v_slot_count, v_held
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key;

  if v_slot_count = 0 then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  select dc.revealed_at into v_revealed
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  if v_revealed is null and p_hold then
    raise exception 'NOT_REVEALED: めくっていないカードは残せません。';
  end if;

  if p_hold then
    v_limit := least(2, v_slot_count - 1);
    if v_limit < 1 then
      raise exception 'HOLD_NOT_ALLOWED: この枠では候補を残せません。';
    end if;

    if not exists (
      select 1 from public.draft_candidates dc
       where dc.session_id = p_session_id
         and dc.generation = v_session.current_generation
         and dc.card_slot_key = p_card_slot_key
         and dc.candidate_index = p_candidate_index
         and dc.is_held
    ) and v_held >= v_limit then
      raise exception
        'HOLD_LIMIT: 残せるのは%枚までです（候補%枚）。全部は残せません。',
        v_limit, v_slot_count;
    end if;
  end if;

  update public.draft_candidates dc
     set is_held = p_hold
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.hold_card(uuid, text, int, boolean) is
  '枠の中で候補を残す／外す（D170）。上限は min(2, 候補数 - 1)。全部は残せない。';

revoke all on function public.hold_card(uuid, text, int, boolean)
  from public, anon, authenticated;
grant execute on function public.hold_card(uuid, text, int, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 10. 残りの候補を開示する（D170）
-- ----------------------------------------------------------------------------
--
-- 残した候補があるときだけ押せる。押すとその枠の残りが全部見えるようになり、
-- **その枠の抽選はそこで終わる。**新しい候補は1枚も足さない。
-- 総ドラフト基数は動かない。

create or replace function public.reveal_slot_pool(
  p_session_id    uuid,
  p_card_slot_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid        uuid := (select auth.uid());
  v_session    record;
  v_slot_order int;
  v_held       int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  perform public.assert_draft_not_expired(p_session_id);

  select s.slot_order into v_slot_order
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.card_slot_key = p_card_slot_key;

  if v_slot_order is null then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  if v_slot_order <> v_session.current_slot_order then
    raise exception 'WRONG_SLOT_ORDER: いま開けるのは %番目の枠です。',
      v_session.current_slot_order;
  end if;

  if exists (
    select 1 from public.draft_candidates dc
     where dc.session_id = p_session_id
       and dc.generation = v_session.current_generation
       and dc.card_slot_key = p_card_slot_key
       and dc.is_chosen
  ) then
    raise exception 'ALREADY_CHOSEN: その枠はもう決まっています。';
  end if;

  select count(*) into v_held
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.is_held;

  if v_held = 0 then
    raise exception
      'NOTHING_HELD: 残した候補が1枚もありません。残してから開いてください。';
  end if;

  update public.draft_candidates dc
     set revealed_at = coalesce(dc.revealed_at, clock_timestamp())
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key;

  update public.draft_session_slots s
     set pool_revealed_at = coalesce(s.pool_revealed_at, clock_timestamp())
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.card_slot_key = p_card_slot_key;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.reveal_slot_pool(uuid, text) is
  '枠の残り候補を開示する（D170）。残した候補があるときだけ。'
  '開示した枠には新しい候補を足さない。総ドラフト基数は動かない。';

revoke all on function public.reveal_slot_pool(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reveal_slot_pool(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 11. ドラフトの状態に、新しい3つを足す（D170）
-- ----------------------------------------------------------------------------
--
--   draft_base       そのセッションで配り切る候補の総数
--   candidate_count  枠ごとの候補枚数（2〜5）
--   is_held          その候補を残してあるか
--   pool_revealed    その枠の残りを開示済みか
--   held_limit       その枠で残せる上限 min(2, 候補数 - 1)
--
-- **既存の鍵は1つも消していない。**旧い画面はそのまま動く。

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
$fn$;

revoke all on function public.draft_state_json(uuid)
  from public, anon, authenticated;
