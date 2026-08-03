-- ============================================================================
-- quiz_choice_dedupe ／ 1つのお題の中で選択肢のタグを重複させない
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 「ここから先が修正後」の境目を記録する関数を1本作る
--   2. complete_draft をハズレの選び方だけ差し替える（create or replace）
--
-- 【このファイルがやらないこと】
--   ・**既存の quiz_questions / quiz_choices を1行も書き換えない・消さない**
--   ・既存クイズを作り直さない
--   ・表・列・制約・権限・ほかの関数に触れない
--   ・complete_draft の引数・返り値・前半の処理を変えない
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/012_quiz_choice_dedupe_rollback.sql
--   （関数の中身を1つ前に戻すだけ。データは動かない）
--
--
-- ============================================================================
-- 直す不具合：同じタグが2つの問に出ると、両方で不正解だと確定する
-- ============================================================================
--
-- 【何が起きていたか】
--
--   ハズレの候補は「そのお題で使ったタグ（＝全枠の正解）」を除いて選んでいた。
--   除外は**お題単位**なので、次のことが同時に成り立ってしまう。
--
--     ・タグ X が問Aの正解なら、X は「使用済み」なので
--       問Bのハズレには絶対に出ない
--     ・したがって X が問Aと問Bの両方の選択肢に出ているなら、
--       X はどちらの問でもハズレだと**確定する**
--
--   標準モードは motif_a と motif_b が同じ motif プールを使うため、
--   ハズレを問ごとに独立して引くと、この重複が実際に起きていた
--   （実測で12選択肢中1件）。
--
-- 【なぜ難易度の話ではないか】
--
--   4択が実質3択になるので正答率は 25% → 33% に上がる。だがそれは結果で、
--   問題は **絵を見なくても選択肢の並びだけで候補を消せる** ことにある。
--   「絵から読み取れたかを測る」という企画の前提が崩れる。
--
--   4択の中身は tags を引けば誰でも読めるので、これは
--   「画面に出さない」では防げない。生成の時点で作らないしかない。
--
--
-- ============================================================================
-- 直しかた：プール単位でまとめて引き、問ごとに配る
-- ============================================================================
--
--   問ごとに独立して引くのをやめる。
--   3B-2a の draft_generate_candidates と同じ考え方にそろえた。
--
--     1. そのお題が使うプールごとに、候補タグを1回だけ並べる（くじ順）
--     2. 同じプールを使う問に順番を振る（seq_in_pool）
--     3. k 番目の問には、そのプールの (k-1)*3+1 〜 k*3 番目を渡す
--
--   ブロックが重ならないので、**同じプールの問どうしでタグが重複しない**。
--   別のプールのタグは元々混ざらない（tags.pool_key は1つだけ）。
--
--   正解タグは手順1の候補から丸ごと除いてある（used）。
--   そのため「他の問の正解が自分のハズレに出る」も起きない。
--
--   結果として、1つのお題の全選択肢でタグが重複しなくなる。
--
--
-- 【足りないときは重複で埋めない】
--
--   プールのタグが足りないと、ブロックの後ろが空になって選択肢が欠ける。
--   そこを埋めるために重複を許すと、直したはずの不具合が戻る。
--
--   だから **QUIZ_CHOICES_INSUFFICIENT で失敗させる**。
--   complete_draft 全体が1つのトランザクションなので、
--   お題もカードも作られずに巻き戻る。中途半端なクイズが残るくらいなら、
--   確定に失敗したほうがよい（このファイル以前からの方針）。
--
--   必要なタグ数の目安（1問あたり 正解1 + ハズレ3）:
--     同じプールを k 個の問が使うなら、そのプールに 4k 件以上
--     標準モードの motif は 2問なので 8件以上（いまは16件）
--
--
-- ============================================================================
-- 既存クイズを作り直さない理由
-- ============================================================================
--
--   すでに配られた選択肢を入れ替えると、回答済みの人の
--   answer_items.selected_tag_id が「もう存在しない選択肢」を指しうる。
--   過去の正誤や集計の意味が変わってしまう。
--
--   修正は **これから作られるお題にだけ効く**。
--   既存の重複は残るので、診断 A23 は
--   「修正後に作られたぶん」だけを厳格に見る。その境目を作るのが第1節。
--
-- ============================================================================




-- ============================================================================
-- 1. 修正の境目を記録する
-- ============================================================================
--
-- 【なぜ時刻ではなく id で区切るか】
--   時刻だと、マイグレーションを流した時計と行が入った時計のずれや、
--   ファイル名の日時（＝書いた時刻）と適用時刻の差で判定が揺れる。
--
--   quiz_choices.id は identity で単調に増えるので、
--   **適用時点の最大値より大きい id は、必ず修正後に作られた行**になる。
--   1つのお題の選択肢は1トランザクションでまとめて入るため、
--   お題が境目をまたぐこともない。
--
-- 【なぜ関数にするか】
--   値を db-checks.mjs に直接書くと、環境ごとに違う数字を
--   手で持ち回ることになる。DB 側に置けば、どの環境でも
--   そこで実際に流したときの値が使われる。
--
-- 実行時にしか値が決まらないので、DO ブロックの中で組み立てる。

do $do$
declare
  v_cutoff bigint;
begin
  select coalesce(max(id), 0) into v_cutoff from public.quiz_choices;

  execute format(
    $fmt$
      create or replace function public.quiz_choice_dedupe_cutoff()
      returns bigint
      language sql
      immutable
      set search_path = ''
      as $body$ select %s::bigint $body$
    $fmt$,
    v_cutoff
  );
end
$do$;

comment on function public.quiz_choice_dedupe_cutoff() is
  'このマイグレーションを適用した時点の quiz_choices.id の最大値。'
  'これより大きい id の選択肢は、重複を禁止したあとに作られたもの。診断 A23 が使う。';

-- 外から呼ぶ必要はない。診断は所有者の権限で実行される。
revoke all on function public.quiz_choice_dedupe_cutoff()
  from public, anon, authenticated;




-- ============================================================================
-- 2. complete_draft ／ お題とクイズを確定生成する
-- ============================================================================
--
-- 【変更したのは第4節（4択の生成）だけ】
--   1〜3節（お題・答えのカード・出題する枠）と 5〜6節（検算・完了）は
--   draft_rpcs のときのまま。第5節に重複の検算を1つ足した。

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
  -- 【ここがこのマイグレーションの本体】
  --
  -- 問ごとに独立してハズレを引くのをやめ、プール単位でまとめて引いてから
  -- 問へ配る。同じプールを使う問どうしでブロックが重ならないので、
  -- **1つのお題の全選択肢でタグが重複しない**。
  --
  -- 並び順（position 0〜3）はここで1度だけ混ぜる。
  -- 表示のたびに混ぜないのは、位置が毎回変わる選択肢が正解だと
  -- 分かってしまう、といった別の手がかりを与えないため。

  insert into public.quiz_choices (question_id, tag_id, position, is_correct)
  with q as (
    -- 出題する問と、その正解タグ。
    -- seq_in_pool は「同じプールを使う問の中で何番目か」。
    -- 順番を position で決めているので、同じお題なら常に同じ配り方になる。
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
    -- そのお題で正解として使われている全タグ。
    -- どの問のハズレにも出さない（出すと「これも正解では」と紛らわしく、
    -- かつ他の問の正解を消去法で絞れてしまう）。
    select pc.tag_id from public.prompt_cards pc where pc.prompt_id = v_prompt_id
  ),
  pools as (
    select distinct pool_key from q
  ),
  lots as (
    -- くじの値を先に確定させてから並べ替える。
    -- order by の中で直接 random() を呼ぶと並べ替えの途中で値が変わりうる。
    select t.id as tag_id, t.pool_key, random() as lot
      from public.tags t
      join pools p on p.pool_key = t.pool_key
     where t.is_active
       and t.id not in (select u.tag_id from used u)
  ),
  ranked as (
    select l.tag_id, l.pool_key,
           row_number() over (partition by l.pool_key order by l.lot) as rn
      from lots l
  ),
  distractors as (
    -- k 番目の問には (k-1)*3+1 〜 k*3 番目を渡す。
    -- 3 はハズレの数（4択のうち正解1を除いた残り。A2 / D15 で4択固定）。
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

  -- 足りない場合に重複で埋めない。失敗させて全体を巻き戻す。
  if v_inserted <> v_session.quiz_question_count * 4 then
    raise exception
      'QUIZ_CHOICES_INSUFFICIENT: 選択肢が %件しか作れませんでした（必要 %件）。'
      '同じプールを使う問の数に対してタグが不足しています'
      '（1つのプールを k 問が使うなら 4k 件以上必要）。',
      v_inserted, v_session.quiz_question_count * 4;
  end if;

  -- --- 5. 数え直して検算する（診断 A1〜A2 / A23 と同じ観点）------------------
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

  -- お題全体で選択肢のタグが重複していないこと。
  -- 上の配り方で保証しているつもりでも、数え直して確かめる
  -- （重複が1件でも残ると、そのタグは全問で不正解だと確定してしまう）。
  select count(distinct qc.tag_id) into v_distinct
    from public.quiz_choices qc
    join public.quiz_questions qq on qq.id = qc.question_id
   where qq.prompt_id = v_prompt_id;

  if v_distinct <> v_session.quiz_question_count * 4 then
    raise exception
      'QUIZ_CHOICES_DUPLICATE: 選択肢のタグが重複しています（%種類／必要 %種類）。'
      '同じタグが2つの問に出ると、そのタグはどちらでも不正解だと分かってしまいます。',
      v_distinct, v_session.quiz_question_count * 4;
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

comment on function public.complete_draft(uuid) is
  'お題とクイズを確定生成する。1つのお題の全選択肢でタグが重複しない'
  '（重複すると、そのタグが全問で不正解だと確定してしまうため）。';


-- ----------------------------------------------------------------------------
-- 権限をかけ直す
-- ----------------------------------------------------------------------------
--
-- create or replace は権限を引き継ぐので本来は不要。
-- 将来 drop → create で作り直したときに付け忘れないよう、明示しておく。

revoke all on function public.complete_draft(uuid) from public, anon, authenticated;
grant execute on function public.complete_draft(uuid) to authenticated;
