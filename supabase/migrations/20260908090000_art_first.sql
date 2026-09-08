-- ============================================================================
-- 20260908090000_art_first.sql
--   art_first ／ 既に描いてある絵を持ち込み、作者が正式なクイズ項目を決める経路
-- ============================================================================
--
-- 出所: 2026-09-08 のユーザー確定（1〜15）。調査は docs/art-first-investigation.md。
--
-- 【この経路が何であるか】
--   これまでは「お題を引く → 描く → 投稿する」の1本しか無かった。
--   ここで足すのは逆向きの1本。
--     既にある絵 → 作者が「この絵で何を伝えたかったか」を現行語彙から選ぶ
--                → その選択がクイズの正解になる → 他の人が絵だけを見て答える
--
--   **投稿より後ろの仕組みは1つも作り直さない。**出題も採点も集計も開示も、
--   お題から描いた作品と同じ関数が同じ規則で動く。
--
-- 【この migration が変えること】
--   1. prompts.origin の許可値に art_first を足す（列は足さない）
--   2. draft_modes に word_source を足し、語がどこから来るかを3通りで持つ
--   3. art_first のモード行を1つ足す（お題を引く画面には出さない）
--   4. 枠の連番が 1..N で欠けていないことを、この場で確かめる（D69）
--   5. 選べる語の一覧を返す関数を1本
--   6. 持ち込みの投稿を1回で終える関数を1本
--   7. お題・作品の取得系3本に origin を足す（時間の表示を分けるため）
--   8. 時間別ランキングから art_first を外す
--
-- 【この migration が変えないこと】
--   ・既存の表・列・索引を1つも消さない
--   ・既存の行を1行も書き換えない（origin の値も、モードの値も）
--   ・お題から描く経路の関数（start_draft / complete_draft / build_quiz_for_prompt）
--     を1文字も変えない
--   ・get_public_works と get_next_work を変えない（一覧と回答の配給は混在のまま）
--
-- 【なぜ「作者選択」を uses_two_stage = true にしないのか】
--   出所: ユーザー確定3「検査を通すためだけにデータへ事実と異なる意味を
--   記録してはならない」。art_first は二段階抽選をしない。
--   そこで**語がどこから来るかを表す列を新しく足し**、検査の側をその列で
--   3経路に分ける。uses_two_stage は「二段階抽選をするか」の意味のまま残す。
--
-- 【取り消し】このファイルの末尾に書いてある。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. prompts.origin に art_first を足す
-- ----------------------------------------------------------------------------
--
-- 列は 2026-08-08（20260808120000）に入っている。ここでやるのは
-- 許可値を1つ増やすことだけ。既存行は draft か saved しか持たないので、
-- 検査し直しても通る。

alter table public.prompts drop constraint if exists prompts_origin_check;

alter table public.prompts
  add constraint prompts_origin_check
  check (origin in ('draft', 'saved', 'daily', 'art_first'));

comment on column public.prompts.origin is
  'お題の出どころ。draft=ランダム抽選 / saved=持ち出しを含む抽選 / daily=毎日のお題 / '
  'art_first=作品が先にあり、作者が正式なクイズ項目を後から決めたもの。';


-- ----------------------------------------------------------------------------
-- 2. draft_modes.word_source ／ 語がどこから来るか
-- ----------------------------------------------------------------------------
--
--   fixed_slots    … 枠を先に固定して、その枠ごとに抽選する（easy / standard）
--   two_stage_draw … カテゴリを抽選してから語を抽選する（normal / hard。D159）
--   author_pick    … 抽選しない。作者が現行語彙から直接選ぶ（art_first）
--
-- uses_two_stage との違い。あちらは「二段階抽選をするか」の真偽で、
-- 抽選しない経路を表せない。false が「枠固定」と「抽選しない」の2つを
-- 兼ねてしまうため、**どちらなのかを区別できない。**列を分ける。

alter table public.draft_modes
  add column if not exists word_source text not null default 'fixed_slots';

-- 既存4行の値を、いまの実態から埋める。**新しい意味を足していない。**
update public.draft_modes
   set word_source = case when uses_two_stage then 'two_stage_draw' else 'fixed_slots' end
 where word_source = 'fixed_slots' or word_source is null;

comment on column public.draft_modes.word_source is
  'お題の語がどこから来るか。fixed_slots=枠固定の抽選 / two_stage_draw=二段階抽選 / '
  'author_pick=作者が選ぶ（art_first）。診断 A4 系はこの列で経路を分ける。';

-- 旧い整合条件（uses_two_stage と語数の範囲を結んでいたもの）を、
-- word_source を軸にした形へ置き換える。**語数の範囲そのものは変えていない。**
alter table public.draft_modes drop constraint if exists draft_modes_two_stage_fields;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.draft_modes'::regclass
       and conname  = 'draft_modes_word_source_fields'
  ) then
    alter table public.draft_modes
      add constraint draft_modes_word_source_fields check (
        -- 枠固定。語数は draft_mode_slots の行数で決まるので、ここには持たない
        (word_source = 'fixed_slots'
          and uses_two_stage = false
          and word_count_min is null and word_count_max is null and morph_max is null)
        or
        -- 二段階抽選。語数の幅とモーフの上限を持つ（D158）
        (word_source = 'two_stage_draw'
          and uses_two_stage = true
          and word_count_min is not null and word_count_max is not null
          and morph_max is not null
          and word_count_min between 1 and 10
          and word_count_max between word_count_min and 10
          and morph_max between 1 and 3)
        or
        -- 作者が選ぶ。語数の幅は持つが、**モーフの上限は持たない**
        -- （モーフを必須にしない。出所: ユーザー確定2）
        (word_source = 'author_pick'
          and uses_two_stage = false
          and word_count_min is not null and word_count_max is not null
          and morph_max is null
          and word_count_min between 1 and 10
          and word_count_max between word_count_min and 10)
      );
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 3. art_first のモード行
-- ----------------------------------------------------------------------------
--
-- is_active = false にしてある。start_draft はモードを is_active で探すので、
-- **お題を引く経路からは呼べない。**画面の選択肢にも出ない
-- （draft_modes の RLS が is_active = true の行しか見せない）。
--
-- candidate_count は 2〜10 の CHECK があるので、使わないが下限の2を入れる。
-- quiz_question_count は D165 以降どこも使っていない残りの列だが not null。
-- 語数は 3〜6（出所: ユーザー確定2「正式クイズ項目の総数は 3〜6項目」）。

insert into public.draft_modes
  (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
   sort_order, is_active, uses_two_stage, word_source,
   word_count_min, word_count_max, morph_max)
values
  ('art_first', '持ち込み', 2, 0, 3, 5, false, false, 'author_pick', 3, 6, null)
on conflict (mode_key) do update
  set label           = excluded.label,
      is_active       = excluded.is_active,
      uses_two_stage  = excluded.uses_two_stage,
      word_source     = excluded.word_source,
      word_count_min  = excluded.word_count_min,
      word_count_max  = excluded.word_count_max,
      morph_max       = excluded.morph_max;


-- ----------------------------------------------------------------------------
-- 4. 枠の連番が欠けていないことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------
--
-- 作者が同じ分類から2語選んだとき、2語目は <分類>_2 という枠へ入る。
-- 枠の名前は「分類名 ＋ その お題の中での何個目か」という規約
-- （20260904090000 の4）だが、**規約は表に書かれていない。**
-- 番号が 1 から連続していない分類があると、作者が選べたのに
-- 格納できない組み合わせが生まれる。ここで数えて、無いことを確かめる。

--
-- 【数える枠を絞る理由（実測で見つけた）】
--   分類 color には、いまの `color_1` のほかに旧方式の枠 `main_color` と
--   `sub_color` が残っている（20260803013433 の seed。行は消さない決まり）。
--   「その分類の枠を全部数える」と color は3枠に見え、作者に3語まで選ばせて
--   から `color_2` が無くて格納できない、という形になる。
--   （実測: この検査を全数で書いたところ、color で止まった。）
--
--   そこで数えるのは **`<分類>_<番号>` の形をした枠だけ**にする。
--   旧方式の枠は名前の形が違うので、自然に外れる。

do $$
declare
  v_bad text;
begin
  select string_agg(x.pool_key, ', ') into v_bad
    from (
      select dc.pool_key,
             (select count(*) from public.card_slots cs
               where cs.pool_key = dc.pool_key
                 and cs.card_slot_key ~ ('^' || dc.pool_key || '_[0-9]+$')) as n
        from public.draw_categories dc
       where dc.is_active
    ) x
   where x.n = 0
      or exists (
     select 1 from generate_series(1, x.n) as g(i)
      where not exists (
        select 1 from public.card_slots cs
         where cs.card_slot_key = x.pool_key || '_' || g.i
      )
   );

  if v_bad is not null then
    raise exception
      'SLOT_NUMBERING_GAP: 枠の番号が1から連続していない分類があります（%）。'
      '作者選択の格納先を作れません。', v_bad;
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 5. 選べる語の一覧
-- ----------------------------------------------------------------------------
--
-- 【なぜ関数が要るか】
--   語そのもの（tags.id / pool_key / label）は anon にも読める。
--   ところが draw_categories の読める列に pool_key が入っていないので
--   （20260904090000 の2）、「どの分類の語か」をクライアント側で結べない。
--   ここで結んで返す。**新しく公開する情報は1つも無い。**
--
-- 【capacity】
--   その分類に何語まで入れられるか。card_slots の行数がそのまま上限になる
--   （カラーは color_1 の1枠だけなので1）。**画面はこの数で選択を止める。**
--   数を画面に書き写さない。書き写すと、枠を足したときに画面だけ古くなる。

create or replace function public.get_art_first_vocabulary()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'min_words', (select dm.word_count_min from public.draft_modes dm
                   where dm.word_source = 'author_pick' order by dm.sort_order limit 1),
    'max_words', (select dm.word_count_max from public.draft_modes dm
                   where dm.word_source = 'author_pick' order by dm.sort_order limit 1),
    'categories', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'category_key', dc.category_key,
                 'kind',         dc.kind,
                 'label',        dc.label,
                 -- その分類に入れられる数。**2つの上限のうち小さいほう。**
                 --   ・格納できる枠の数（`<分類>_<番号>` の形の枠だけ数える。
                 --     color には旧方式の main_color / sub_color も在るため）
                 --   ・1つのお題に入れてよい数（draw_categories.max_per_prompt）
                 -- カラーは枠が3つあるが max_per_prompt が1なので1になる。
                 'capacity',     least(
                                   (select count(*)::int from public.card_slots cs
                                     where cs.pool_key = dc.pool_key
                                       and cs.card_slot_key
                                           ~ ('^' || dc.pool_key || '_[0-9]+$')),
                                   dc.max_per_prompt),
                 'tags', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'id',      t.id,
                              'label',   t.label,
                              'reading', t.reading)
                            order by coalesce(t.reading, t.label), t.label)
                     from public.tags t
                    where t.pool_key = dc.pool_key
                      and t.is_active
                 ), '[]'::jsonb)
               )
               order by case dc.kind
                          when 'morph' then 1
                          when 'state' then 2
                          when 'color' then 3
                          else 4
                        end,
                        dc.sort_order)
        from public.draw_categories dc
       where dc.is_active
    ), '[]'::jsonb)
  );
$fn$;

comment on function public.get_art_first_vocabulary() is
  '持ち込みの投稿で選べる語の一覧。分類・上位種別・その分類に入れられる数を返す。'
  '語そのものは tags から既に読めるものと同じ。正解も お題も返さない。';

revoke all on function public.get_art_first_vocabulary()
  from public, anon, authenticated;
grant execute on function public.get_art_first_vocabulary() to authenticated;


-- ----------------------------------------------------------------------------
-- 6. 持ち込みの投稿（お題と作品を1回で作る）
-- ----------------------------------------------------------------------------
--
-- 【なぜ1回で終えるか】
--   出所: ユーザー確定4。お題だけ先に作る2段階にすると、途中でやめた人の
--   ところに status = 'active' のお題が残る。全ページ共通の帯
--   （get_active_challenge）はそれを「制作中」として拾い続け、
--   持ち主のいるお題を消す掃除は1つも無い（cleanup_orphan_prompts は
--   created_by が null の行だけを消す）。
--
--   1つの関数＝1つのトランザクションなので、途中で失敗すれば
--   お題も答えのカードも残らない。
--
-- 【検査を二重に書かない】
--   投稿そのものの検査（登録済みか・画像の置き場所・部門とファンアート項目）は
--   create_work（D27 の6検査）が持っている。**ここでは書き写さない。**
--   この関数が見るのは、作者が選んだ語についてだけ。

create or replace function public.create_art_first_work(
  p_work_id             uuid,
  p_tag_ids             bigint[],
  p_title               text,
  p_image_path          text,
  p_image_width         int,
  p_image_height        int,
  p_division            text,
  p_source_title        text    default null,
  p_source_character    text    default null,
  p_fanart_note         text    default null,
  p_actual_time_seconds int     default null,
  p_is_published        boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_anon      boolean;
  v_mode      record;
  v_count     int;
  v_valid     int;
  v_over      record;
  v_prompt_id uuid;
  v_questions int;
  v_work      jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- ゲストは投稿できない（D27-1）。create_work も同じことを見るが、
  -- ここで先に断るのは、断る理由が「語」ではないことを分けて伝えるため。
  v_anon := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_anon then
    raise exception
      'GUEST_CANNOT_POST: 作品の投稿にはアカウント登録が必要です。';
  end if;

  select dm.mode_key, dm.word_count_min, dm.word_count_max
    into v_mode
    from public.draft_modes dm
   where dm.word_source = 'author_pick'
   order by dm.sort_order
   limit 1;

  if not found then
    raise exception
      'ART_FIRST_MODE_MISSING: 持ち込みのモードが登録されていません。';
  end if;

  -- --- 語の数 ---------------------------------------------------------------
  v_count := coalesce(array_length(p_tag_ids, 1), 0);

  if v_count < v_mode.word_count_min or v_count > v_mode.word_count_max then
    raise exception
      'BAD_ELEMENT_COUNT: 項目は%〜%件で選んでください（いま%件）。',
      v_mode.word_count_min, v_mode.word_count_max, v_count;
  end if;

  if v_count <> (select count(distinct x.id) from unnest(p_tag_ids) as x(id)) then
    raise exception 'DUPLICATE_ELEMENT: 同じ語を2回選ぶことはできません。';
  end if;

  -- --- いま生成に使われている語であること ------------------------------------
  --
  -- 旧語彙（2026-09-04 の分類より前からある語。生成用カテゴリを持たない）は
  -- 選べない。出所: ユーザー確定6「旧語彙141件は今回無理に対応しない」。
  select count(*) into v_valid
    from public.tags t
    join public.draw_categories dc on dc.pool_key = t.pool_key and dc.is_active
   where t.id = any(p_tag_ids)
     and t.is_active;

  if v_valid <> v_count then
    raise exception
      'ELEMENT_NOT_FOUND: 選べない語が混ざっています。'
      'いま使える語から選び直してください。';
  end if;

  -- --- 分類ごとの枠の数を超えないこと ----------------------------------------
  --
  -- 上限は2つあり、**小さいほうを採る。ここに数を書かない。**
  --
  --   (1) 格納できる枠の数。`<分類>_<番号>` の形の枠だけ数える
  --       （旧方式の main_color / sub_color は名前の形が違うので入らない）
  --   (2) 1つのお題に入れてよい数（draw_categories.max_per_prompt）
  --
  -- 【なぜ (2) が要るか（実測で分かった）】
  --   カラーは枠が color_1〜color_3 の3つある（実測。調査の時点では
  --   color_1 の1枠だと書いていたが、数え落としだった）。
  --   枠の数だけで見ると色を3語選べてしまう。抽選側は max_per_prompt = 1 で
  --   1語に固定しているので、**持ち込みだけ3語入る形になる。**
  --   出所: ユーザー確定2「初期実装では色は最大1件とする」。
  select x.pool_key, x.picked, x.capacity
    into v_over
    from (
      select t.pool_key,
             count(*)::int as picked,
             least(
               (select count(*)::int from public.card_slots cs
                 where cs.pool_key = t.pool_key
                   and cs.card_slot_key ~ ('^' || t.pool_key || '_[0-9]+$')),
               (select dc.max_per_prompt from public.draw_categories dc
                 where dc.pool_key = t.pool_key and dc.is_active)
             ) as capacity
        from public.tags t
       where t.id = any(p_tag_ids)
       group by t.pool_key
    ) x
   where x.picked > x.capacity
   order by x.pool_key
   limit 1;

  if found then
    raise exception
      'CATEGORY_OVER_CAPACITY: 分類「%」に入れられるのは%件までです（いま%件）。',
      coalesce((select tp.label from public.tag_pools tp
                 where tp.pool_key = v_over.pool_key), v_over.pool_key),
      v_over.capacity, v_over.picked;
  end if;

  -- --- お題に相当する行を作る -------------------------------------------------
  --
  -- draft_session_id は null（ドラフトを通っていない。列は null 可）。
  -- time_limit_seconds も null。**制作時間を持たない経路**なので、
  -- 期限のトリガーは素通りし、投稿の猶予検査も素通りする。
  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status, origin)
  values
    (null, v_uid, v_mode.mode_key, null,
     false, 0, 'active', 'art_first')
  returning id into v_prompt_id;

  -- --- 選んだ語を、分類ごとの枠へ入れる ---------------------------------------
  --
  -- 枠の名前は「分類 ＋ その お題の中での何個目か」。同じ分類の2語目は _2 へ入る。
  -- 並び順（slot_order）は作者が選んだ順。
  insert into public.prompt_cards (prompt_id, card_slot_key, slot_order, tag_id)
  select v_prompt_id,
         t.pool_key || '_' ||
           (row_number() over (partition by t.pool_key order by x.ord))::text,
         x.ord::int,
         t.id
    from unnest(p_tag_ids) with ordinality as x(tag_id, ord)
    join public.tags t on t.id = x.tag_id;

  -- --- 出題を作る。**お題から描く経路と同じ関数**（D165 の全語出題）----------
  v_questions := public.build_quiz_for_prompt(v_prompt_id);

  -- --- 作品を作る。**D27 の6検査はここが持っている**--------------------------
  v_work := public.create_work(
    p_work_id, v_prompt_id, p_title, p_image_path,
    p_image_width, p_image_height, p_division,
    p_source_title, p_source_character, p_fanart_note,
    p_actual_time_seconds, p_is_published);

  -- 返り値に prompt_id を含めない（D23）。create_work の返り値も含んでいない。
  return v_work || jsonb_build_object('question_count', v_questions);
end;
$fn$;

comment on function public.create_art_first_work(uuid, bigint[], text, text, int, int,
                                                 text, text, text, text, int, boolean) is
  '持ち込みの投稿。作者が選んだ語からお題相当の行と答えのカードを作り、'
  '既存の build_quiz_for_prompt と create_work をそのまま呼ぶ。'
  '1つのトランザクションなので、途中で失敗すればお題も残らない。';

revoke all on function public.create_art_first_work(uuid, bigint[], text, text, int, int,
                                                    text, text, text, text, int, boolean)
  from public, anon, authenticated;
grant execute on function public.create_art_first_work(uuid, bigint[], text, text, int, int,
                                                       text, text, text, text, int, boolean)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 7. 取得系3本に origin を足す
-- ----------------------------------------------------------------------------
--
-- 【なぜ要るか】
--   出所: ユーザー確定7「art_first 作品では『かかった時間 0秒』等を表示しない。
--   必要なら表示条件を origin で分岐する」。
--
--   持ち込みのお題は制限時間を持たない（null）。いまの画面はそれを
--   「無制限」と読んで、お題の制作時間として出す。持ち込みでは
--   測っていない値なので、**画面が出す・出さないを決められるように、
--   出どころを渡す。**
--
-- 【返すだけで、表示はしない】
--   持ち込みであることを一覧や作品ページに明示するかどうかは未確定
--   （ユーザー確定の L に残っている）。ここで渡すのは時間の表示を
--   分けるためだけで、画面に origin そのものを出さない。
--
-- 【本体は書き写しているだけ】
--   3本とも既存の定義に 'origin' の1行を足しただけ。ほかの列・条件・
--   並び順は1つも変えていない。

create or replace function public.get_my_prompt(p_prompt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
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
$$;

comment on function public.get_my_prompt(uuid) is
  'お題1件。prompt_cards を外へ出す唯一の経路。作成者本人にのみ返す。'
  '未選択カードは candidates_revealed_at が入っているときだけ返す。'
  'origin は画面が時間の表示を分けるために使う（art_first は時間を持たない）。';


create or replace function public.get_work_detail(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'origin',              p.origin,
    'was_rerolled',        p.was_rerolled,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'author', jsonb_build_object(
      'id',           pr.id,
      'handle',       pr.handle,
      'display_name', pr.display_name,
      'bio',          pr.bio,
      'links',        pr.links
    ),
    'is_author',   (select auth.uid()) = w.user_id,
    'liked_by_me', exists (
      select 1 from public.likes l
       where l.work_id = w.id and l.user_id = (select auth.uid())
    ),
    'saved_by_me', exists (
      select 1 from public.saves s
       where s.work_id = w.id and s.user_id = (select auth.uid())
    ),
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects,
                 'exact_attempts',  st.exact_attempts,
                 'exact_corrects',  st.exact_corrects,
                 'pair_attempts',   st.pair_attempts,
                 'pair_corrects',   st.pair_corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_detail(uuid) is
  '公開作品1件の詳細。prompt_id は返さない。非公開・削除済みには null を返す。'
  '枠別の伝達率はビタ当てと2択当てを分けて返す（D165 の 11-2）。'
  'origin は時間の表示を分けるために返す（art_first は制作時間を持たない）。';


create or replace function public.get_my_work(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'origin',              p.origin,
    'is_published',        w.is_published,
    'review_status',       w.review_status,
    'deleted_at',          w.deleted_at,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'can_edit_actual_time', (w.is_published = false),
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects,
                 'exact_attempts',  st.exact_attempts,
                 'exact_corrects',  st.exact_corrects,
                 'pair_attempts',   st.pair_attempts,
                 'pair_corrects',   st.pair_corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.user_id = (select auth.uid());
$$;

comment on function public.get_my_work(uuid) is
  '自分の作品1件。他人のIDには null を返す（存在の有無を漏らさない）。'
  '枠別はビタ当てと2択当てを分けて返す（D165 の 11-2）。'
  'origin は時間の表示を分けるために返す（art_first は制作時間を持たない）。';


-- ----------------------------------------------------------------------------
-- 8. 時間別ランキングから持ち込みを外す
-- ----------------------------------------------------------------------------
--
-- 出所: ユーザー確定8「art_first 作品を既存の『無制限』制作時間ランキングへ
-- 入れない。制作時間という測定値を持っていないため」。
--
-- 【2つ直している】
--   (1) time_limit_bucket を null にする。持ち込みは時間の枠を持たないので、
--       「無制限」という枠に入れると、測っていない値を書いたことになる。
--   (2) p_type = 'duration' の絞り込みから外す。
--       **null にするだけでは外れない。**p_time_limit が null のときは
--       「区分で絞らない」ので、全部が残る。明示的に外す。
--
-- 【人気と伝達率は分けない】
--   出所: 同上「人気等、制作時間を前提としない既存集計については
--   今回勝手に分離しない」。popular と accuracy の並びは1文字も変えていない。

create or replace function public.get_rankings(
  p_type       text default 'popular',
  p_feed       text default 'normal',
  p_time_limit text default null,
  p_limit      int  default 20,
  p_offset     int  default 0
)
returns table (
  rank                int,
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_bucket   text,
  likes_count         int,
  ranking_likes_count int,
  saves_count         int,
  answers_count       int,
  accuracy            numeric,
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
  with base as (
    select
      w.id,
      w.title,
      w.image_path,
      w.image_width,
      w.image_height,
      w.division,
      w.source_title,
      w.source_character,
      w.fanart_note,
      w.actual_time_seconds,
      -- 持ち込みは制作時間を持たない。**「無制限」に入れない**
      case
        when p.origin = 'art_first'       then null
        when p.time_limit_seconds is null then 'unlimited'
        when p.time_limit_seconds <= 900  then 'short'
        when p.time_limit_seconds <= 3599 then 'medium'
        else 'long'
      end as time_limit_bucket,
      p.origin as origin,
      w.likes_count,
      (select count(*)
         from public.likes l
        where l.work_id = w.id
          and l.user_id <> w.user_id)::int as ranking_likes_count,
      w.saves_count,
      w.answers_count,
      -- 伝達率。回答が5人に満たない作品は出さない（R6）。
      -- **ビタ当てだけで出す。**2択当ての的中を同じ重みで混ぜない（D165 の 11-2）。
      case when w.answers_count >= 5 then (
        select sum(st.exact_corrects)::numeric / nullif(sum(st.exact_attempts), 0)
          from public.work_slot_stats st
         where st.work_id = w.id
      ) end as accuracy,
      w.created_at,
      pr.id           as author_id,
      pr.handle       as author_handle,
      pr.display_name as author_display_name
    from public.works w
      join public.prompts  p  on p.id  = w.prompt_id
      join public.profiles pr on pr.id = w.user_id
    where w.is_published
      and w.review_status = 'ok'
      and w.deleted_at is null
      and case
            when p_feed = 'ai' then w.division =  'ai'
            else                    w.division <> 'ai'
          end
  )
  select
    (row_number() over (
       order by
         case when p_type = 'accuracy' then b.accuracy      end desc nulls last,
         case when p_type = 'accuracy' then b.answers_count end desc nulls last,
         b.ranking_likes_count desc,
         b.created_at          desc,
         b.id                  desc
     ))::int,
    b.id,
    b.title,
    b.image_path,
    b.image_width,
    b.image_height,
    b.division,
    b.source_title,
    b.source_character,
    b.fanart_note,
    b.actual_time_seconds,
    b.time_limit_bucket,
    b.likes_count,
    b.ranking_likes_count,
    b.saves_count,
    b.answers_count,
    b.accuracy,
    b.created_at,
    b.author_id,
    b.author_handle,
    b.author_display_name
  from base b
  where case
          when p_type = 'accuracy' then b.accuracy is not null
          when p_type = 'duration' then
            b.origin <> 'art_first'
            and (p_time_limit is null or b.time_limit_bucket = p_time_limit)
          else true
        end
  order by 1
  limit  least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_rankings(text, text, text, int, int) is
  'ランキング。p_type: popular/accuracy/duration、p_feed: normal/ai。'
  '順位には作者本人のいいねを除いた ranking_likes_count を使う。'
  '伝達率は answers_count>=5 かつビタ当てだけ（D165 の 11-2）。'
  '持ち込み（art_first）は時間の区分を持たず、時間別からは外れる。';


-- ----------------------------------------------------------------------------
-- 9. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_origin_ok   boolean;
  v_mode        record;
  v_existing    int;
  v_funcs       int;
begin
  -- 許可値に art_first が入ったか。既存の値も残っているか
  select count(*) = 4 into v_origin_ok
    from (values ('draft'), ('saved'), ('daily'), ('art_first')) as v(x)
   where exists (
     select 1 from pg_constraint
      where conrelid = 'public.prompts'::regclass
        and conname  = 'prompts_origin_check'
        and pg_get_constraintdef(oid) like '%''' || v.x || '''%'
   );

  if not v_origin_ok then
    raise exception 'ORIGIN_CHECK_WRONG: origin の許可値が4つそろっていません。';
  end if;

  -- モード行
  select dm.mode_key, dm.is_active, dm.uses_two_stage, dm.word_source,
         dm.word_count_min, dm.word_count_max, dm.morph_max
    into v_mode
    from public.draft_modes dm where dm.mode_key = 'art_first';

  if not found then
    raise exception 'ART_FIRST_MODE_MISSING: モード行が入っていません。';
  end if;

  if v_mode.is_active or v_mode.uses_two_stage
     or v_mode.word_source <> 'author_pick'
     or v_mode.word_count_min <> 3 or v_mode.word_count_max <> 6
     or v_mode.morph_max is not null then
    raise exception
      'ART_FIRST_MODE_WRONG: モード行の値が意図と違います（%/%/%/%〜%）。',
      v_mode.is_active, v_mode.uses_two_stage, v_mode.word_source,
      v_mode.word_count_min, v_mode.word_count_max;
  end if;

  -- 既存4モードの word_source が実態どおりに埋まったか
  select count(*) into v_existing
    from public.draft_modes dm
   where (dm.mode_key in ('easy', 'standard') and dm.word_source = 'fixed_slots')
      or (dm.mode_key in ('normal', 'hard')   and dm.word_source = 'two_stage_draw');

  if v_existing <> 4 then
    raise exception
      'WORD_SOURCE_BACKFILL: 既存4モードのうち % 件しか埋まっていません。', v_existing;
  end if;

  -- 追加した関数が2本とも在るか
  select count(*) into v_funcs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_art_first_vocabulary', 'create_art_first_work');

  if v_funcs <> 2 then
    raise exception 'ART_FIRST_FUNCS: 関数が2本そろっていません（%本）。', v_funcs;
  end if;

  raise notice 'art_first 完了: 出どころの値・モード行・関数2本・枠の連番を確かめました';
end $$;


-- ============================================================================
-- rollback（手で流す用。migration としては実行しない）
-- ============================================================================
--
--   -- 1. 関数を2本消す
--   drop function if exists public.create_art_first_work(uuid, bigint[], text, text,
--                                                        int, int, text, text, text,
--                                                        text, int, boolean);
--   drop function if exists public.get_art_first_vocabulary();
--
--   -- 2. モード行を消す（この経路で作ったお題が1件でもあると消せない）
--   delete from public.draft_modes where mode_key = 'art_first';
--
--   -- 3. 語の出どころの列と整合条件を戻す
--   alter table public.draft_modes drop constraint if exists draft_modes_word_source_fields;
--   alter table public.draft_modes
--     add constraint draft_modes_two_stage_fields check (
--       (uses_two_stage = false
--         and word_count_min is null and word_count_max is null and morph_max is null)
--       or
--       (uses_two_stage = true
--         and word_count_min is not null and word_count_max is not null
--         and morph_max is not null
--         and word_count_min between 1 and 10
--         and word_count_max between word_count_min and 10
--         and morph_max between 1 and 3));
--   alter table public.draft_modes drop column if exists word_source;
--
--   -- 4. 出どころの許可値を3つに戻す
--   --    **持ち込みで作ったお題が1件でもあると戻せない。**先に扱いを決めること
--   alter table public.prompts drop constraint if exists prompts_origin_check;
--   alter table public.prompts add constraint prompts_origin_check
--     check (origin in ('draft', 'saved', 'daily'));
--
--   -- 5. 取得系4本は 20260905097000 と baseline の定義へ戻す
--      （origin の行を消すだけ。ほかは1文字も変えていない）
-- ============================================================================
