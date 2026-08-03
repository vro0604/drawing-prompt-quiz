-- ============================================================================
-- answer_rpc_and_stats ／ Step 10 + 11: クイズの回答と集計
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 集計トリガー2本を作る（works.answers_count / 集計3表を同期）
--   2. submit_answer を作る（採点・保存・正解返却）
--   3. 実行権限を設定する
--
--   これで「作品を見る → 4択に答える → 正解と正誤が出る → 伝達率が動く」
--   までブラウザで通る。
--
-- 【このファイルがやらないこと】
--   ・**既存21表の列・制約・権限を一切変更しない**
--   ・データを1行も消さない・書き換えない
--   ・取得系RPC 13本に手を入れない
--     （問題は get_work_quiz、結果は get_my_answer をそのまま使う）
--   ・いいね・保存・通報を作らない。Step 12 / 15
--   ・ランキングを作らない。Step 13
--   ・回答の取り消し・やり直しを作らない（1作品1回のため。下記参照）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【前提】
--   works_write_rpcs まで適用済みで、作品が投稿できる状態であること。
--
-- 【取り消し】
--   supabase/rollback/011_answer_rpc_and_stats_rollback.sql
--
--
-- 【いちばん大事な安全設計：正解をブラウザへ先に渡さない】
--
--   採点をブラウザで行う作りにすると、採点に必要な正解を先に送ることになる。
--   送った時点で、画面に出さなくても通信の中身を見れば分かってしまう。
--
--   だから採点はこの関数の中だけで行う。
--   ブラウザから来るのは「どの問で、どのタグを選んだか」だけ。
--   正解が外へ出るのは **答え終わったあとの本人** に対してだけで、
--   その経路は 3C の get_my_answer 1本しかない。
--
--   get_work_quiz（出題）はいまも is_correct に一切触れていない。
--   これは db:verify が毎回検査している。
--
--
-- 【2番目に大事：作者は自分の作品に回答できない（D28）】
--
--   描いた本人は答えを知っている。回答できてしまうと必ず全問正解になり、
--   その作品の伝達率が実際より高く出る。
--   表の制約では書けない（別の表を見る必要がある）ので、ここで弾く。
--
--
-- 【1作品につき1回だけ】
--
--   answers に (work_id, user_id) の UNIQUE がある。
--   同じ人が2回答えようとすると DB が拒否するが、索引違反のメッセージは
--   利用者に意味が通じないので、先に自分で見て日本語で返す。
--
--   **やり直す手段は作らない。** 2回目は答えを知った状態なので、
--   何度でも答えられると正答率が意味を失う。
--
--
-- 【集計をトリガーで行う理由（D24）】
--
--   works.answers_count と集計3表は「数え直せば復元できるキャッシュ」。
--   正本は answers / answer_items の行そのもの。
--
--   submit_answer の中で更新してもよいが、トリガーにすると
--   **行が増えた事実そのものに反応する**ので、将来ほかの経路から
--   回答が入っても数がずれない。
--   005 の時点で「集計3表へ書き込むのはトリガーだけ」と決めてある。
--
--   ずれていないことは db:verify の診断 A8 / A11 / A20 / A21 が見張る。
--
--
-- 【ゲストの扱い（論点3-A）】
--
--   匿名ゲストも回答できる（spec 10 の権限表）。
--   ゲストが30日で掃除されると answers.user_id は null になる。
--
--     work_slot_stats … null になった回答も**含めたまま**にする
--                       （その作品に実際に挑戦された回数として正しい）
--     user_stats      … 加算先が消えるので反映しない
--                       （user_id が消えた行は、そもそも誰の成績でもない）
--
--   このファイルのトリガーは「回答が入った瞬間」に動くので、
--   そのときは user_id がまだ入っている。掃除での減算はしない。
--
--
-- 【DB の制約では防げず、この RPC が保証すること】
--
--   ・作者が自分の作品に回答しないこと（D28）
--   ・その作品の問すべてに、ちょうど1つずつ答えていること
--   ・選んだタグが、その問の4択の中にあること
--   ・correct_count が内訳の正解数と一致すること
--
--   これらは Step 3E の診断 A6 / A7 / A9 と対になっている。
--
-- ============================================================================




-- ============================================================================
-- 1. 集計トリガー
-- ============================================================================
--
-- 先に作るのは、読む側が「行を入れたら何が起きるか」を
-- submit_answer より先に把握できるようにするため。


-- ----------------------------------------------------------------------------
-- 1-a. answers が1行増えたとき
-- ----------------------------------------------------------------------------
--
--   works.answers_count        +1
--   user_stats.total_answers   +1（回答者が分かっているときだけ）
--
-- user_stats の行はここで初めて作られることがある。
-- profiles と1対1だが、回答するまで成績の行は要らないので
-- 「無ければ作る」（on conflict do update）で扱う。

create function public.answers_after_insert_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.works w
     set answers_count = w.answers_count + 1
   where w.id = new.work_id;

  if new.user_id is not null then
    insert into public.user_stats as us (user_id, total_answers, updated_at)
    values (new.user_id, 1, now())
    on conflict (user_id) do update
      set total_answers = us.total_answers + 1,
          updated_at    = now();
  end if;

  return null;   -- after トリガーなので戻り値は使われない
end;
$fn$;

comment on function public.answers_after_insert_stats() is
  '回答1件ぶんの集計。works.answers_count と user_stats.total_answers を進める。';


create trigger answers_after_insert_stats
  after insert on public.answers
  for each row
  execute function public.answers_after_insert_stats();


-- ----------------------------------------------------------------------------
-- 1-b. answer_items が1行増えたとき
-- ----------------------------------------------------------------------------
--
--   work_slot_stats  attempts +1 / corrects +（正解なら1）
--   user_stats       total_items +1 / total_correct_items +（正解なら1）
--   user_slot_stats  attempts +1 / corrects +（正解なら1）
--
-- どの作品・誰の回答かは answer_items に無いので、answers を1回だけ引く。

create function public.answer_items_after_insert_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_work_id uuid;
  v_user_id uuid;
  v_correct int := case when new.is_correct then 1 else 0 end;
begin
  select a.work_id, a.user_id
    into v_work_id, v_user_id
    from public.answers a
   where a.id = new.answer_id;

  -- --- 作品×枠（伝達率の材料）------------------------------------------------
  --
  -- ゲストが掃除されて user_id が null になっても、この表からは減らさない。
  -- 「その作品が何回挑戦されたか」は挑戦した人が消えても変わらないため。
  insert into public.work_slot_stats as st
    (work_id, card_slot_key, attempts, corrects, updated_at)
  values (v_work_id, new.card_slot_key, 1, v_correct, now())
  on conflict (work_id, card_slot_key) do update
    set attempts   = st.attempts + 1,
        corrects   = st.corrects + v_correct,
        updated_at = now();

  -- --- 回答者の成績 ----------------------------------------------------------
  --
  -- 回答者が分かっているときだけ。null は加算先が無い。
  if v_user_id is not null then
    insert into public.user_stats as us
      (user_id, total_items, total_correct_items, updated_at)
    values (v_user_id, 1, v_correct, now())
    on conflict (user_id) do update
      set total_items         = us.total_items + 1,
          total_correct_items = us.total_correct_items + v_correct,
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
  '回答の内訳1件ぶんの集計。work_slot_stats / user_stats / user_slot_stats を進める。';


create trigger answer_items_after_insert_stats
  after insert on public.answer_items
  for each row
  execute function public.answer_items_after_insert_stats();




-- ============================================================================
-- 2. submit_answer ／ 採点して保存し、正解を返す
-- ============================================================================
--
-- 【引数の形】
--   p_selections は次の形の配列。
--     [{"question_id": 12, "tag_id": 34}, {"question_id": 13, "tag_id": 40}, ...]
--
--   問の順番は問わない。数と中身が合っていればよい。
--
-- 【返り値】
--   get_my_answer と同じ形をそのまま返す。
--   画面は「送信直後」も「あとから開き直したとき」も同じ描き方でよくなる。

create function public.submit_answer(
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
  v_answer_id      bigint;
begin

  -- --- 1. 誰が答えようとしているか -------------------------------------------
  --
  -- **ゲストも答えられる**（spec 10）。ただし記録には uid が要るので、
  -- 未サインインのままは受け付けない。
  -- 画面側は送信の直前に匿名サインインを済ませてから呼ぶ（spec 11-1）。

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;


  -- --- 2. 答えられる作品か ---------------------------------------------------
  --
  -- 公開条件は get_work_quiz と同じ。満たさなければ
  -- 「見つかりません」とだけ返す（非公開である事実も伏せる。D40）。

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


  -- --- 3. 作者は自分の作品に答えられない（D28）-------------------------------

  if v_work.user_id = v_uid then
    raise exception
      'AUTHOR_CANNOT_ANSWER: 自分の作品には回答できません。'
      '答えを知っているため、正答率が実際より高く出てしまいます。';
  end if;


  -- --- 4. 1作品につき1回だけ -------------------------------------------------

  if exists (
    select 1 from public.answers a
     where a.work_id = p_work_id and a.user_id = v_uid
  ) then
    raise exception
      'ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。';
  end if;


  -- --- 5. 送られてきた選択の形 -----------------------------------------------
  --
  -- 配列以外が来ると、その先の jsonb_array_elements が
  -- 分かりにくいエラーになるので、先に形だけ見る。

  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'BAD_SELECTIONS: 回答の形式が正しくありません。';
  end if;

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


  -- --- 6. 選んだタグが、その問の4択の中にあるか -------------------------------
  --
  -- 【ここを省くと何が起きるか】
  --   選択肢に無いタグを送れてしまう。正解と一致しない限り不正解として
  --   記録されるだけだが、「4択から選ぶ」という前提が崩れ、
  --   総当たりで正解タグを探す入口になる。
  --
  -- 問が **この作品のお題のもの** であることも同時に見ている
  --   （q.prompt_id = v_work.prompt_id）。他人の作品の問IDを混ぜられない。

  select count(*)
    into v_valid_count
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint;

  if v_valid_count <> v_sel_count then
    raise exception
      'BAD_SELECTION: 選択肢にない答えが含まれています。画面を開き直してください。';
  end if;


  -- --- 7. 採点する -----------------------------------------------------------
  --
  -- 正解数を先に数えてから answers を入れる。
  -- 「0で入れてあとで直す」形にしないのは、途中の一瞬でも
  -- correct_count が内訳と食い違う行を作らないため（診断 A6）。

  select count(*)
    into v_correct_count
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint
     and ch.is_correct;


  -- --- 8. 保存する -----------------------------------------------------------
  --
  -- ここで集計トリガーが動く（第1節）。

  insert into public.answers (work_id, user_id, correct_count)
  values (p_work_id, v_uid, v_correct_count)
  returning id into v_answer_id;

  insert into public.answer_items
    (answer_id, question_id, card_slot_key, selected_tag_id, is_correct)
  select v_answer_id,
         q.id,
         q.card_slot_key,      -- 問の枠をそのまま写す（診断 A9）
         ch.tag_id,
         ch.is_correct
    from jsonb_array_elements(p_selections) x
    join public.quiz_questions q
      on q.id = (x ->> 'question_id')::bigint
     and q.prompt_id = v_work.prompt_id
    join public.quiz_choices ch
      on ch.question_id = q.id
     and ch.tag_id = (x ->> 'tag_id')::bigint;


  -- --- 9. 結果を返す ---------------------------------------------------------
  --
  -- 自前で組み立てず get_my_answer を呼ぶ。正解を返す経路を1本にまとめておくと、
  -- 「どこから正解が出るか」を追うのが1か所で済む。
  --
  -- この中の auth.uid() は呼び出した人のまま（security definer でも
  -- 実行者の情報は変わらない）なので、他人の回答が返ることはない。

  return public.get_my_answer(p_work_id);
end;
$fn$;

comment on function public.submit_answer(uuid, jsonb) is
  'クイズを採点して保存し、正解を返す。作者は自作に回答できない（D28）。'
  '1作品につき1回だけ。集計はトリガーが行う。';




-- ============================================================================
-- 3. 実行権限
-- ============================================================================
--
-- submit_answer は authenticated だけ。
-- 匿名ゲストも匿名サインイン後は authenticated なので、ゲストも答えられる。
--
-- トリガー関数2本は誰にも与えない。
-- トリガーとして起動するときは、呼び出し元の EXECUTE 権限を必要としない。

revoke all on function public.submit_answer(uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.answers_after_insert_stats()
  from public, anon, authenticated;
revoke all on function public.answer_items_after_insert_stats()
  from public, anon, authenticated;

grant execute on function public.submit_answer(uuid, jsonb) to authenticated;
