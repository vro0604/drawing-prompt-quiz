-- ============================================================================
-- merge_draft_state_contract ／ 盤面の読み出し口を1本にまとめ直す
-- ============================================================================
--
-- 【なぜこれが要るか】
--   同じ名前の関数 draft_state_json を、2つの作業線がそれぞれ作り直していた。
--
--     こちら（P0）      引き直し・捨て札・一巡の状態を返すように作り直した
--     もう片方（D191/D193）形状アシストとサブ指令を返すように作り直した
--
--   もう片方は先に本番へ入っている。こちらの P0 をそのまま当てると、
--   同じ名前・同じ引数なので、もう片方の作り直しが上書きされて消える。
--   実測: 本番と同じ並びを手元に作り、P0 を当てると
--   draft_state_json から shape_assist_key と sub_directive_key が
--   返らなくなることを確認した（2026-09-10）。
--
-- 【この migration がすること】
--   draft_state_json を1本だけ作り直す。中身は
--   「P0 が返すもの全部」＋「もう片方が返していたもの全部」。
--   どちらの鍵も落とさない。
--
--   足す鍵は2つだけ。
--     てっぺんへ  shape_assist_key    形の取っかかり（D191）
--     枠ごとへ    sub_directive_key   制作の手がかり（D193）
--
-- 【表も列も1つも作らない】
--   もう片方の migration を持ち込むことはしない。列を足すこともしない。
--   足す2つの鍵は、行をまるごと jsonb にしてから鍵で引く形にしてある
--   （to_jsonb(ds) -> 'shape_assist_key'）。
--   だから列がまだ無い並び——たとえば手元の検査用データベース——でも
--   この migration は落ちず、その鍵は null になる。
--   列がある並び——いまの本番——では、これまでどおりの値が返る。
--
-- 【当てる位置】
--   20260907120000（P0）より後なら、どこでもよい。
--   P0 より後の5本（20260908120000 / 20260908160000 / 20260909090000 /
--   20260909120000 / 20260909150000）は draft_state_json を作り直さない
--   （実測: 5本を grep して create or replace が0件）。
--   なので、この1本が最後の定義になる。
--
-- 【戻すとき】
--   20260910140000_sub_directive.sql の draft_state_json を当て直せば、
--   もう片方の版へ戻る。ただし P0 の鍵は返らなくなる。
-- ============================================================================

create or replace function public.draft_state_json(p_session_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with base as (
    select ds.*, dm.label as mode_label,
           -- 形状アシスト（D191）。列がまだ無い並びでも落ちないよう、
           -- 行ごと jsonb にしてから鍵で引く。無ければ null になる
           to_jsonb(ds) -> 'shape_assist_key' as shape_assist_key_j,
           dm.quiz_question_count as mode_question_count,
           dm.uses_two_stage
      from public.draft_sessions ds
      join public.draft_modes dm on dm.mode_key = ds.mode_key
     where ds.id = p_session_id
  ),
  slot_state as (
    select s.card_slot_key,
           -- サブ指令（D193）。同じ理由で行ごと jsonb にしてから引く
           to_jsonb(s) -> 'sub_directive_key' as sub_directive_key_j,
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
    -- 形状アシスト（D191）。お題ではない。盤面に小さく出すためだけの値
    'shape_assist_key',    b.shape_assist_key_j,
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
                 -- サブ指令（D193）。正式な語1つに添える制作の手がかり
                 'sub_directive_key', ss.sub_directive_key_j,
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
