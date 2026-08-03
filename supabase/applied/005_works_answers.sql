-- ============================================================================
-- 005_works_answers.sql  ／ Step 3B-3a: 作品・回答・集計6表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. works（投稿作品）を作る
--   2. answers（回答1件）を作る
--   3. answer_items（回答の内訳）【機密】を作る
--   4. work_slot_stats（作品×枠の集計）を作る
--   5. user_stats（回答者の通算成績）を作る
--   6. user_slot_stats（回答者×枠の成績）を作る
--   7. RLS と権限を設定する
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（6表とも 0 行のまま）
--   ・集計を更新するトリガーを作らない。それは Step 9 の回答RPCと同時
--     （論点4-A。3B-3a 完了時点で集計3表が空なのは **意図した状態**）
--   ・作品の投稿・取得・回答の処理（RPC）を作らない。Step 6 以降
--   ・既存12表（profiles / マスタ5表 / ドラフト2表 / お題クイズ4表）に
--     一切触れない
--   ・Storage のバケットを作らない。それは Step 8
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。
--
-- 【重要：正常終了した番号付きマイグレーションは再実行しない】
--   create table に if not exists を付けていない。すでに表がある状態で
--   実行すると「already exists」で止まる。これは意図した動作。
--   やり直すときは 005_works_answers_rollback.sql で消してから流し直す。
--
-- 【前提】
--   004_prompts_quiz.sql まで実行済みであること。
--   works が prompts / profiles を、
--   answer_items が quiz_questions / card_slots / tags を参照する。
--
-- 【取り消し】
--   005_works_answers_rollback.sql を実行する。
--
--
-- 【この工程でいちばん大事なこと】
--
--   answer_items は「誰が・どの問で・どのタグを選び・それが正解だったか」を
--   1行に持つ。**他人のこの行が1件でも読めると、is_correct = true の行から
--   正解タグがそのまま判明する**。クイズが成立しなくなる。
--
--   そこで6表のうち4表は、3B-2a の draft_candidates、
--   3B-2b の機密3表と同じ扱いにする。
--
--     ・テーブル権限を一切与えない（grant を書かない）
--     ・RLS を有効にし、ポリシーを1つも作らない
--
--   直接読もうとすると 0 件ではなく **permission denied** になる（D31）。
--   データを返すのは Step 6 以降の security definer 関数だけ。
--
--
-- 【権限のまとめ】
--
--   表                anon                    authenticated
--   ----------------  ----------------------  --------------------------
--   works             権限なし                権限なし
--   answers           権限なし                権限なし
--   answer_items      権限なし                権限なし
--   work_slot_stats   権限なし                権限なし
--   user_stats        SELECT（公開者の行）    SELECT（本人＋公開者の行）
--   user_slot_stats   SELECT（公開者の行）    SELECT（本人＋公開者の行）
--
--   INSERT / UPDATE / DELETE はどのロールにも与えない。
--   集計3表へ書き込むのは Step 9 のトリガーだけ。
--
--   works の取得経路（論点1-B。D23 のまま変更しない）:
--     get_public_works / get_work_detail / get_my_works / get_my_work
--
--   回答履歴の取得経路（本人のみ。他人へ公開しない）:
--     get_my_answers / get_my_answer
--     → get_public_answer_history は **作らない**。
--        回答履歴は show_answer_stats で公開する集計値とは別の
--        個人の行動履歴であり、MVP では他人へ公開しない。
--        他人へ見せてよいのは user_stats / user_slot_stats の集計値だけ。
--
--   伝達率・枠別正答率（work_slot_stats）の取得経路:
--     get_work_detail / get_my_work の返り値に含める
--     → 直接公開すると、作品IDを総当たりすることで
--        非公開・削除済み作品の存在と回答件数が外から分かってしまう。
--
--
-- 【DB では防げないこと（Step 9 の submit_answer が保証する）】
--
--   次の状態は制約では表現できない（別の表を見る必要があるため）。
--
--     ・answers.correct_count が answer_items の正解数と一致しない
--     ・answer_items の件数が、その作品の問題数と一致しない
--     ・works.answers_count が answers の実件数と一致しない
--     ・answer_items.card_slot_key が、その問の枠と一致しない
--     ・作者が自分の作品に回答してしまう（D28）
--
--   これらは submit_answer RPC が保証し、
--   Step 3E の診断 A6〜A9（このファイル末尾）で継続的に確認する。
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. works ／ 投稿作品
-- ----------------------------------------------------------------------------
--
-- お題を引いて絵を描き終えた人が投稿すると1行できる。
-- 画像そのものはここに入らない。Storage に置き、その場所を image_path に持つ。
--
-- prompt_id に UNIQUE を張ることで「1つのお題から作れる作品は最大1件」に
-- なる（A11 / D17）。同じお題で2作品目を作ろうとすると DB が拒否する。

create table public.works (

  id uuid primary key default gen_random_uuid(),

  -- どのお題から生まれた作品か。
  --
  -- 【最重要】この列はどの取得経路でもクライアントへ返さない（D23）。
  --   返してしまうと prompt_cards（答え）へ辿る足がかりになる。
  --   works 自体に権限を与えないので、そもそも直接は読めない。
  --
  -- ON DELETE RESTRICT:
  --   お題を消そうとしても、作品が付いていれば拒否される。
  --   P4 の掃除（作品のないお題だけが対象）と衝突しない安全弁。
  prompt_id uuid not null unique
    references public.prompts (id) on delete restrict on update restrict,

  -- 投稿者。**正式登録ユーザーのみ**（匿名ゲストは投稿できない）。
  --
  -- ON DELETE RESTRICT:
  --   作品を持つ人は消せない。退会手段は P1 で別途決める。
  --   匿名ゲストの30日削除は、そもそも作品を持てないので衝突しない。
  user_id uuid not null
    references public.profiles (id) on delete restrict on update restrict,

  title text not null
    constraint works_title_length check (char_length(title) between 1 and 60),

  -- Storage 内のパス。画像バイナリではない。
  image_path text not null
    constraint works_image_path_length check (char_length(image_path) between 1 and 512),

  image_width int not null
    constraint works_image_width_range check (image_width between 1 and 20000),
  image_height int not null
    constraint works_image_height_range check (image_height between 1 and 20000),

  -- 部門。**投稿後は変更できない**（下のファンアート整合条件を保つため）。
  -- 間違えた場合は投稿し直す。
  division text not null,

  -- ファンアート専用の3列。division = 'fanart' 以外では必ず null。
  source_title text
    constraint works_source_title_length check (
      source_title is null or char_length(source_title) between 1 and 100
    ),
  source_character text
    constraint works_source_character_length check (
      source_character is null or char_length(source_character) between 1 and 100
    ),
  fanart_note text
    constraint works_fanart_note_length check (
      fanart_note is null or char_length(fanart_note) between 1 and 500
    ),

  -- 実績時間の自己申告（秒）。null = 未申告。
  -- 時間別ランキングの分類には使わない（分類は prompts.time_limit_seconds）。
  -- 公開後は変更できない（D25。これは RPC 側で保証する）。
  actual_time_seconds int
    constraint works_actual_time_range check (
      actual_time_seconds is null or actual_time_seconds between 1 and 600000
    ),

  is_published boolean not null default true,

  -- 運営のみが変更する。クライアントからは触れない。
  review_status text not null default 'ok',

  -- 論理削除。物理削除しないのは、回答や集計を巻き添えにしないため。
  deleted_at timestamptz,

  -- --- カウンタ（トリガーで同期するキャッシュ。D24）---------------------
  -- 正本は likes / saves / answers の行数。
  -- ずれたら数え直せば復旧できる。更新するのは Step 9 以降のトリガーだけ。
  likes_count int not null default 0
    constraint works_likes_count_positive check (likes_count >= 0),
  saves_count int not null default 0
    constraint works_saves_count_positive check (saves_count >= 0),
  answers_count int not null default 0
    constraint works_answers_count_positive check (answers_count >= 0),

  created_at timestamptz not null default now(),

  -- --- 表全体にかかる検査 -------------------------------------------------

  constraint works_division_valid check (
    division in ('original', 'fanart', 'ai')
  ),

  constraint works_review_status_valid check (
    review_status in ('ok', 'flagged', 'hidden')
  ),

  -- 条件1: ファンアートなら元作品名が必須
  constraint works_fanart_requires_source check (
    division <> 'fanart' or source_title is not null
  ),

  -- 条件2: ファンアート以外にファンアート情報が紛れ込まない
  --        （部門を後から変えられない設計は、この整合性を保つため）
  constraint works_non_fanart_has_no_source check (
    division = 'fanart'
    or (source_title is null and source_character is null and fanart_note is null)
  ),

  constraint works_deleted_after_created check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.works is
  '投稿作品。anon / authenticated ともテーブル権限を与えない。'
  '取得は get_public_works / get_work_detail / get_my_works / get_my_work のみ（D23）。';
comment on column public.works.prompt_id is
  '【非公開列】どの取得経路でもクライアントへ返さない（D23）。';
comment on column public.works.actual_time_seconds is
  '実績時間の自己申告。時間別ランキングの分類には使わない（分類は prompts.time_limit_seconds）。';


-- マイページの作品一覧用。
create index works_user_created_idx
  on public.works (user_id, created_at desc);

-- 公開一覧用の部分索引。条件に合う行だけを持つので小さく速い。
create index works_public_idx
  on public.works (created_at desc)
  where is_published and review_status = 'ok' and deleted_at is null;

-- 部門別一覧用。
create index works_division_public_idx
  on public.works (division, created_at desc)
  where is_published and review_status = 'ok' and deleted_at is null;


-- ----------------------------------------------------------------------------
-- 2. answers ／ 回答1件
-- ----------------------------------------------------------------------------
--
-- 「誰がどの作品に答えて、何問正解したか」の1行。
-- 選んだタグそのものは持たない（それは answer_items 側）。

create table public.answers (

  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- 回答者。**匿名ゲストも回答できる**ので null 許容ではない…のではなく、
  -- ゲストが30日で掃除されたときに null になるため null 許容にする。
  --
  -- ON DELETE SET NULL:
  --   ゲストが消えても回答行は残す。作品側の集計を過去に遡って
  --   減らさないため（論点3-A）。
  user_id uuid
    references public.profiles (id) on delete set null on update restrict,

  -- 正解数。quiz_questions.position が 0〜9 なので最大10問。
  -- 「その作品の問題数以下であること」は別の表を見る必要があり
  -- 制約では書けない。submit_answer RPC が保証し、診断 A6/A7 で確認する。
  correct_count int not null
    constraint answers_correct_count_range check (correct_count between 0 and 10),

  created_at timestamptz not null default now(),

  -- 1作品につき1ユーザー1回。
  --
  -- 【注意】Postgres の UNIQUE は NULL 同士を重複と見なさない。
  --   ゲスト掃除で user_id が null になった行は、同じ作品に何行あっても
  --   この制約に引っかからない。これは許容する（論点3-A）。
  --   現役ユーザーの重複回答防止としては正しく働く。
  constraint answers_one_per_user_per_work unique (work_id, user_id)
);

comment on table public.answers is
  '回答1件。anon / authenticated ともテーブル権限を与えない。'
  '取得は get_my_answers / get_my_answer のみ（本人限定）。他人へは公開しない。';
comment on column public.answers.user_id is
  'ゲスト掃除で null になる。null 行も works.answers_count と '
  'work_slot_stats には含めるが、user_stats / user_slot_stats には含めない（論点3-A）。';


create index answers_work_idx
  on public.answers (work_id);

create index answers_user_created_idx
  on public.answers (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. answer_items ／ 回答の内訳【機密】
-- ----------------------------------------------------------------------------
--
-- 【この表がこの工程でいちばん危険】
--   selected_tag_id と is_correct を同じ行に持つため、
--   他人の行が1件でも読めると is_correct = true の行から
--   正解タグがそのまま判明する。
--
--   → 権限を与えず、ポリシーも作らない。本人の分も RPC 経由で返す。

create table public.answer_items (

  id bigint generated always as identity primary key,

  answer_id bigint not null
    references public.answers (id) on delete cascade on update restrict,

  -- どの問への回答か。
  --
  -- ON DELETE RESTRICT:
  --   quiz_questions はお題が消えると cascade で消える。
  --   ここを cascade にすると、お題の削除が回答の内訳まで
  --   静かに巻き込む。restrict なら削除が拒否されて気づける。
  --   作品のあるお題は works.prompt_id の restrict で既に守られているため、
  --   P4 の掃除（作品のないお題だけが対象）と衝突しない。
  question_id bigint not null
    references public.quiz_questions (id) on delete restrict on update restrict,

  -- どの枠の問だったか。spec の slot_key から改名し、他表と名前を統一した。
  -- 「その問の枠と一致していること」は診断 A9 で確認する。
  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  selected_tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- 【機密】正解だったか。
  is_correct boolean not null,

  created_at timestamptz not null default now(),

  -- 1つの問に2回答えられない
  constraint answer_items_one_per_question unique (answer_id, question_id)
);

comment on table public.answer_items is
  '回答の内訳【機密】。selected_tag_id と is_correct を併せ持つため、'
  '他人の行が読めると正解が判明する。権限もポリシーも与えない。';
comment on column public.answer_items.is_correct is
  '【機密】RPC の返り値に含めてよいのは本人の分だけ。';


create index answer_items_answer_idx
  on public.answer_items (answer_id);

create index answer_items_question_idx
  on public.answer_items (question_id);


-- ----------------------------------------------------------------------------
-- 4. work_slot_stats ／ 作品×枠の集計
-- ----------------------------------------------------------------------------
--
-- 「この作品のどの枠が伝わりにくかったか」を出すための集計。
-- 項目別正答率 = corrects / attempts。
-- 枠はモードによって変わるので works の列にはできず、別表に置く。
--
-- ゲスト掃除で user_id が null になった回答も **この表には含める**
-- （その作品に実際に挑戦された回数として正しいため。論点3-A）。

create table public.work_slot_stats (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  attempts int not null default 0
    constraint work_slot_stats_attempts_positive check (attempts >= 0),

  -- 正解数は挑戦数を超えない。
  corrects int not null default 0
    constraint work_slot_stats_corrects_range check (corrects between 0 and attempts),

  updated_at timestamptz not null default now(),

  constraint work_slot_stats_pkey primary key (work_id, card_slot_key)
);

comment on table public.work_slot_stats is
  '作品×枠の正答集計。直接公開すると作品IDの総当たりで'
  '非公開・削除済み作品の存在と回答件数が漏れるため、権限を与えない。'
  '取得は get_work_detail / get_my_work の返り値に含める。';


-- ----------------------------------------------------------------------------
-- 5. user_stats ／ 回答者の通算成績
-- ----------------------------------------------------------------------------
--
-- 「この人は何問答えて、どれくらい当てているか」。
-- profiles.show_answer_stats = true の人だけ、他人にも見える（D11）。
--
-- ゲスト掃除で user_id が null になった回答は **この表に反映しない**
-- （持ち主がいないので加算先がない。論点3-A）。
--
-- ON DELETE CASCADE:
--   成績は本人に付随する派生データ。本人が消えれば一緒に消える。
--   works の restrict とは扱いが違う（作品は他人が見るコンテンツ）。

create table public.user_stats (

  user_id uuid primary key
    references public.profiles (id) on delete cascade on update restrict,

  -- 回答した作品数
  total_answers int not null default 0
    constraint user_stats_total_answers_positive check (total_answers >= 0),

  -- 答えた問の総数
  total_items int not null default 0
    constraint user_stats_total_items_positive check (total_items >= 0),

  -- そのうち当たった数。総数を超えない。
  total_correct_items int not null default 0
    constraint user_stats_correct_range check (
      total_correct_items between 0 and total_items
    ),

  updated_at timestamptz not null default now()
);

comment on table public.user_stats is
  '回答者の通算成績。show_answer_stats = true の登録ユーザーの行は'
  'anon（未ログインの訪問者）からも読める。統計閲覧に匿名サインインは不要。';


-- ----------------------------------------------------------------------------
-- 6. user_slot_stats ／ 回答者×枠の成績
-- ----------------------------------------------------------------------------
--
-- 「自分はどの枠の推測が苦手か」。user_stats と同じ公開条件。

create table public.user_slot_stats (

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  attempts int not null default 0
    constraint user_slot_stats_attempts_positive check (attempts >= 0),

  corrects int not null default 0
    constraint user_slot_stats_corrects_range check (corrects between 0 and attempts),

  updated_at timestamptz not null default now(),

  constraint user_slot_stats_pkey primary key (user_id, card_slot_key)
);

comment on table public.user_slot_stats is
  '回答者×枠の成績。公開条件は user_stats と同じ。';


-- ----------------------------------------------------------------------------
-- 7. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- works / answers / answer_items / work_slot_stats
--   … RLS を有効にし、ポリシーを1つも作らない（完全遮断）
--
-- user_stats / user_slot_stats
--   … anon           : show_answer_stats = true の登録ユーザーの行だけ
--     authenticated  : 本人の行、または上記の行
--
-- 【RLS と権限は別物】
--   RLS が通っても権限が無ければ permission denied。
--   権限があっても RLS で外れれば 0 件（エラーにならない）。D31。

alter table public.works           enable row level security;
alter table public.answers         enable row level security;
alter table public.answer_items    enable row level security;
alter table public.work_slot_stats enable row level security;
alter table public.user_stats      enable row level security;
alter table public.user_slot_stats enable row level security;


-- --- 7-a. works / answers / answer_items / work_slot_stats ------------------
--
-- ポリシーを作らない。RLS が有効でポリシーが無い表は、
-- 所有者（postgres）以外から見ると常に「対象行なし」になる。
-- さらに権限も与えないため、実際には permission denied で止まる。


-- --- 7-b. user_stats --------------------------------------------------------
--
-- 【profiles を参照することについて】
--   ポリシーの中の select は「呼び出した人の権限」で実行される。
--   profiles には anon / authenticated 両方に SELECT 権限があり、
--   「登録済みかつ handle あり」の行は anon からも見えるため、
--   この参照は成立する（001_profiles.sql の profiles_select_public_or_self）。
--
--   is_anonymous = false を明示的に書いているのは、profiles 側の
--   ポリシーが将来変わっても、ここの意図が変わらないようにするため。
--
--   【既知の限界】handle が未設定の登録ユーザーは profiles 側の
--   ポリシーで見えないため、show_answer_stats = true でも
--   成績が公開されない。handle は登録時に必ず設定するので通常は起きない。

create policy user_stats_select_public
  on public.user_stats
  for select
  to anon
  using (
    exists (
      select 1
        from public.profiles p
       where p.id = user_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );

create policy user_stats_select_self_or_public
  on public.user_stats
  for select
  to authenticated
  using (
    (select auth.uid()) = user_stats.user_id
    or exists (
      select 1
        from public.profiles p
       where p.id = user_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );


-- --- 7-c. user_slot_stats ---------------------------------------------------

create policy user_slot_stats_select_public
  on public.user_slot_stats
  for select
  to anon
  using (
    exists (
      select 1
        from public.profiles p
       where p.id = user_slot_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );

create policy user_slot_stats_select_self_or_public
  on public.user_slot_stats
  for select
  to authenticated
  using (
    (select auth.uid()) = user_slot_stats.user_id
    or exists (
      select 1
        from public.profiles p
       where p.id = user_slot_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );


-- ----------------------------------------------------------------------------
-- 8. 権限（どのロールが何をできるか）
-- ----------------------------------------------------------------------------
--
-- revoke all を先に流すのは、以前の実行で広い権限が付いていた場合に
-- 確実に消すため。新規作成なら何も起きない。

revoke all on public.works           from anon, authenticated;
revoke all on public.answers         from anon, authenticated;
revoke all on public.answer_items    from anon, authenticated;
revoke all on public.work_slot_stats from anon, authenticated;
revoke all on public.user_stats      from anon, authenticated;
revoke all on public.user_slot_stats from anon, authenticated;


-- works / answers / answer_items / work_slot_stats へは
-- **何も grant しない**。直接触ると permission denied になる。


-- user_stats / user_slot_stats は列を明示して SELECT を与える。
--
-- 【なぜ全列なのに列名を並べるか】
--   列名を書いておくと、将来 alter table で列を足したときに
--   その列は **自動では公開されない**。書き忘れによる漏洩を防げる。
--   その代わり select * は列が増えた時点で権限エラーになる（D30）。

grant select (
  user_id,
  total_answers,
  total_items,
  total_correct_items,
  updated_at
) on public.user_stats to anon, authenticated;

grant select (
  user_id,
  card_slot_key,
  attempts,
  corrects,
  updated_at
) on public.user_slot_stats to anon, authenticated;


-- INSERT / UPDATE / DELETE はどのロールにも与えない。
-- 集計3表へ書き込むのは Step 9 のトリガーだけ。


commit;


-- ============================================================================
-- Step 3E の必須診断（追加分 A6〜A9）
-- ============================================================================
--
-- DB の制約では表現できない不整合を検出する。
-- **すべて 0 行が返れば正常。1行でも返れば壊れたデータ。**
--
--
-- A6. correct_count が内訳の正解数と一致しない回答
-- select a.id, a.work_id, a.correct_count,
--        count(*) filter (where ai.is_correct) as actual_correct
--   from public.answers a
--   join public.answer_items ai on ai.answer_id = a.id
--  group by a.id, a.work_id, a.correct_count
-- having a.correct_count <> count(*) filter (where ai.is_correct);
--
--
-- A7. 内訳の件数が、その作品の問題数と一致しない回答
-- select a.id, a.work_id,
--        count(ai.id) as item_count,
--        (select count(*) from public.quiz_questions q
--          where q.prompt_id = w.prompt_id) as question_count
--   from public.answers a
--   join public.works w on w.id = a.work_id
--   left join public.answer_items ai on ai.answer_id = a.id
--  group by a.id, a.work_id, w.prompt_id
-- having count(ai.id) <> (select count(*) from public.quiz_questions q
--                          where q.prompt_id = w.prompt_id);
--
--
-- A8. works.answers_count が実件数と一致しない作品
-- select w.id, w.answers_count,
--        (select count(*) from public.answers a where a.work_id = w.id) as actual
--   from public.works w
--  where w.answers_count
--        <> (select count(*) from public.answers a where a.work_id = w.id);
--
--
-- A9. answer_items.card_slot_key が、その問の枠と一致しない
-- select ai.id, ai.card_slot_key as recorded, q.card_slot_key as expected
--   from public.answer_items ai
--   join public.quiz_questions q on q.id = ai.question_id
--  where ai.card_slot_key <> q.card_slot_key;
--
--
-- 【参考】3B-2b で用意した A5（status = 'submitted' なのに作品が無いお題）は
--         この工程で works ができたことにより実行可能になった。
-- select id, mode_key, submitted_at from public.prompts
--  where status = 'submitted'
--    and not exists (select 1 from public.works w where w.prompt_id = prompts.id);


-- ============================================================================
-- 確認用クエリ
-- ============================================================================
--
-- 別ファイルにまとめてある。SQL Editor へ一括で貼って実行する。
--   → supabase/migrations/005_works_answers_verify.sql
--
-- ============================================================================
