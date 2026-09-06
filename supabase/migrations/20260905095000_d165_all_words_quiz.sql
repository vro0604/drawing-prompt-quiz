-- ============================================================================
-- D165 ／ お題の全語を出題する・ビタ当てと2択当て・カラーをカテゴリへ戻す
-- ============================================================================
--
-- 出所: docs/decisions.md の D165（2026-09-05 確定）。
--
-- 【1. お題の全語を出題する】
--   旧「3〜6語のお題から3問だけ出す」をやめる。お題として確定した語は
--   すべてクイズ問題になる。3語なら3問、6語なら6問。
--   したがって「何問出すか」を持つ列は要らなくなる。
--     draft_modes.quiz_question_count    → 使わない（互換期間だけ列を残す）
--     draft_sessions.quiz_question_count → 使わない（互換期間だけ列を残す）
--
--     2026-09-06 訂正。当初はこの2列を落とす内容だった。
--     本番は「DBを先に更新し、画面を後から差し替える」順で当てるため、
--     その間だけ旧い画面がこの列を読む。落とすとモード選択画面が落ちる。
--     **今回の本番初回適用では落とさない。**削除は新コードの本番稼働を
--     確かめた後の別 migration にする。
--     build_quiz_for_prompt(uuid, int)   → 問数の引数を落とす
--
-- 【2. 回答方式を2つ並立させる】
--   ビタ当て（exact）… 4択から1語を選ぶ。その語が正解なら的中
--   2択当て（pair） … 4択から2語を選ぶ。どちらかが正解なら的中
--   どちらも「正解へ到達した」だが、**同じ種類の正答ではない。**
--   保存も集計も必ず分ける（D165 の 4 と 11-2）。
--
-- 【3. カラーをカテゴリへ戻す】
--   カラーは**独立した上位種別**として抽選対象へ戻る（D165 の 11-1）。
--   状態カテゴリの9番目ではない。状態カテゴリは感情・動作・身体状態・変化・
--   環境・関係・性質・社会状態の**8つのまま**で、カラーはその外側に立つ。
--
--   出所: ユーザー発言「カラーは状態ではありません。状態カテゴリは8つのまま
--   維持してください」（2026-09-05）。D165 の 11-1 が「状態カテゴリの9番目」と
--   書いていたのは、D158 の「モーフ以外の語はすべて状態」という定義から
--   Claude が導出したもので、ユーザーの言葉ではなかった。
--
--   1つのお題に最大1語（11-3）。draw_categories.max_per_prompt = 1 で表し、
--   さらに抽選側でも「重複させる対象は kind = 'state' だけ」と条件で書く。
--   状態カテゴリの重複確率（state_category_repeat_ratio）はカラーに当たらない。
--   **持ち出しでカラーが複数入ることはありうる**ので、枠は3つ用意する。
--
-- 【4. 選択肢が4つ作れないとき】
--   出題は見送らず3択にする（D165 の 11-4）。2択以下になる語数までは
--   落ちない見込みだが、落ちたときは QUIZ_CHOICES_INSUFFICIENT で止める。
--
-- 【5. 旧回答との識別】
--   answers.scoring_version で分ける。
--     v1_fixed_count … この migration より前の回答（固定問数・ビタ当てのみ）
--     v2_all_words   … これ以降の回答（全語出題・2方式）
--   正答率の分母は answers.question_count（実際に出題された数）。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. カラーをお題生成用カテゴリに入れる（D165 の 11-1 / 11-3）
-- ----------------------------------------------------------------------------
--
-- kind は 'color'。**'state' にしない。**
-- 'state' にすると「状態カテゴリの一覧」を引く問い合わせにカラーが混ざり、
-- 状態が9つに見える。状態は8つ、カラーはその外側の独立した種別。

insert into public.draw_categories
  (category_key, kind, label, pool_key, max_per_prompt, sort_order) values
  ('color', 'color', 'カラー', 'color', 1, 10)
on conflict (category_key) do update
  set kind           = excluded.kind,
      label          = excluded.label,
      pool_key       = excluded.pool_key,
      max_per_prompt = excluded.max_per_prompt,
      sort_order     = excluded.sort_order,
      is_active      = true;

comment on column public.draw_categories.max_per_prompt is
  '1つのお題の中でこのカテゴリが最大何回出られるか。'
  'カラーは1（D165 の 11-3）。通常抽選では1語まで。'
  '持ち出しで持ち込んだカラーはこの上限の外側なので、枠は3つある。'
  'state_category_repeat_ratio は kind = ''state'' にだけ当たる。';

-- カラーの出題順を、モーフのすぐ後ろに入れる。
-- quiz_priority の一意制約は deferrable なので、まとめてずらせる。
update public.card_slots
   set quiz_priority = quiz_priority + 3
 where quiz_priority between 24 and 47;

insert into public.card_slots
  (card_slot_key, label, pool_key, quiz_priority, is_quiz_eligible) values
  ('color_1', 'カラー', 'color', 24, true),
  ('color_2', 'カラー', 'color', 25, true),
  ('color_3', 'カラー', 'color', 26, true)
on conflict (card_slot_key) do update
  set label            = excluded.label,
      pool_key         = excluded.pool_key,
      quiz_priority    = excluded.quiz_priority,
      is_quiz_eligible = excluded.is_quiz_eligible;


-- ----------------------------------------------------------------------------
-- 2. 出題を作る（お題の全語 ／ 4択、足りなければ3択）
-- ----------------------------------------------------------------------------
--
-- 【旧版との違い】
--   ・問数の引数を受け取らない。お題のカードの数がそのまま問数になる
--   ・誤答を「プールごとにまとめて配る」方式から、問ごとに引く方式へ変えた。
--     まとめて配る方式は「1つのプールを k 問が使うなら 4k 件必要」を
--     前提にしていて、**3択へ落とす道が作れない。**
--   ・1つのお題の中で、選択肢のタグは重複しない（正解も誤答も）

drop function if exists public.build_quiz_for_prompt(uuid, int);

create or replace function public.build_quiz_for_prompt(p_prompt_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_card     record;
  v_qid      bigint;
  v_pos      int := 0;
  v_used     bigint[];
  v_groups   text[];
  v_dist     bigint[];
  v_have     int;
  v_bad      int;
  v_distinct int;
  v_choices  int;
begin
  -- 作り直せるようにしておく（引き直しや試験の準備で2回呼ばれても壊れない）
  delete from public.quiz_questions qq where qq.prompt_id = p_prompt_id;

  -- そのお題で使われている語と同義グループ。**誤答から外す集合**
  select coalesce(array_agg(pc.tag_id), '{}'::bigint[])
    into v_used
    from public.prompt_cards pc
   where pc.prompt_id = p_prompt_id;

  if coalesce(array_length(v_used, 1), 0) = 0 then
    raise exception 'NO_CARDS: そのお題にカードが1枚もありません。';
  end if;

  select coalesce(array_agg(distinct t.synonym_group), '{}'::text[])
    into v_groups
    from public.prompt_cards pc
    join public.tags t on t.id = pc.tag_id
   where pc.prompt_id = p_prompt_id
     and t.synonym_group is not null;

  -- --- お題のカードを1枚ずつ問にする ---------------------------------------
  for v_card in
    select pc.card_slot_key, pc.tag_id, pc.slot_order, cs.pool_key
      from public.prompt_cards pc
      join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
     where pc.prompt_id = p_prompt_id
       and cs.is_quiz_eligible
     order by cs.quiz_priority, pc.slot_order
  loop
    insert into public.quiz_questions (prompt_id, card_slot_key, position)
    values (p_prompt_id, v_card.card_slot_key, v_pos)
    returning id into v_qid;

    v_pos := v_pos + 1;

    -- 誤答を最大3件。**正解と同じ同義グループの語は選ばない**（D96 / D165 の 2）
    select coalesce(array_agg(x.id), '{}'::bigint[])
      into v_dist
      from (
        select t.id
          from public.tags t
         where t.is_active
           and t.pool_key = v_card.pool_key
           and not (t.id = any(v_used))
           and (t.synonym_group is null or not (t.synonym_group = any(v_groups)))
         order by random()
         limit 3
      ) x;

    v_have := coalesce(array_length(v_dist, 1), 0);

    -- 4択が基本。作れないときは3択へ落とす（D165 の 11-4）。
    -- 2択以下になるなら出題そのものが成立しないので止める。
    if v_have < 2 then
      raise exception
        'QUIZ_CHOICES_INSUFFICIENT: 分類「%」で誤答が%件しか作れません（最低2件）。'
        '語彙が足りないか、そのお題が同じ分類を使いすぎています。',
        v_card.pool_key, v_have;
    end if;

    insert into public.quiz_choices (question_id, tag_id, position, is_correct)
    select v_qid,
           y.tag_id,
           (row_number() over (order by random()))::int - 1,
           y.is_correct
      from (
        select v_card.tag_id as tag_id, true as is_correct
        union all
        select unnest(v_dist), false
      ) y;

    -- 次の問へ渡す。1つのお題の中で選択肢のタグを重複させない
    v_used := v_used || v_dist;
  end loop;

  if v_pos = 0 then
    raise exception 'NO_QUESTIONS: 出題できる枠が1つもありません。';
  end if;

  -- --- 数え直して検算する ---------------------------------------------------
  select count(*) into v_bad
    from public.quiz_questions qq
   where qq.prompt_id = p_prompt_id
     and (
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id) not between 3 and 4
       or
       (select count(*) from public.quiz_choices qc
         where qc.question_id = qq.id and qc.is_correct) <> 1
     );

  if v_bad > 0 then
    raise exception 'QUIZ_BROKEN: 選択肢または正解の数が正しくない問が%件あります。', v_bad;
  end if;

  select count(*), count(distinct qc.tag_id)
    into v_choices, v_distinct
    from public.quiz_choices qc
    join public.quiz_questions qq on qq.id = qc.question_id
   where qq.prompt_id = p_prompt_id;

  if v_distinct <> v_choices then
    raise exception
      'QUIZ_CHOICES_DUPLICATE: 選択肢のタグが重複しています（%種類／%件）。',
      v_distinct, v_choices;
  end if;

  return v_pos;
end;
$fn$;

comment on function public.build_quiz_for_prompt(uuid) is
  'お題の全語を出題にする（D165 の 1）。4択が基本、作れなければ3択（11-4）。'
  '誤答に正解と同じ同義グループの語を入れない（D96）。返り値は問数。内部専用。';

revoke all on function public.build_quiz_for_prompt(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 固定問数の列を落とす（先に、参照している関数を作り直す）
-- ----------------------------------------------------------------------------
--
-- draft_state_json は language sql なので、列への依存が記録されている。
-- 先に作り直さないと、列を落とせない。

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
-- 3b. 「3問固定」の根拠だった2列は、今回は落とさない（互換期間だけ残す）
-- ----------------------------------------------------------------------------
--
-- 【何をしないか】
--   draft_sessions.quiz_question_count と draft_modes.quiz_question_count を
--   **落とさない。**値もそのまま残す。
--
-- 【なぜ残すか】
--   本番は「DBを先に更新し、そのあと画面を差し替える」順で当てる。
--   その間、旧い画面と新しいDBが同時に動く時間帯がある。
--   旧い画面はモード一覧でこの列を読んでいる
--   （実測: HEAD の src/features/draft/rpc.ts が
--    `select mode_key, label, candidate_count, max_rerolls, quiz_question_count,
--     sort_order` を draft_modes に対して直接投げている）。
--   列を落とすと、その時間帯のモード選択画面が丸ごと落ちる。
--
-- 【残すが、正規のデータとしては扱わない】
--   ・新しい実装は、この列を出題数の決定にも採点にも**1か所も使わない。**
--     出題数はお題として確定した語の数で決まる（D165）。
--   ・値は既存のまま保持する。新しく書き込むこともしない。
--   ・したがってこの列は「互換期間だけ残す旧列」である。
--
-- 【いつ落とすか】
--   新しい画面が本番で動くのを確かめた後の別 migration。
--   その削除 migration は、今回の適用束には入れない。

comment on column public.draft_modes.quiz_question_count is
  '【互換期間だけ残す旧列】D165 より前の「3問固定」の根拠。'
  '新しい実装はこの列を出題数の決定にも採点にも使わない。'
  '旧い画面がモード一覧で読むあいだだけ残す。新コードの本番稼働後に別 migration で削除する。';

-- 【1つだけ、列の性質を変える】
--   draft_sessions.quiz_question_count は not null で、既定値が無い。
--   新しい start_draft はこの列に値を入れないので、**このままだと投入が失敗する**
--   （実測: baseline の定義が `quiz_question_count int not null`、既定値なし）。
--
--   ここで not null を外す。以後この列は
--     ・D165 より前に作られた行 … 当時の値をそのまま保持する
--     ・D165 以後に作られた行   … 値なし（NULL）＝「この方式では使っていない」
--   になる。**適当な数を書き込んで、使っているように見せない。**
--   既存行の値は1つも書き換えない（UPDATE を1本も書いていない）。
alter table public.draft_sessions alter column quiz_question_count drop not null;

comment on column public.draft_sessions.quiz_question_count is
  '【互換期間だけ残す旧列】D165 より前の「3問固定」の根拠。'
  '新しい実装はこの列を出題数の決定にも採点にも使わない。'
  '新しい画面の本番稼働後に別 migration で削除する。';

-- 読める列は変えない。**quiz_question_count を外さない。**
-- 外すと旧い画面のモード一覧が落ちる（上の理由）。
revoke all on table public.draft_modes from public, anon, authenticated;
grant select (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
              sort_order, uses_two_stage, word_count_min, word_count_max, morph_max)
  on public.draft_modes to anon, authenticated;





-- ----------------------------------------------------------------------------
-- 4. start_draft ／ 保存枠の中の要素を選んで持ち込む
-- ----------------------------------------------------------------------------
--
-- 【引数の意味が変わっていないこと】
--   p_carried_element_ids は**保存枠内要素の id**（saved_elements.id）。
--   1つの保存枠から一部だけ選べる。どれを選んだかは
--   draft_session_carried に枠IDと要素IDの両方で残る。

create or replace function public.start_draft(
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
    (user_id, mode_key, candidate_count, max_rerolls, time_limit_seconds)
  values
    (v_uid, v_mode.mode_key, v_mode.candidate_count, v_mode.max_rerolls,
     p_time_limit_seconds)
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
$fn$;

comment on function public.start_draft(text, int, bigint[]) is
  'ドラフトを始める。保存枠の中の要素を1〜3個持ち込める（D161 / 2026-09-05 の保存枠）。'
  '始めた瞬間が制作挑戦の開始時刻になる（D167）。出題数はお題の語数で決まる（D165）。';

revoke all on function public.start_draft(text, int, bigint[])
  from public, anon, authenticated;
grant execute on function public.start_draft(text, int, bigint[]) to authenticated;


-- ----------------------------------------------------------------------------
-- 5. complete_draft ／ 出題数はお題の語数、派生は枠と要素の両方に残す
-- ----------------------------------------------------------------------------

create or replace function public.complete_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_session        record;
  v_slot_count     int;
  v_chosen_count   int;
  v_prompt_id      uuid;
  v_inserted       int;
  v_carried        int;
  v_two_stage      boolean;
  v_question_count int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.reroll_count,
         ds.current_generation, ds.time_limit_seconds,
         ds.started_at, ds.deadline_at, ds.renew_count, ds.last_renewed_at
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

  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status, origin,
     started_at, deadline_at, renew_count, last_renewed_at)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active',
     case when v_carried > 0 then 'saved' else 'draft' end,
     v_session.started_at, v_session.deadline_at,
     v_session.renew_count, v_session.last_renewed_at)
  returning id into v_prompt_id;

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

  if v_carried > 0 then
    -- 派生お題へ実際に入った要素（要素単位の追跡）
    insert into public.prompt_element_origins
      (prompt_id, tag_id, source_prompt_id, source_work_id,
       carry_slot_id, saved_element_id, source_is_own)
    select v_prompt_id, c.tag_id, c.source_prompt_id, c.source_work_id,
           c.carry_slot_id, c.saved_element_id, c.source_is_own
      from public.draft_session_carried c
     where c.session_id = p_session_id
    on conflict (prompt_id, tag_id) do nothing;

    -- 保存枠を使用した派生お題（枠単位の追跡）。
    -- **枠の要素数と、そのうち使った数の両方を残す。**
    -- 1つの枠から一部だけ使ったことが、あとから分かるようにするため。
    insert into public.prompt_carry_slots
      (prompt_id, carry_slot_id, source_is_own, source_work_id, source_prompt_id,
       slot_size, used_count)
    select v_prompt_id,
           c.carry_slot_id,
           bool_and(c.source_is_own),
           (array_agg(c.source_work_id))[1],
           (array_agg(c.source_prompt_id))[1],
           coalesce((select count(*) from public.saved_elements se
                      where se.carry_slot_id = c.carry_slot_id), count(*)),
           count(*)
      from public.draft_session_carried c
     where c.session_id = p_session_id
       and c.carry_slot_id is not null
     group by c.carry_slot_id
    on conflict (prompt_id, carry_slot_id) do nothing;
  end if;

  -- **出題数はここで決まる。お題のカードの数がそのまま問数になる（D165）**
  v_question_count := public.build_quiz_for_prompt(v_prompt_id);

  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  -- 流れがここで終わる。セッション内の保存枠は保持を終える
  perform public.end_session_carry(v_uid);

  return jsonb_build_object(
    'prompt_id',      v_prompt_id,
    'mode_key',       v_session.mode_key,
    'card_count',     v_slot_count,
    'question_count', v_question_count
  );
end;
$fn$;

comment on function public.complete_draft(uuid) is
  'お題とクイズを確定する。出題はお題の全語（D165）。'
  '持ち出しは保存枠単位と要素単位の両方で派生を記録する。';

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 6. 回答の記録に「方式」を足す（ビタ当て／2択当て）
-- ----------------------------------------------------------------------------

alter table public.answer_items
  add column if not exists answer_mode text not null default 'exact';

alter table public.answer_items
  add column if not exists selected_tag_id_2 bigint
    references public.tags (id) on delete restrict on update restrict;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.answer_items'::regclass
                    and conname = 'answer_items_mode_valid') then
    alter table public.answer_items
      add constraint answer_items_mode_valid check (answer_mode in ('exact', 'pair'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.answer_items'::regclass
                    and conname = 'answer_items_pair_has_second') then
    -- 2択当てのときだけ2語目がある。ビタ当てに2語目は無い
    alter table public.answer_items
      add constraint answer_items_pair_has_second
      check ((answer_mode = 'pair') = (selected_tag_id_2 is not null));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.answer_items'::regclass
                    and conname = 'answer_items_two_are_different') then
    alter table public.answer_items
      add constraint answer_items_two_are_different
      check (selected_tag_id_2 is null or selected_tag_id_2 <> selected_tag_id);
  end if;
end $$;

comment on column public.answer_items.answer_mode is
  'exact＝ビタ当て（1語を断定）／pair＝2択当て（2語まで絞った）。D165 の 3。'
  '**同じ正答として潰さない。**集計でも必ず分ける（D165 の 4 / 11-2）。';
comment on column public.answer_items.selected_tag_id_2 is
  '2択当ての2語目。ビタ当てのときは null。';


alter table public.answers
  add column if not exists question_count int not null default 0;

alter table public.answers
  add column if not exists exact_attempts int not null default 0;
alter table public.answers
  add column if not exists exact_corrects int not null default 0;
alter table public.answers
  add column if not exists pair_attempts int not null default 0;
alter table public.answers
  add column if not exists pair_corrects int not null default 0;

-- **旧回答と新回答を明示的に見分ける。**
-- 列を足した時点の既存行は、すべて旧方式（固定問数・ビタ当てのみ）。
alter table public.answers
  add column if not exists scoring_version text not null default 'v1_fixed_count';

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.answers'::regclass
                    and conname = 'answers_scoring_version_valid') then
    alter table public.answers
      add constraint answers_scoring_version_valid
      check (scoring_version in ('v1_fixed_count', 'v2_all_words'));
  end if;
end $$;

-- 既存行の question_count を、実際の内訳の数から埋める
update public.answers a
   set question_count = x.n,
       exact_attempts = x.n,
       exact_corrects = a.correct_count
  from (select ai.answer_id, count(*) as n
          from public.answer_items ai group by ai.answer_id) x
 where x.answer_id = a.id
   and a.question_count = 0;

-- これ以降に入る回答は新方式
alter table public.answers alter column scoring_version set default 'v2_all_words';

comment on column public.answers.question_count is
  'その回答で実際に出題された問の数（D165）。正答率の分母はこれ。'
  '**3で割らない。**お題の語数によって3〜6問に変わる。';
comment on column public.answers.scoring_version is
  'v1_fixed_count＝2026-09-05 以前の回答（固定問数・ビタ当てのみ）。'
  'v2_all_words＝全語出題・2方式。**混ぜて平均を取らないための印。**';


-- ----------------------------------------------------------------------------
-- 7. 集計にも方式の別を持たせる
-- ----------------------------------------------------------------------------

alter table public.work_slot_stats
  add column if not exists exact_attempts int not null default 0;
alter table public.work_slot_stats
  add column if not exists exact_corrects int not null default 0;
alter table public.work_slot_stats
  add column if not exists pair_attempts int not null default 0;
alter table public.work_slot_stats
  add column if not exists pair_corrects int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.work_slot_stats'::regclass
                    and conname = 'work_slot_stats_exact_range') then
    alter table public.work_slot_stats
      add constraint work_slot_stats_exact_range
      check (exact_corrects between 0 and exact_attempts);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.work_slot_stats'::regclass
                    and conname = 'work_slot_stats_pair_range') then
    alter table public.work_slot_stats
      add constraint work_slot_stats_pair_range
      check (pair_corrects between 0 and pair_attempts);
  end if;
end $$;

-- 既存の集計はすべてビタ当て（2択当てはまだ存在しなかった）
update public.work_slot_stats
   set exact_attempts = attempts,
       exact_corrects = corrects
 where exact_attempts = 0 and attempts > 0;

comment on column public.work_slot_stats.attempts is
  '方式を問わない挑戦数（exact + pair）。方式別は exact_/pair_ の列にある。';


alter table public.user_stats
  add column if not exists exact_items int not null default 0;
alter table public.user_stats
  add column if not exists exact_correct_items int not null default 0;
alter table public.user_stats
  add column if not exists pair_items int not null default 0;
alter table public.user_stats
  add column if not exists pair_correct_items int not null default 0;

update public.user_stats
   set exact_items = total_items,
       exact_correct_items = total_correct_items
 where exact_items = 0 and total_items > 0;


create or replace function public.answer_items_after_insert_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
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
      (user_id, card_slot_key, attempts, corrects, updated_at)
    values (v_user_id, new.card_slot_key, 1, v_correct, now())
    on conflict (user_id, card_slot_key) do update
      set attempts   = uss.attempts + 1,
          corrects   = uss.corrects + v_correct,
          updated_at = now();
  end if;

  return null;
end;
$fn$;

comment on function public.answer_items_after_insert_stats() is
  '回答の内訳1件ぶんの集計。**ビタ当てと2択当てを別々の数として積む**（D165 の 11-2）。';

revoke all on function public.answer_items_after_insert_stats()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 8. 出題を返す（問数は可変。選択肢は3つか4つ）
-- ----------------------------------------------------------------------------
--
-- **is_correct には1文字も触れない。**ここは変えていない。
-- 足したのは「何問あるか」と「その問の選択肢が何個か」だけで、
-- どちらも正解の手がかりにならない。

create or replace function public.get_work_quiz(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'work_id',       w.id,
    'mode_key',      p.mode_key,
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    'is_author', (select auth.uid()) = w.user_id,
    'question_count', (
      select count(*) from public.quiz_questions q where q.prompt_id = w.prompt_id
    ),
    'questions', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',     q.id,
                 'position',        q.position,
                 'card_slot_key',   q.card_slot_key,
                 'card_slot_label', cs.label,
                 'choice_count', (
                   select count(*) from public.quiz_choices ch
                    where ch.question_id = q.id
                 ),
                 'choices', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'tag_id',   ch.tag_id,
                              'label',    tg.label,
                              'position', ch.position
                            )
                            order by ch.position
                          )
                     from public.quiz_choices ch
                     join public.tags tg on tg.id = ch.tag_id
                    where ch.question_id = q.id
                 ), '[]'::jsonb)
               )
               order by q.position
             )
        from public.quiz_questions q
        join public.card_slots cs on cs.card_slot_key = q.card_slot_key
       where q.prompt_id = w.prompt_id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$fn$;

comment on function public.get_work_quiz(uuid) is
  'クイズの問題と選択肢。お題の全語が出題される（D165）。'
  'is_correct を一切参照しない。正解は submit_answer が返す。';


-- ----------------------------------------------------------------------------
-- 9. submit_answer ／ ビタ当てと2択当てを受け取る
-- ----------------------------------------------------------------------------
--
-- 【引数の形】
--   [{"question_id": 12, "tag_id": 34},                  ← ビタ当て
--    {"question_id": 13, "tag_id": 40, "tag_id_2": 41}]  ← 2択当て
--
--   引数の型は変えていない（uuid, jsonb）。2語目は任意の項目として増えただけ。
--
-- 【的中の条件】
--   ビタ当て … 選んだ1語が正解と一致
--   2択当て  … 選んだ2語のどちらかが正解
--   どちらも is_correct = true になるが、**answer_mode で区別して残す。**

create or replace function public.submit_answer(
  p_work_id    uuid,
  p_selections jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid            uuid := (select auth.uid());
  v_work           record;
  v_question_count int;
  v_sel_count      int;
  v_distinct_count int;
  v_valid_count    int;
  v_correct_count  int;
  v_exact_att      int;
  v_exact_cor      int;
  v_pair_att       int;
  v_pair_cor       int;
  v_answer_id      bigint;
  v_hint_used      boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select w.id, w.user_id, w.prompt_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  if v_work.user_id = v_uid then
    raise exception
      'AUTHOR_CANNOT_ANSWER: 自分の作品には回答できません。'
      '答えを知っているため、正答率が実際より高く出てしまいます。';
  end if;

  if exists (
    select 1 from public.answers a
     where a.work_id = p_work_id and a.user_id = v_uid
  ) then
    raise exception
      'ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。';
  end if;

  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'BAD_SELECTIONS: 回答の形式が正しくありません。';
  end if;

  -- **問数はお題の語数で決まる。3で固定しない**（D165）
  select count(*) into v_question_count
    from public.quiz_questions q
   where q.prompt_id = v_work.prompt_id;

  select count(*), count(distinct (x ->> 'question_id'))
    into v_sel_count, v_distinct_count
    from jsonb_array_elements(p_selections) x;

  if v_sel_count <> v_question_count then
    raise exception 'INCOMPLETE_ANSWER: %問すべてに答えてください（いま %問）。',
      v_question_count, v_sel_count;
  end if;

  if v_distinct_count <> v_sel_count then
    raise exception 'DUPLICATE_QUESTION: 同じ問に2回答えることはできません。';
  end if;

  -- --- 選んだ語が、その問の選択肢の中にあるか -------------------------------
  --
  -- 2語目まで同じ関門を通す。**2語目だけ素通りさせない。**
  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  )
  select count(*)
    into v_valid_count
    from sel s
    join public.quiz_questions q
      on q.id = s.qid and q.prompt_id = v_work.prompt_id
   where exists (select 1 from public.quiz_choices c
                  where c.question_id = q.id and c.tag_id = s.t1)
     and (
       s.t2 is null
       or (s.t2 <> s.t1
           and exists (select 1 from public.quiz_choices c
                        where c.question_id = q.id and c.tag_id = s.t2))
     );

  if v_valid_count <> v_sel_count then
    raise exception
      'BAD_SELECTION: 選択肢にない答えが含まれています。'
      '2択当てで同じ語を2回選ぶこともできません。画面を開き直してください。';
  end if;

  -- --- 採点（方式ごとに数える）---------------------------------------------
  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  ),
  scored as (
    select s.qid,
           (s.t2 is not null) as is_pair,
           exists (select 1 from public.quiz_choices c
                    where c.question_id = s.qid
                      and c.is_correct
                      and (c.tag_id = s.t1 or c.tag_id = s.t2)) as ok
      from sel s
  )
  select count(*) filter (where ok),
         count(*) filter (where not is_pair),
         count(*) filter (where not is_pair and ok),
         count(*) filter (where is_pair),
         count(*) filter (where is_pair and ok)
    into v_correct_count, v_exact_att, v_exact_cor, v_pair_att, v_pair_cor
    from scored;

  -- ヒント使用は画面からの申告ではなく記録を見る（D162）
  select exists (
    select 1 from public.flavor_hint_views h
     where h.work_id = p_work_id and h.user_id = v_uid
  ) into v_hint_used;

  begin
    insert into public.answers
      (work_id, user_id, correct_count, hint_used, question_count,
       exact_attempts, exact_corrects, pair_attempts, pair_corrects, scoring_version)
    values
      (p_work_id, v_uid, v_correct_count, v_hint_used, v_question_count,
       v_exact_att, v_exact_cor, v_pair_att, v_pair_cor, 'v2_all_words')
    returning id into v_answer_id;
  exception when unique_violation then
    raise exception
      'ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。';
  end;

  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  )
  insert into public.answer_items
    (answer_id, question_id, card_slot_key, selected_tag_id, selected_tag_id_2,
     answer_mode, is_correct)
  select v_answer_id,
         q.id,
         q.card_slot_key,
         s.t1,
         s.t2,
         case when s.t2 is null then 'exact' else 'pair' end,
         exists (select 1 from public.quiz_choices c
                  where c.question_id = q.id
                    and c.is_correct
                    and (c.tag_id = s.t1 or c.tag_id = s.t2))
    from sel s
    join public.quiz_questions q
      on q.id = s.qid and q.prompt_id = v_work.prompt_id;

  return public.get_my_answer(p_work_id);
end;
$fn$;

comment on function public.submit_answer(uuid, jsonb) is
  'クイズを採点して保存する。ビタ当て（1語）と2択当て（2語）を受け取り、'
  '方式を区別して保存・集計する（D165）。問数はお題の語数（3〜6）。';

revoke all on function public.submit_answer(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.submit_answer(uuid, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 10. 自分の回答を返す（方式と2語目を含める）
-- ----------------------------------------------------------------------------

create or replace function public.get_my_answer(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
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
$fn$;

comment on function public.get_my_answer(uuid) is
  '自分の回答1件。方式（ビタ当て／2択当て）と2語目、実際の問数を含む（D165）。'
  '回答済みの作品にだけ正解タグを返す。未回答なら null。';


-- ----------------------------------------------------------------------------
-- 11. 作者へ返す結果（可変問数・方式別）
-- ----------------------------------------------------------------------------

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
$fn$;

comment on function public.get_my_work_result(uuid) is
  '自分の作品の結果。分母は実際に出題された問の数（D165）。'
  'ビタ当てと2択当ては別々の数として返す。他人・未サインインには null（D40）。';

revoke all on function public.get_my_work_result(uuid)
  from public, anon, authenticated;
grant execute on function public.get_my_work_result(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 12. 回答後の開示（説明文だけを直す）
-- ----------------------------------------------------------------------------

comment on function public.get_answered_prompt(uuid) is
  '回答済みの人と作者にだけ、正解のお題まるごとを返す（D162 の 4）。'
  'D165 以降はお題の全語が出題されるので、開示と出題の範囲は一致する。'
  '他人・未回答者・未サインインには null。返り値に prompt_id は含めない（D23）。';


-- ----------------------------------------------------------------------------
-- 13. 旧列を「残したまま、使っていない」ことを確かめる（D69）
-- ----------------------------------------------------------------------------
--
-- 見るのは「列が消えたこと」ではない。**新しい実装がその列を参照しないこと**である。
-- 列は互換期間のあいだ残す（3b の理由）。
-- この検査は、この migration がすべての関数を置き換え終えた後で走らせる。
--   落とさないことを決めた以上、「新しい実装がこの列を参照しないこと」を
--   ここで見る。列が在るかどうかではなく、**使っていないこと**が条件である。
do $$
declare
  v_bad text;
begin
  -- この列に触ってよいのは draft_state_json ただ1本で、
  -- そこでも**旧い画面へ返すだけ**である。ほかの関数が触っていたら、
  -- 出題数の決定か採点に混ざっている疑いがある。
  select string_agg(p.proname, ', ')
    into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and p.proname <> 'draft_state_json'
     and pg_get_functiondef(p.oid) like '%quiz_question_count%';

  if v_bad is not null then
    raise exception
      '新しい実装が quiz_question_count を参照しています（%）。'
      'この列は互換期間だけ残す旧列で、出題数の決定にも採点にも使わない', v_bad;
  end if;

  -- draft_state_json 側でも、使い方が「旧い鍵として返すだけ」であること。
  -- 出題数や採点の判断に混ぜていたら、比較や算術がそばに現れる。
  select pg_get_functiondef(p.oid) into v_bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'draft_state_json';
  if v_bad not like '%''quiz_question_count'', dm.quiz_question_count%' then
    raise exception
      'draft_state_json の quiz_question_count が、旧い鍵として返すだけの形になっていません';
  end if;

  -- 列そのものは残っていること（落とすと旧い画面が落ちる）
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'draft_modes'
       and column_name = 'quiz_question_count'
  ) then
    raise exception 'draft_modes.quiz_question_count が落ちています（互換期間は残すこと）';
  end if;
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'draft_sessions'
       and column_name = 'quiz_question_count'
  ) then
    raise exception 'draft_sessions.quiz_question_count が落ちています（互換期間は残すこと）';
  end if;

  -- 旧い画面がモード一覧で読めること
  if not has_column_privilege('anon', 'public.draft_modes', 'quiz_question_count', 'select') then
    raise exception 'anon が draft_modes.quiz_question_count を読めません（旧い画面が落ちます）';
  end if;
end $$;
