-- ============================================================================
-- 20260907120000 ／ 一巡で仮のお題を作り、カテゴリごとに1回だけ引き直す
-- ============================================================================
--
-- 出所: ユーザー指示（2026-09-08）「現在本番に入っているドローUIは最新仕様では
-- ない」。D170 / D171 で作った「確認して決める・残しておく・残りを見る」は
-- 画面の作法としては使わない。**関数と列は消さない**（同指示 30）。
--
-- 【新しい流れ】
--
--   一巡目
--     カテゴリごとに、伏せカードを1枚引く。引いた瞬間に「仮採用」になり、
--     確認を挟まずに次のカテゴリへ進む。一巡し終えて初めて、
--     仮のお題がまとまって見える。
--
--   カテゴリごとの引き直し（1カテゴリにつき1回だけ）
--     押しても、その場ではまだ捨てない。取り消せないことを伝える画面を挟む。
--     そこで決めると、
--       1. 仮採用のカードを永久に捨てる（もう選べない）
--       2. そのカテゴリの残り候補が開く
--       3. 残りから1枚選ぶ
--       4. そのカテゴリは確定。二度目の引き直しはできない
--
-- 【捨てたカードは戻らない】
--   `draft_candidates.is_discarded` に印を付ける。行は消さない（何が捨てられたか
--   を後から追えるようにするため）。**印の付いたカードは、二度と選べない。**
--   画面がボタンを隠すのではなく、`pick_card` が断る。
--
-- 【読み込み直し・二度押し・戻るボタン】
--   状態はすべて DB にある。
--     ・引き直しを二度押しても、2枚目は捨てられない（redo_used を見る）
--     ・捨てたカードを選ぼうとしても断られる（is_discarded を見る）
--     ・選び直しを二度送っても、2回目は今の状態を返すだけ
--     ・戻って同じ要求を送り直しても、上と同じ理由で何も起きない
--
-- 【既存のデータへの影響】
--   足すのは列2つだけで、既定値がある。既存の行は1行も書き換わらない。
--   進行中のドラフトも、そのまま新しい画面で続けられる
--   （is_discarded は false、redo_used は false から始まる）。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 捨てたカードの印
-- ----------------------------------------------------------------------------

alter table public.draft_candidates
  add column if not exists is_discarded boolean not null default false;

comment on column public.draft_candidates.is_discarded is
  '引き直しで永久に捨てたカード（2026-09-08）。二度と選べない。行は消さない。';

-- 捨てたカードが選ばれた状態にはならない
alter table public.draft_candidates
  drop constraint if exists draft_candidates_discarded_not_chosen;
alter table public.draft_candidates
  add constraint draft_candidates_discarded_not_chosen check (
    is_discarded = false or is_chosen = false
  );


-- ----------------------------------------------------------------------------
-- 2. そのカテゴリで引き直しを使ったか
-- ----------------------------------------------------------------------------

alter table public.draft_session_slots
  add column if not exists redo_used boolean not null default false;

comment on column public.draft_session_slots.redo_used is
  'そのカテゴリで引き直しを使ったか（2026-09-08）。1カテゴリにつき1回だけ。';


-- ----------------------------------------------------------------------------
-- 3. 一巡目：1枚引いて仮採用し、次のカテゴリへ進む
-- ----------------------------------------------------------------------------
--
-- 【reveal_card + choose_card を1つにまとめたもの】
--   確認を挟まないので、めくることと決めることを分ける必要が無くなった。
--   古い2つの関数は消していない（指示30）。呼ばれなくなるだけ。
--
-- 【引き直しのあとの選び直しも、この関数が受ける】
--   一巡目と選び直しで、利用者がすることは同じ「1枚選ぶ」。
--   違うのは、選べる相手が伏せカードか、開いた残りか、だけ。
--   関数を分けると、二度押しの防ぎ方を2か所に書くことになる。

create or replace function public.pick_card(
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
  v_slot       record;
  v_discarded  boolean;
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

  select s.slot_order, s.redo_used, s.pool_revealed_at
    into v_slot
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.card_slot_key = p_card_slot_key;

  if not found then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  -- すでに決まっているカテゴリは触らせない。
  -- **二度押しでも壊れない。**今の状態をそのまま返す。
  select exists (
      select 1 from public.draft_candidates dc
       where dc.session_id = p_session_id
         and dc.generation = v_session.current_generation
         and dc.card_slot_key = p_card_slot_key
         and dc.is_chosen)
    into v_chosen;

  if v_chosen then
    return public.draft_state_json(p_session_id);
  end if;

  -- 選べる場面は2つだけ。
  --   ・一巡目で、いまの順番のカテゴリ
  --   ・引き直しのあとで、選び直しを待っているカテゴリ
  if not (v_slot.redo_used or v_slot.slot_order = v_session.current_slot_order) then
    raise exception 'WRONG_SLOT_ORDER: いま引けるのは %番目のカテゴリです。',
      v_session.current_slot_order;
  end if;

  select dc.is_discarded into v_discarded
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  if not found then
    raise exception 'CANDIDATE_NOT_FOUND: %番のカードはありません。', p_candidate_index;
  end if;

  -- **捨てたカードは戻らない。**画面で隠すだけにしない
  if v_discarded then
    raise exception 'CARD_DISCARDED: そのカードは捨てました。もう選べません。';
  end if;

  update public.draft_candidates dc
     set revealed_at = coalesce(dc.revealed_at, clock_timestamp()),
         is_chosen   = true
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  -- 一巡目のときだけ、次のカテゴリへ進める。
  -- 引き直しの選び直しでは順番を動かさない（もう一巡は終わっている）
  if not v_slot.redo_used then
    update public.draft_sessions ds
       set current_slot_order = coalesce((
             select min(s2.slot_order)
               from public.draft_session_slots s2
              where s2.session_id = p_session_id
                and s2.generation = v_session.current_generation
                and s2.source = 'lottery'
                and s2.slot_order > v_slot.slot_order), v_slot.slot_order + 1)
     where ds.id = p_session_id;
  end if;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.pick_card(uuid, text, int) is
  '1枚引いて仮採用する（2026-09-08）。一巡目は次のカテゴリへ自動で進む。'
  '引き直しのあとの選び直しも受ける。捨てたカードは選べない。';

revoke all on function public.pick_card(uuid, text, int)
  from public, anon, authenticated;
grant execute on function public.pick_card(uuid, text, int) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. カテゴリごとの引き直し（1回だけ・取り消せない）
-- ----------------------------------------------------------------------------
--
-- 押す前の確認は画面が持つ。ここへ届いた時点で、利用者は取り消せないことに
-- 同意している。**この関数は確認しない。捨てる。**

create or replace function public.redo_slot(
  p_session_id    uuid,
  p_card_slot_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_session   record;
  v_slot      record;
  v_left      int;
  v_pending   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- 行を押さえてから見る。**同じ要求が2本同時に届いても、捨てるのは1枚だけ。**
  select ds.id, ds.status, ds.current_generation
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id and ds.user_id = v_uid
     for update;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  perform public.assert_draft_not_expired(p_session_id);

  select s.slot_order, s.redo_used, s.source
    into v_slot
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.card_slot_key = p_card_slot_key;

  if not found then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  if v_slot.source <> 'lottery' then
    raise exception
      'CARRIED_SLOT: 持ち出した要素の枠は引き直せません。抽選で引いた枠だけです。';
  end if;

  -- **1カテゴリにつき1回だけ。**二度目は断る（戻るボタンで送り直しても同じ）
  if v_slot.redo_used then
    raise exception
      'REDO_ALREADY_USED: このカテゴリはもう引き直しました。引き直せるのは1回だけです。';
  end if;

  -- 一巡し終えるまでは引き直せない。仮のお題が見えていない段階で捨てさせない
  select count(*) into v_pending
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and not exists (
       select 1 from public.draft_candidates dc
        where dc.session_id = s.session_id
          and dc.generation = s.generation
          and dc.card_slot_key = s.card_slot_key
          and dc.is_chosen);

  if v_pending > 0 then
    raise exception
      'PASS_NOT_FINISHED: まず全部のカテゴリを引いてください。'
      '引き直せるのは、仮のお題がそろってからです。';
  end if;

  -- 捨てたあとに選べるカードが1枚も無いなら、引き直しても意味が無い
  select count(*) into v_left
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and not dc.is_chosen
     and not dc.is_discarded;

  if v_left < 1 then
    raise exception
      'NO_ALTERNATIVE: このカテゴリには、ほかの候補がありません。引き直せません。';
  end if;

  -- 1. 仮採用のカードを捨てる（順番が大事。先に is_chosen を外す）
  update public.draft_candidates dc
     set is_chosen    = false,
         is_discarded = true,
         is_held      = false
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.is_chosen;

  -- 2. そのカテゴリの残りを開く。3. 引き直しを使ったことを記録する
  update public.draft_session_slots s
     set pool_revealed_at = coalesce(s.pool_revealed_at, clock_timestamp()),
         redo_used        = true
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.card_slot_key = p_card_slot_key;

  -- 残りの中身が見えるように、めくった印を付ける
  update public.draft_candidates dc
     set revealed_at = coalesce(dc.revealed_at, clock_timestamp())
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key;

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.redo_slot(uuid, text) is
  'カテゴリを1回だけ引き直す（2026-09-08）。仮採用のカードを永久に捨て、'
  '残り候補を開く。二度目は断る。確認は画面が持つ。';

revoke all on function public.redo_slot(uuid, text)
  from public, anon, authenticated;
grant execute on function public.redo_slot(uuid, text) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. 引き直しを使ったドラフトは、全体を引き直せない
-- ----------------------------------------------------------------------------
--
-- 全体の引き直しは候補をまるごと作り直す。捨てたカードを「無かったこと」に
-- してしまうので、カテゴリの引き直しを使ったあとは断る。
-- 開示した枠があるときに断るのは D171 から続いている決まり。

create or replace function public.reroll_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_session  record;
  v_locked   int;
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

  perform public.assert_draft_not_expired(p_session_id);

  select count(*) into v_locked
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and (s.pool_revealed_at is not null or s.redo_used);

  if v_locked > 0 then
    raise exception
      'POOL_ALREADY_REVEALED: 引き直したカテゴリがあるので、'
      'このドラフトはもう全部引き直せません。開いた候補の中から選んでください。';
  end if;

  if v_session.reroll_count >= v_session.max_rerolls then
    raise exception 'NO_REROLL_LEFT: 引き直せる回数が残っていません。';
  end if;

  update public.draft_sessions ds
     set reroll_count       = ds.reroll_count + 1,
         current_generation = ds.current_generation + 1,
         current_slot_order = 1
   where ds.id = p_session_id;

  perform public.draft_generate_candidates(
    p_session_id,
    v_session.current_generation + 1,
    v_session.mode_key,
    v_session.candidate_count);

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.reroll_draft(uuid) is
  'ドラフト全体を引き直す。引き直したカテゴリがあるときは断る（2026-09-08）。';


-- ----------------------------------------------------------------------------
-- 6. 盤面の状態に、新しい印を足す
-- ----------------------------------------------------------------------------
--
-- 足すのは4つ。
--   is_discarded     捨てたカードか（カード単位）
--   redo_used        そのカテゴリで引き直しを使ったか（枠単位）
--   needs_pick       いま選び直しを待っているか（枠単位）
--   can_redo         いま引き直せるか（枠単位）
-- そして全体に initial_pass_done（一巡し終えたか）。
--
-- **画面はこの値だけを見る。**画面の中で「引けるか」を組み立て直さない。

create or replace function public.draft_state_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with base as (
    select ds.*, dm.label as mode_label,
           dm.quiz_question_count as mode_question_count,
           dm.uses_two_stage
      from public.draft_sessions ds
      join public.draft_modes dm on dm.mode_key = ds.mode_key
     where ds.id = p_session_id
  ),
  slot_state as (
    select s.card_slot_key,
           s.slot_order,
           s.source,
           s.redo_used,
           s.pool_revealed_at is not null as pool_revealed,
           coalesce(s.candidate_count, 0) as slot_candidate_count,
           exists (select 1 from public.draft_candidates dc
                    where dc.session_id = s.session_id
                      and dc.generation = s.generation
                      and dc.card_slot_key = s.card_slot_key
                      and dc.is_chosen) as decided,
           (select count(*) from public.draft_candidates dc
             where dc.session_id = s.session_id
               and dc.generation = s.generation
               and dc.card_slot_key = s.card_slot_key
               and not dc.is_chosen and not dc.is_discarded)::int as alternatives
      from public.draft_session_slots s, base b
     where s.session_id = b.id and s.generation = b.current_generation
  ),
  pass as (
    select count(*) filter (where not decided) = 0 as done from slot_state
  )
  select jsonb_build_object(
    'session_id',          b.id,
    'mode_key',            b.mode_key,
    'mode_label',          b.mode_label,
    'status',              b.status,
    'candidate_count',     b.candidate_count,
    'max_rerolls',         b.max_rerolls,
    'reroll_count',        b.reroll_count,
    'rerolls_left',        b.max_rerolls - b.reroll_count,
    'time_limit_seconds',  b.time_limit_seconds,
    -- 互換期間だけ返す旧い鍵（出どころは draft_modes。採点には使わない）
    'quiz_question_count', b.mode_question_count,
    'draft_base',          b.draft_base,
    'generation',          b.current_generation,
    'current_slot_order',  b.current_slot_order,
    -- 一巡し終えたか。仮のお題を見せてよいかの判定に使う
    'initial_pass_done',   (select done from pass),
    'slot_count',          (
      case when b.uses_two_stage
        then (select count(*) from public.draft_session_slots s
               where s.session_id = b.id and s.generation = b.current_generation)
        else (select count(*) from public.draft_mode_slots dms
               where dms.mode_key = b.mode_key)
      end
    ),
    'carried_count',       (
      select count(*) from public.draft_session_carried c
       where c.session_id = b.id
    ),
    'chosen_count',        (select count(*) from public.draft_candidates dc
                             where dc.session_id = b.id
                               and dc.generation = b.current_generation
                               and dc.is_chosen),
    'is_ready_to_complete', (select done from pass),
    'slots', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   x.card_slot_key,
                 'card_slot_label', x.card_slot_label,
                 'category_label',  x.category_label,
                 'is_carried',      ss.source = 'carried',
                 'candidate_count', case when ss.slot_candidate_count > 0
                                         then ss.slot_candidate_count
                                         else x.n end,
                 'pool_revealed',   ss.pool_revealed,
                 'redo_used',       ss.redo_used,
                 -- いま選び直しを待っている枠
                 'needs_pick',      ss.redo_used and not ss.decided,
                 -- いま引き直せる枠。**画面はこれだけを見る**
                 'can_redo',        (select done from pass)
                                    and ss.source = 'lottery'
                                    and not ss.redo_used
                                    and ss.decided
                                    and ss.alternatives >= 1,
                 'held_limit',      least(2, (case when ss.slot_candidate_count > 0
                                                   then ss.slot_candidate_count
                                                   else x.n end) - 1),
                 'slot_order',      ss.slot_order,
                 'is_current',      ss.slot_order = b.current_slot_order,
                 'candidates',      x.candidates
               )
               order by ss.slot_order
             )
        from (
          select dc.card_slot_key,
                 cs.label as card_slot_label,
                 tp.label as category_label,
                 count(*)::int as n,
                 jsonb_agg(
                   jsonb_build_object(
                     'candidate_index', dc.candidate_index,
                     'revealed',        dc.revealed_at is not null,
                     'is_chosen',       dc.is_chosen,
                     'is_held',         dc.is_held,
                     'is_discarded',    dc.is_discarded,
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
           where dc.session_id = b.id
             and dc.generation = b.current_generation
           group by dc.card_slot_key, cs.label, tp.label
        ) x
        join slot_state ss on ss.card_slot_key = x.card_slot_key
    ), '[]'::jsonb)
  )
  from base b;
$fn$;

revoke all on function public.draft_state_json(uuid)
  from public, anon, authenticated;
