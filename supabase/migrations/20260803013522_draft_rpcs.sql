-- ============================================================================
-- draft_rpcs ／ Step 4: 最小タグ投入 ＋ ドラフトRPC
-- ============================================================================
--
-- 【このファイルがやること】
--   1. easy / standard が動く最小限のタグを46件入れる
--   2. 内部ヘルパー2本を作る（外からは呼べない）
--   3. ドラフトRPC 6本を作る
--   4. 実行権限を設定する
--
--   これで「モードを選ぶ → カードをめくる → お題が確定する」まで
--   ブラウザで通せるようになる。
--
-- 【このファイルがやらないこと】
--   ・表・列・制約・権限の変更（既存21表には触れない）
--   ・作品投稿・回答・いいねの処理（Step 6以降）
--   ・未選択カードの開示（reveal_unchosen）は create_work / abandon 時に行うため
--     Step 6 で実装する。ここでは開示しない
--
-- 【実行方法】
--   npm run db:deploy （dry-run のあと push される）
--   CLI がファイル全体を1つのトランザクションで実行するため、
--   途中で失敗すれば何も残らない。
--
-- 【前提】
--   baseline_applied_schema（001〜007 相当）が適用済みであること。
--
-- 【取り消し】
--   supabase/rollback/008_draft_rpcs_rollback.sql を SQL Editor で実行する。
--   **タグ46件も消える**ため、実行前に必ず注意書きを読むこと。
--
--
-- 【タグを46件にした理由】
--
--   standard モードは motif プールを2枠（motif_a / motif_b）で使い、
--   1枠あたり5枚の候補を出す。同じ世代でタグは重複できないため、
--   motif だけで **最低10件** 必要になる。
--
--   さらにクイズの選択肢は4択で、正解1件＋ハズレ3件を同じプールから取る。
--   ハズレにはそのお題で使ったタグを混ぜない（混ぜると「これも正解では」と
--   紛らわしくなる）ので、motif は 2件除外してなお3件必要。
--
--   余裕を見て次のようにした。3D で本番用のタグに差し替える。
--
--     motif    16件（最低10 → 引き直しても同じ組み合わせになりにくい）
--     color    10件（最低 5）
--     species  10件（最低 5）
--     genre    10件（最低 5）
--
--   role / era / gender / constraint プールは easy / standard が使わないため
--   0件のまま。weight はすべて 100（均等）にしてある。
--   出やすさの調整は 3D で行う。
--
--
-- 【ドラフトRPC 6本】
--
--   start_draft(mode_key, time_limit_seconds)      新しいドラフトを始める
--   reveal_card(session_id, card_slot_key, index)  伏せカードを1枚めくって確定
--   reroll_draft(session_id)                       全部引き直す
--   complete_draft(session_id)                     お題とクイズを確定生成
--   get_current_draft()                            進行中のドラフトを取得
--   abandon_draft(session_id)                      ドラフトを捨てる
--
--   get_current_draft と abandon_draft は指定に無かったが、無いと
--   「ブラウザでお題確定まで通す」が成立しないため同時に作る。
--   ・画面を再読み込みしたら続きが表示できない（get_current_draft）
--   ・進行中が1つでもあると新規開始が拒否され、戻れなくなる（abandon_draft）
--
--
-- 【いちばん大事な安全設計：めくっていないカードの中身を返さない】
--
--   draft_candidates は誰も直接読めない（3B-2a）。だが RPC がうっかり
--   全カードを返せば同じことになる。
--
--   このファイルの draft_state_json は、**revealed_at が入っているカード
--   だけ** label と tag_id を返す。まだめくっていないカードは
--   両方とも null にする。
--
--   tag_id も隠すのは、tags 表が公開されていて
--   「id が分かれば label を引ける」ため。片方だけ隠しても意味がない。
--
--
-- 【DB では防げず、この RPC が保証すること】
--
--   ・各枠に candidate_count 件ちょうどの候補を作る
--   ・同じプールを使う枠どうしでタグが重複しない
--   ・選べるのは現在の世代の候補だけ
--   ・1枠につき1枚だけ選べる
--   ・クイズの正解がちょうど1件存在する（部分UNIQUEは「最大1件」まで）
--   ・選択肢がちょうど4件
--
--   最後の2つは Step 3E の診断 A1〜A4 と対になっている。
--   このファイルでは、生成した直後に自分で数え直して不一致なら失敗させる。
--
-- ============================================================================




-- ============================================================================
-- 1. 最小タグ 46件
-- ============================================================================
--
-- 再実行できるように on conflict (pool_key, label) を付ける。
-- 固有名詞・実在の商品名・人名は入れない（3D の本番タグでも同じ方針）。

insert into public.tags (pool_key, label, weight, is_active) values

  -- --- motif（モチーフ）16件 ------------------------------------------------
  ('motif', '傘',        100, true),
  ('motif', '灯台',      100, true),
  ('motif', '三日月',    100, true),
  ('motif', '歯車',      100, true),
  ('motif', '風船',      100, true),
  ('motif', '花束',      100, true),
  ('motif', '古書',      100, true),
  ('motif', '万年筆',    100, true),
  ('motif', '砂時計',    100, true),
  ('motif', '折り鶴',    100, true),
  ('motif', '観覧車',    100, true),
  ('motif', '提灯',      100, true),
  ('motif', '錨',        100, true),
  ('motif', '蓄音機',    100, true),
  ('motif', '温室',      100, true),
  ('motif', '螺旋階段',  100, true),

  -- --- color（色）10件 -------------------------------------------------------
  ('color', '赤',   100, true),
  ('color', '青',   100, true),
  ('color', '黄',   100, true),
  ('color', '緑',   100, true),
  ('color', '紫',   100, true),
  ('color', '橙',   100, true),
  ('color', '桃',   100, true),
  ('color', '白',   100, true),
  ('color', '黒',   100, true),
  ('color', '金',   100, true),

  -- --- species（種族）10件 ---------------------------------------------------
  ('species', '人間',     100, true),
  ('species', '獣人',     100, true),
  ('species', 'エルフ',   100, true),
  ('species', 'ドラゴン', 100, true),
  ('species', '人魚',     100, true),
  ('species', '天使',     100, true),
  ('species', '悪魔',     100, true),
  ('species', '妖精',     100, true),
  ('species', '機械人形', 100, true),
  ('species', '幽霊',     100, true),

  -- --- genre（ジャンル類型）10件 ---------------------------------------------
  ('genre', '日常',         100, true),
  ('genre', 'バトル',       100, true),
  ('genre', 'ホラー',       100, true),
  ('genre', 'ファンタジー', 100, true),
  ('genre', 'SF',           100, true),
  ('genre', '和風',         100, true),
  ('genre', 'ミステリー',   100, true),
  ('genre', 'コメディ',     100, true),
  ('genre', 'ロマンス',     100, true),
  ('genre', '冒険',         100, true)

on conflict (pool_key, label) do update
  set weight    = excluded.weight,
      is_active = excluded.is_active;


-- ============================================================================
-- 2. 内部ヘルパー（外からは呼べない）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 2-a. draft_generate_candidates ／ 候補カードを1世代分つくる
-- ----------------------------------------------------------------------------
--
-- start_draft と reroll_draft の両方から呼ぶ。同じ抽選ロジックを
-- 2か所に書くと、片方だけ直したときにずれるため関数にまとめた。
--
-- 【重み付き抽選のしくみ】
--   各タグに power(random(), 1 / weight) という「くじの値」を計算し、
--   大きい順に必要な数だけ取る。weight が大きいタグほど大きな値が
--   出やすいので、当たりやすくなる。
--   （重複を許さない重み付き抽選の標準的なやり方）
--
--   くじの値は先に別の select で確定させてから並べ替える。
--   order by の中で直接 random() を呼ぶと、並べ替えの途中で
--   値が変わりうるため。
--
-- 【プール単位でまとめて引く理由】
--   standard は motif_a と motif_b が同じ motif プールを使う。
--   枠ごとに別々に引くと同じタグが両方に出てしまう。
--   プール単位で「必要な総数」をまとめて引き、あとから枠へ配る。

create function public.draft_generate_candidates(
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
  v_slot_count int;
  v_inserted   int;
begin
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
           row_number() over (partition by cs.pool_key order by dms.sort_order) as seq_in_pool
      from public.draft_mode_slots dms
      join public.card_slots cs on cs.card_slot_key = dms.card_slot_key
     where dms.mode_key = p_mode_key
  ),
  used_pools as (
    select distinct pool_key from slots
  ),
  lottery as (
    -- くじの値を先に確定させる
    select t.id as tag_id,
           t.pool_key,
           power(random(), 1.0 / t.weight) as lot
      from public.tags t
      join used_pools up on up.pool_key = t.pool_key
     where t.is_active
  ),
  ranked as (
    select l.tag_id,
           l.pool_key,
           row_number() over (partition by l.pool_key order by l.lot desc) as rn
      from lottery l
  ),
  wanted as (
    -- 枠 × 候補番号 ごとに「プール内の何番目のタグを使うか」を決める
    select s.card_slot_key,
           s.slot_order,
           s.pool_key,
           gs.i as candidate_index,
           (s.seq_in_pool - 1) * p_candidate_count + gs.i + 1 as pick_rn
      from slots s
      cross join generate_series(0, p_candidate_count - 1) as gs(i)
  )
  select p_session_id,
         p_generation,
         w.card_slot_key,
         w.slot_order,
         w.candidate_index,
         r.tag_id
    from wanted w
    join ranked r on r.pool_key = w.pool_key and r.rn = w.pick_rn;

  get diagnostics v_inserted = row_count;

  -- 【最重要】タグが足りないと候補が欠けたまま進んでしまう。
  --   その場合は必ず失敗させ、トランザクション全体を巻き戻す。
  if v_inserted <> v_slot_count * p_candidate_count then
    raise exception
      'NOT_ENOUGH_TAGS: 候補が %件しか作れませんでした（必要 %件）。'
      'モード % に必要なタグが不足しています。',
      v_inserted, v_slot_count * p_candidate_count, p_mode_key;
  end if;
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 2-b. draft_state_json ／ ドラフトの現在状態をJSONで返す
-- ----------------------------------------------------------------------------
--
-- 【この関数が守る唯一のこと】
--   revealed_at が null のカードは tag_id も label も返さない。
--   tags 表は公開されているので、id を返した時点で label が引ける。
--   片方だけ隠しても意味がないため両方 null にする。
--
-- 呼び出し元が本人確認を済ませている前提。この関数自体は所有者を見ない。
-- だから外部へは grant しない。

create function public.draft_state_json(p_session_id uuid)
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
    'slot_count',          (select count(*) from public.draft_mode_slots dms
                             where dms.mode_key = ds.mode_key),
    'chosen_count',        (select count(*) from public.draft_candidates dc
                             where dc.session_id = ds.id
                               and dc.generation = ds.current_generation
                               and dc.is_chosen),
    'is_ready_to_complete',
      (select count(*) from public.draft_candidates dc
        where dc.session_id = ds.id
          and dc.generation = ds.current_generation
          and dc.is_chosen)
      = (select count(*) from public.draft_mode_slots dms
          where dms.mode_key = ds.mode_key),
    'slots', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   x.card_slot_key,
                 'card_slot_label', x.card_slot_label,
                 'slot_order',      x.slot_order,
                 'is_current',      x.slot_order = ds.current_slot_order,
                 'candidates',      x.candidates
               )
               order by x.slot_order
             )
        from (
          select dc.card_slot_key,
                 cs.label as card_slot_label,
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
            join public.tags       tg on tg.id            = dc.tag_id
           where dc.session_id = ds.id
             and dc.generation = ds.current_generation
           group by dc.card_slot_key, cs.label, dc.slot_order
        ) x
    ), '[]'::jsonb)
  )
  from public.draft_sessions ds
  join public.draft_modes dm on dm.mode_key = ds.mode_key
  where ds.id = p_session_id;
$fn$;


-- ============================================================================
-- 3. ドラフトRPC
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 3-a. start_draft ／ 新しいドラフトを始める
-- ----------------------------------------------------------------------------
--
-- 進行中のドラフトが既にある場合はエラーにする。
-- DB 側にも「1人1つまで」の部分UNIQUE索引があるが、
-- 索引違反のエラー文は利用者に意味が通じないため、先に自分で見る。

create function public.start_draft(
  p_mode_key           text,
  p_time_limit_seconds int default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid        uuid := (select auth.uid());
  v_session_id uuid;
  v_mode       record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select dm.mode_key, dm.candidate_count, dm.max_rerolls, dm.quiz_question_count
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

  perform public.draft_generate_candidates(
    v_session_id, 1, v_mode.mode_key, v_mode.candidate_count);

  return public.draft_state_json(v_session_id);
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 3-b. reveal_card ／ 伏せカードを1枚めくって確定する
-- ----------------------------------------------------------------------------
--
-- このアプリでは「めくる＝選ぶ」。めくった1枚がその枠の答えになる。
-- 枠は slot_order の順に1つずつ進む（current_slot_order）。
-- 順番を強制するのは、先の枠を見てから前の枠を選び直す、といった
-- 抜け道を作らないため。

create function public.reveal_card(
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
  v_uid       uuid := (select auth.uid());
  v_session   record;
  v_slot_order int;
  v_updated   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.current_generation, ds.current_slot_order
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

  select dc.slot_order into v_slot_order
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
   limit 1;

  if v_slot_order is null then
    raise exception 'SLOT_NOT_FOUND: 枠 % はこのドラフトにありません。', p_card_slot_key;
  end if;

  if v_slot_order <> v_session.current_slot_order then
    raise exception 'WRONG_SLOT_ORDER: いまめくれるのは %番目の枠です。',
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

  update public.draft_candidates dc
     set revealed_at = clock_timestamp(),
         is_chosen   = true
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.card_slot_key = p_card_slot_key
     and dc.candidate_index = p_candidate_index;

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'CANDIDATE_NOT_FOUND: %番のカードはありません。', p_candidate_index;
  end if;

  update public.draft_sessions ds
     set current_slot_order = ds.current_slot_order + 1
   where ds.id = p_session_id;

  return public.draft_state_json(p_session_id);
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 3-c. reroll_draft ／ 全部引き直す
-- ----------------------------------------------------------------------------
--
-- 世代を1つ進めて、新しい候補を作り直す。前の世代の行は消さずに残す。
-- 消さないのは、あとから「何を引き直したか」を追えるようにするため
-- （容量は小さく、消す利点がない）。
--
-- 引き直すと選択はすべて白紙に戻り、1番目の枠からやり直しになる。

create function public.reroll_draft(p_session_id uuid)
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

  perform public.draft_generate_candidates(
    p_session_id,
    v_session.current_generation + 1,
    v_session.mode_key,
    v_session.candidate_count);

  return public.draft_state_json(p_session_id);
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 3-d. complete_draft ／ お題とクイズを確定生成する
-- ----------------------------------------------------------------------------
--
-- このファイルでいちばん複雑な処理。次の順に作る。
--
--   1. prompts        … お題1件
--   2. prompt_cards   … 選んだカード（＝答え）
--   3. quiz_questions … 出題する枠を quiz_priority 順に選ぶ
--   4. quiz_choices   … 各問4択（正解1 ＋ ハズレ3）
--
-- 【DBの制約では守れないものを、ここで数え直して確認する】
--   ・正解がちょうど1件（部分UNIQUEは「最大1件」しか保証しない）
--   ・選択肢がちょうど4件
--   数が合わなければ例外を投げ、トランザクション全体を巻き戻す。
--   中途半端なクイズがDBに残るくらいなら、確定に失敗したほうがよい。

create function public.complete_draft(p_session_id uuid)
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

  select count(*) into v_slot_count
    from public.draft_mode_slots dms
   where dms.mode_key = v_session.mode_key;

  select count(*) into v_chosen_count
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  if v_chosen_count <> v_slot_count then
    raise exception 'DRAFT_INCOMPLETE: まだ決まっていない枠があります（%/%）。',
      v_chosen_count, v_slot_count;
  end if;

  -- --- 1. お題 --------------------------------------------------------------
  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active')
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

  -- --- 3. 出題する枠 --------------------------------------------------------
  --
  -- そのモードが使う枠のうち、クイズに出せるものを quiz_priority の
  -- 小さい順に quiz_question_count 個だけ選ぶ。
  insert into public.quiz_questions (prompt_id, card_slot_key, position)
  select v_prompt_id, x.card_slot_key, x.rn - 1
    from (
      select cs.card_slot_key,
             row_number() over (order by cs.quiz_priority) as rn
        from public.draft_mode_slots dms
        join public.card_slots cs on cs.card_slot_key = dms.card_slot_key
       where dms.mode_key = v_session.mode_key
         and cs.is_quiz_eligible
    ) x
   where x.rn <= v_session.quiz_question_count;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_session.quiz_question_count then
    raise exception
      'QUESTION_COUNT_MISMATCH: 出題できる枠が %個しかありません（必要 %個）。',
      v_inserted, v_session.quiz_question_count;
  end if;

  -- --- 4. 4択 ---------------------------------------------------------------
  --
  -- ハズレは同じプールから引く。そのお題で使ったタグは除く
  -- （使ったタグを混ぜると「これも正解では」と紛らわしくなるため）。
  --
  -- 並び順（position 0〜3）はここで1度だけ混ぜる。
  -- 表示のたびに混ぜないのは、位置が毎回変わる選択肢が正解だと
  -- 分かってしまう、といった別の手がかりを与えないため。
  insert into public.quiz_choices (question_id, tag_id, position, is_correct)
  with q as (
    select qq.id as question_id,
           cs.pool_key,
           pc.tag_id as correct_tag_id
      from public.quiz_questions qq
      join public.card_slots   cs on cs.card_slot_key = qq.card_slot_key
      join public.prompt_cards pc on pc.prompt_id     = qq.prompt_id
                                 and pc.card_slot_key = qq.card_slot_key
     where qq.prompt_id = v_prompt_id
  ),
  used as (
    select pc.tag_id from public.prompt_cards pc where pc.prompt_id = v_prompt_id
  ),
  distractor_lots as (
    select q.question_id, t.id as tag_id, random() as lot
      from q
      join public.tags t on t.pool_key = q.pool_key and t.is_active
     where t.id not in (select u.tag_id from used u)
  ),
  distractors as (
    select dl.question_id, dl.tag_id, false as is_correct,
           row_number() over (partition by dl.question_id order by dl.lot) as rn
      from distractor_lots dl
  ),
  picked as (
    select d.question_id, d.tag_id, d.is_correct
      from distractors d
     where d.rn <= 3
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
  if v_inserted <> v_session.quiz_question_count * 4 then
    raise exception
      'CHOICE_COUNT_MISMATCH: 選択肢が %件です（必要 %件）。同じプールのタグが不足しています。',
      v_inserted, v_session.quiz_question_count * 4;
  end if;

  -- --- 5. 数え直して検算する（診断 A1〜A2 と同じ観点）------------------------
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

  -- --- 6. ドラフトを完了にする ----------------------------------------------
  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  return jsonb_build_object(
    'prompt_id',  v_prompt_id,
    'mode_key',   v_session.mode_key,
    'card_count', v_slot_count,
    'question_count', v_session.quiz_question_count
  );
end;
$fn$;


-- ----------------------------------------------------------------------------
-- 3-e. get_current_draft ／ 進行中のドラフトを取得
-- ----------------------------------------------------------------------------
--
-- 画面を再読み込みしても続きから表示できるようにするための入口。
-- 進行中が無ければ null。

create function public.get_current_draft()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.draft_state_json(ds.id)
    from public.draft_sessions ds
   where ds.user_id = (select auth.uid())
     and ds.status = 'in_progress'
   limit 1;
$fn$;


-- ----------------------------------------------------------------------------
-- 3-f. abandon_draft ／ ドラフトを捨てる
-- ----------------------------------------------------------------------------
--
-- 状態を abandoned にするだけで、行は消さない。
-- 「1人につき進行中は1つまで」の制限に引っかかって前へ進めなくなるのを防ぐ。
--
-- 【消えないこと】draft_sessions も draft_candidates も残る。
--   30日後に Step 16 の掃除で削除される（§8-3 の掃除規則）。

create function public.abandon_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_updated int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  update public.draft_sessions ds
     set status       = 'abandoned',
         abandoned_at = clock_timestamp()
   where ds.id = p_session_id
     and ds.user_id = v_uid
     and ds.status = 'in_progress';

  get diagnostics v_updated = row_count;

  if v_updated <> 1 then
    raise exception 'DRAFT_NOT_FOUND: 破棄できる進行中のドラフトがありません。';
  end if;

  return jsonb_build_object('session_id', p_session_id, 'status', 'abandoned');
end;
$fn$;


-- ============================================================================
-- 4. 実行権限
-- ============================================================================
--
-- 内部ヘルパー2本は誰にも与えない。
-- ドラフトRPC 6本は authenticated だけ（ゲストも匿名サインイン後は
-- authenticated になる）。anon（未サインイン）はドラフトを引けない。

revoke all on function public.draft_generate_candidates(uuid, int, text, int)
  from public, anon, authenticated;
revoke all on function public.draft_state_json(uuid)
  from public, anon, authenticated;

revoke all on function public.start_draft(text, int)        from public, anon, authenticated;
revoke all on function public.reveal_card(uuid, text, int)  from public, anon, authenticated;
revoke all on function public.reroll_draft(uuid)            from public, anon, authenticated;
revoke all on function public.complete_draft(uuid)          from public, anon, authenticated;
revoke all on function public.get_current_draft()           from public, anon, authenticated;
revoke all on function public.abandon_draft(uuid)           from public, anon, authenticated;

grant execute on function public.start_draft(text, int)       to authenticated;
grant execute on function public.reveal_card(uuid, text, int) to authenticated;
grant execute on function public.reroll_draft(uuid)           to authenticated;
grant execute on function public.complete_draft(uuid)         to authenticated;
grant execute on function public.get_current_draft()          to authenticated;
grant execute on function public.abandon_draft(uuid)          to authenticated;


