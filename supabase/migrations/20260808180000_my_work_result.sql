-- ============================================================================
-- 20260808180000_my_work_result.sql
--   K ／ 結果の主従を入れ替える。取りに行った人にだけ出す（D112 / D134）
-- ============================================================================
--
-- 【何を変えるか】
--   いまは作品ページを開いた瞬間、項目別の伝達率が誰にでも見えている。
--   これを2つに分ける。
--
--     予告（既定）… 何人が答えたか ＋ まったく違う読まれ方があったか
--     中身（開く）… 正答率／項目別／誰が何と間違えたか
--
--   **他人には、そもそも出さない。**D112 の表が
--   「他人の作品ページ＝絵とタイトルだけ」と決めている。
--   いま出ているのは仕様の取りこぼし。
--
-- 【予告が数字にならないようにする】
--   D112 は「予告自体が数字になると本末転倒」と警告している。
--   D134 で予告に人数を出すと決めたが、**そこには落とし穴がある。**
--
--     「3人が答えました。うち2人が間違えました」
--       → 読んだ人は 1/3 と計算できる。**それは正答率そのもの。**
--
--   そこで2行目を「**全部の枠を外した人**の数」にする。
--
--     ・全部外すのは珍しいので、正答率は復元できない
--       （正答率が高くても、1人だけ全部外していることはある）
--     ・「まったく違うものを見ていた」という文と意味が一致する
--     ・**驚きの核はここにある。**部分的なズレより、
--       まるごと違う読まれ方のほうが、封を開けたくなる
--
-- 【誰が答えたかは返さない】
--   回答者の身元は出さない。**「誰が」ではなく「何と」**を見せる。
--   誰が間違えたかが分かると、次から答えにくくなる。
-- ============================================================================


create or replace function public.get_my_work_result(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
begin
  if v_uid is null then
    return null;
  end if;

  -- **自分の作品でなければ、存在しないのと同じ扱い**（D40）。
  -- 「権限がありません」と言うと、その作品があることを教えてしまう。
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
      select a.id, a.correct_count
        from public.answers a
       where a.work_id = p_work_id
    ),
    items as (
      select ai.card_slot_key, ai.selected_tag_id, ai.is_correct
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
    ),
    -- 1回の回答が何問だったか。枠の数で割り出す
    per_answer as (
      select ai.answer_id, count(*) as total, sum((ai.is_correct)::int) as corrects
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
       group by ai.answer_id
    )
    select jsonb_build_object(
      'answers_count', (select count(*) from ans),

      -- 予告の2行目。**全部の枠を外した人の数**
      'blind_count', (
        select count(*) from per_answer pa where pa.corrects = 0
      ),

      -- 中身。開いたときだけ画面に出す
      'total_items',   (select count(*) from items),
      'correct_items', (select count(*) from items i where i.is_correct),

      -- 誰が何と間違えたか。**身元は返さない**
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
              from items i
              join public.tags t        on t.id = i.selected_tag_id
              join public.card_slots cs on cs.card_slot_key = i.card_slot_key
             where not i.is_correct
             group by cs.label, t.label
          ) x
      ), '[]'::jsonb)
    )
  );
end;
$fn$;

comment on function public.get_my_work_result(uuid) is
  '自分の作品の結果。他人・未サインインには null（存在を教えない・D40）。'
  'blind_count は「全部の枠を外した人」の数。'
  '正答率を復元できない形で驚きだけを予告するため（D134）。'
  '回答者の身元は返さない。';

revoke all on function public.get_my_work_result(uuid)
  from public, anon, authenticated;

grant execute on function public.get_my_work_result(uuid)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_res jsonb;
  v_id  uuid;
begin
  -- 他人の作品では null になること。
  -- サインインしていない状態（auth.uid() が null）で呼ぶので、
  -- どの作品IDでも null が返るはず
  select w.id into v_id from public.works w limit 1;

  if v_id is not null then
    v_res := public.get_my_work_result(v_id);
    if v_res is not null then
      raise exception 'サインインしていないのに結果が返りました';
    end if;
  end if;

  raise notice 'K 完了: get_my_work_result を追加しました';
end $$;


-- ============================================================================
-- rollback（手で流す用）
-- ============================================================================
--
--   drop function if exists public.get_my_work_result(uuid);
-- ============================================================================
