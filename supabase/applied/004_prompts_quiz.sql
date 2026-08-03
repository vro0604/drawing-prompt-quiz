-- ============================================================================
-- 004_prompts_quiz.sql  ／ Step 3B-2b: 確定お題・クイズ4表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. prompts（確定したお題）を作る
--   2. prompt_cards（お題を構成する確定カード＝答え）【機密】を作る
--   3. quiz_questions（出題される問）【機密】を作る
--   4. quiz_choices（各問の4択と正解の印）【機密】を作る
--   5. RLS と権限を設定する
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（4表とも 0 行のまま）
--   ・お題を確定する処理（complete_draft RPC）を作らない。それは Step 5
--   ・クイズを返す処理（get_work_quiz RPC）を作らない。それは Step 10
--   ・既存8表（profiles / マスタ5表 / ドラフト2表）に一切触れない
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
--   やり直すときは 004_prompts_quiz_rollback.sql で消してから流し直す。
--
-- 【前提】
--   003_draft.sql まで実行済みであること。
--   prompts が draft_sessions / profiles / draft_modes を、
--   prompt_cards と quiz_choices が tags を参照する。
--
-- 【取り消し】
--   004_prompts_quiz_rollback.sql を実行する。
--
--
-- 【この工程でいちばん大事なこと】
--
--   3B-2a の draft_candidates は「まだ見ていないカード」だった。
--   今回扱うのは **確定した答え** と **正解の印そのもの**。
--
--   prompt_cards   … 選ばれたタグ。お題の答えそのもの
--   quiz_questions … どのお題のどの枠が出題されているか
--   quiz_choices   … 4択と、そのうちどれが正解かの印
--
--   この3表は anon にも authenticated にも
--   **テーブル権限を一切与えず、RLS ポリシーも1つも作らない**。
--   読めるのは Step 5 以降の security definer 関数だけ。
--
--   クイズの表示は必ず get_work_quiz(work_id) を通す。
--   「同じ表から is_correct だけ隠して返す」という設計にしないのは、
--   列を1つ足したときに黙って漏れる形だから（D22）。
--
--
-- 【権限のまとめ】
--
--   表               anon        authenticated
--   ---------------  ----------  ------------------------------
--   prompts          権限なし    SELECT（8列のみ・本人の行だけ）
--   prompt_cards     権限なし    権限なし
--   quiz_questions   権限なし    権限なし
--   quiz_choices     権限なし    権限なし
--
--   INSERT / UPDATE / DELETE はどのロールにも与えない（すべて RPC 経由）。
--
--   prompts で読める8列:
--     id, mode_key, time_limit_seconds, was_rerolled,
--     reroll_count, status, candidates_revealed_at, created_at
--
--   読めない5列:
--     draft_session_id, created_by, reveal_reason, submitted_at, abandoned_at
--
--
-- 【DB では防げないこと（Step 5 の complete_draft が保証する）】
--
--   quiz_choices の部分UNIQUE が保証するのは「正解が **最大** 1件」であり、
--   「正解が **必ず** 1件存在する」ことではない。次の状態は DB を通る。
--
--     ・正解が 0 件の問題
--     ・選択肢が 4 件でない問題
--     ・正解のタグが prompt_cards の答えと一致しない問題
--     ・prompt_cards の件数がモードの枠数と一致しないお題
--
--   これらは complete_draft RPC が保証し、テストで確認する。
--   さらに Step 3E の診断で「壊れていたら必ず見つかる」状態にする
--   （検出クエリはこのファイルの末尾に用意した）。
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. prompts ／ 確定したお題
-- ----------------------------------------------------------------------------
--
-- ドラフトを引き終えると1行できる。
-- この表自体にタグは入っていない（答えは prompt_cards 側）ため、
-- 本人が直接読んでも正解は漏れない。

create table public.prompts (
  id uuid primary key default gen_random_uuid(),

  -- どのドラフトから生まれたお題か。
  --
  -- 【非公開列】
  --
  -- unique かつ null 許容にしている理由:
  --   PostgreSQL の unique は null を重複とみなさない。そのため
  --     ・値が入っている限り「1つのドラフトから作れるお題は最大1件」
  --     ・null になった行は何件あってもよい
  --   の両方が同時に成り立つ。
  --
  -- on delete set null:
  --   ゲストが30日で削除されると draft_sessions が cascade で消えるが、
  --   そのお題で作られた作品が残っている可能性があるため、お題は残す。
  --
  -- 【確定した副作用】
  --   ドラフトが消えると draft_candidates（未選択カード）も一緒に消える。
  --   その結果、そのお題の未選択カードは永久に辿れなくなる。
  --   答え（prompt_cards）は残るのでクイズは成立し続ける。
  --   これは意図した制限として受容する。
  draft_session_id uuid unique
    references public.draft_sessions (id) on delete set null on update restrict,

  -- 誰が引いたお題か。ゲストも含む。
  -- 【非公開列】RLS の条件に使うが値は渡さない。
  --
  -- on delete set null: 作成者が消えてもお題は残す（spec 11-4）。
  --   null になると RLS の条件（auth.uid() = created_by）が真にならないため、
  --   そのお題は誰からも見えなくなる。エラーではなく 0 件。
  --   作品ページの表示に必要な情報は security definer の RPC が取得するので、
  --   表示は壊れない。
  created_by uuid
    references public.profiles (id) on delete set null on update restrict,

  mode_key text not null
    references public.draft_modes (mode_key) on delete restrict on update restrict,

  -- 制作時間。確定時に draft_sessions からコピーする。null = 無制限。
  time_limit_seconds int
    constraint prompts_time_limit_range check (
      time_limit_seconds is null or time_limit_seconds between 60 and 600000
    ),

  was_rerolled boolean not null default false,

  reroll_count int not null default 0
    constraint prompts_reroll_count_range check (reroll_count between 0 and 5),

  -- active    … お題は確定したが、まだ作品が投稿されていない
  -- submitted … この お題で作品が投稿された
  -- abandoned … 描かないと本人が宣言した
  --
  -- 【位置づけ】表示・進行管理用の派生状態（D35）。
  -- 「1つのお題から最大1作品」の強制保証は works.prompt_id の UNIQUE だけが担う。
  -- status を根拠に作品作成を拒否する二重管理は行わない。
  status text not null default 'active',

  -- 未選択カードを開示した日時と理由。開示は不可逆。
  candidates_revealed_at timestamptz,
  reveal_reason text,   -- 【非公開列】

  created_at   timestamptz not null default now(),
  submitted_at timestamptz,   -- 【非公開列】
  abandoned_at timestamptz,   -- 【非公開列】

  -- --- 整合条件 -------------------------------------------------------------

  constraint prompts_status_valid check (
    status in ('active', 'submitted', 'abandoned')
  ),

  constraint prompts_reveal_reason_valid check (
    reveal_reason is null
    or reveal_reason in ('work_submitted', 'abandoned', 'manual')
  ),

  -- 開示日時と理由はセット。「開示したのに理由が無い」を防ぐ
  constraint prompts_reveal_pair check (
    (candidates_revealed_at is null     and reveal_reason is null)
    or
    (candidates_revealed_at is not null and reveal_reason is not null)
  ),

  -- 引き直しフラグと回数の整合。片方だけ更新するバグを止める
  constraint prompts_rerolled_matches_count check (
    was_rerolled = (reroll_count > 0)
  ),

  -- status と日時の整合
  constraint prompts_status_timestamps check (
    (status = 'active'    and submitted_at is null     and abandoned_at is null)
    or
    (status = 'submitted' and submitted_at is not null and abandoned_at is null)
    or
    (status = 'abandoned' and abandoned_at is not null and submitted_at is null)
  ),

  -- 日時の前後関係
  constraint prompts_revealed_after_created check (
    candidates_revealed_at is null or candidates_revealed_at >= created_at
  ),
  constraint prompts_submitted_after_created check (
    submitted_at is null or submitted_at >= created_at
  ),
  constraint prompts_abandoned_after_created check (
    abandoned_at is null or abandoned_at >= created_at
  )
);

comment on table public.prompts is
  '確定したお題。答えは prompt_cards 側にあるため、この表は本人が読んでも安全。';
comment on column public.prompts.draft_session_id is
  'null 許容かつ UNIQUE。1ドラフト1お題を保証しつつ、ドラフト削除後の null を許す。';
comment on column public.prompts.status is
  '表示・進行管理用の派生状態。1お題1作品の保証は works.prompt_id の UNIQUE が担う。';

-- 「自分が発行したお題の一覧」を引くため
create index prompts_created_by_idx
  on public.prompts (created_by);

-- Step 16 の掃除（公開前必須課題 P4）で孤児のお題を抽出するため。
-- created_by が null の行だけを対象にした部分インデックス。
create index prompts_orphan_cleanup_idx
  on public.prompts (status)
  where created_by is null;


-- ----------------------------------------------------------------------------
-- 2. prompt_cards ／ お題を構成する確定カード【機密】
-- ----------------------------------------------------------------------------
--
-- 選ばれたタグ。**これがクイズの答えそのもの**。
-- 権限もポリシーも与えない。

create table public.prompt_cards (
  id bigint generated always as identity primary key,

  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 確定時点の枠の提示順の写し。
  -- draft_mode_slots の並び順は将来変更され得るため、写しが無いと
  -- 後からお題カードを表示したときに当時と違う順番になる。
  slot_order int not null
    constraint prompt_cards_slot_order_positive check (slot_order >= 1),

  -- 【機密】答えそのもの。
  -- 一度でも使われたタグは削除できない（restrict）。
  -- やめたいタグは行を消さず tags.is_active = false にする。
  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  created_at timestamptz not null default now(),

  -- 1つの枠に答えは1つだけ
  constraint prompt_cards_slot_unique unique (prompt_id, card_slot_key),

  -- 枠の順番が重複しない
  constraint prompt_cards_order_unique unique (prompt_id, slot_order),

  -- 同じお題に同じタグが2回出ない。
  -- draft_candidates の「同一世代でタグ重複なし」の確定版。
  -- モチーフAとモチーフBが両方「傘」になる事故を、確定後の表でも防ぐ。
  constraint prompt_cards_tag_unique unique (prompt_id, tag_id)
);

comment on table public.prompt_cards is
  'お題の確定カード【機密】。クイズの答えそのもの。RPC 経由でのみ読む。';
comment on column public.prompt_cards.tag_id is
  '【機密】クイズの正解に直結する。クライアントへ直接渡らない。';


-- ----------------------------------------------------------------------------
-- 3. quiz_questions ／ 出題される問【機密】
-- ----------------------------------------------------------------------------
--
-- 「このお題の1問目はモチーフAを問う」という情報。
--
-- 機密にしている理由（D20）:
--   ・prompt_id を含むため、公開すると作品からお題へ辿る経路になり得る
--   ・「どのお題のどの枠が出題されているか」自体が推測材料になる
--   ・クライアントは get_work_quiz(work_id) だけを使うので直接読む必要がない
--
-- 注: position は PostgreSQL のキーワードだが、列名としては問題なく使える
--     （関数形 position(a in b) と混同されるのは括弧が続く場合のみ）。

create table public.quiz_questions (
  id bigint generated always as identity primary key,

  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 出題順。0 始まり。上限はモードの quiz_question_count（MVPは3問）だが、
  -- 別表を見ないと判定できないため、ここでは形式的な範囲だけを見る。
  position int not null
    constraint quiz_questions_position_range check (position between 0 and 9),

  created_at timestamptz not null default now(),

  -- 出題順が重複しない
  constraint quiz_questions_position_unique unique (prompt_id, position),

  -- 同じ枠から2問出さない
  constraint quiz_questions_slot_unique unique (prompt_id, card_slot_key)
);

comment on table public.quiz_questions is
  '出題される問【機密】。prompt_id を含むため公開しない。';


-- ----------------------------------------------------------------------------
-- 4. quiz_choices ／ 各問の4択と正解の印【機密】
-- ----------------------------------------------------------------------------
--
-- 1問につき4行。そのうち1行の is_correct が true。
-- 選択肢の文字（tags.label）を返すのは get_work_quiz RPC の仕事で、
-- そのとき is_correct は返り値に含めない。

create table public.quiz_choices (
  id bigint generated always as identity primary key,

  question_id bigint not null
    references public.quiz_questions (id) on delete cascade on update restrict,

  -- 選択肢のタグ。誤答に使われたタグも削除できなくなる（restrict）。
  -- 過去のクイズが成立しなくなるのを防ぐため。
  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- 選択肢の並び順。4択固定なので 0〜3（A2 / D15）。
  position int not null
    constraint quiz_choices_position_range check (position between 0 and 3),

  -- 【機密】正解の印。
  is_correct boolean not null default false,

  created_at timestamptz not null default now(),

  -- 並び順が重複しない
  constraint quiz_choices_position_unique unique (question_id, position),

  -- 同じ選択肢が2回出ない
  constraint quiz_choices_tag_unique unique (question_id, tag_id)
);

comment on table public.quiz_choices is
  '各問の4択と正解の印【機密】。is_correct は RPC の返り値にも含めない。';
comment on column public.quiz_choices.is_correct is
  '【機密】部分UNIQUE で保証できるのは「最大1件」まで。'
  '「必ず1件」は complete_draft RPC が保証する。';

-- 正解は **最大** 1件。
--
-- 【重要】この索引は「正解が2件以上」は防ぐが、
--         「正解が0件」は防げない。0件の問題は DB を通ってしまう。
--         正解がちょうど1件存在することは Step 5 の complete_draft が保証し、
--         Step 3E の診断（末尾の検出クエリ）で壊れていないかを継続確認する。
create unique index quiz_choices_one_correct_idx
  on public.quiz_choices (question_id)
  where is_correct;


-- ----------------------------------------------------------------------------
-- 5. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- prompts        … 本人の行だけ SELECT できる
-- 機密3表        … ポリシーを1つも作らない（完全遮断）
--
-- 機密3表は権限も与えていないため、実際には RLS が働く前に権限エラーで止まる。
-- それでも RLS を有効にしておくのは、将来うっかり grant を足したときの保険。

alter table public.prompts        enable row level security;
alter table public.prompt_cards   enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_choices   enable row level security;

-- 本人のお題だけ読める。
-- created_by が null（作成者が削除された）の行は、この条件が真にならないため
-- 誰からも見えなくなる。エラーではなく 0 件。
create policy prompts_select_own
  on public.prompts
  for select
  to authenticated
  using ((select auth.uid()) = created_by);

-- prompts の INSERT / UPDATE / DELETE ポリシーは作らない。
-- prompt_cards / quiz_questions / quiz_choices のポリシーは1つも作らない。


-- ----------------------------------------------------------------------------
-- 6. 列単位の権限
-- ----------------------------------------------------------------------------

revoke all on public.prompts        from anon, authenticated;
revoke all on public.prompt_cards   from anon, authenticated;
revoke all on public.quiz_questions from anon, authenticated;
revoke all on public.quiz_choices   from anon, authenticated;

-- prompts: サインイン済みの利用者に、答えに関係しない8列だけ。
--   draft_session_id … ドラフトとの紐付けは内部情報
--   created_by       … RLS の条件に使うが値は見せない
--   reveal_reason    … 開示の理由は内部情報
--   submitted_at     … 掃除と診断の基準
--   abandoned_at     … 同上
grant select (
  id,
  mode_key,
  time_limit_seconds,
  was_rerolled,
  reroll_count,
  status,
  candidates_revealed_at,
  created_at
) on public.prompts to authenticated;

-- anon には何も与えない（grant 文を書かない）。
-- prompt_cards / quiz_questions / quiz_choices には誰にも何も与えない。


commit;


-- ============================================================================
-- Step 3E の必須診断（新規論点A）
-- ============================================================================
--
-- DB の制約では防げない壊れ方を検出する。
-- Step 3E の横断診断ページ、および運用中の定期確認に組み込む。
-- **4つとも 0 行であることが正常**。
--
-- ① 正解がちょうど1件でない問題（0件 または 2件以上）
--    → 0件の問題は回答者が必ず不正解になり、正答率の統計が汚染される
-- select q.id as question_id, q.prompt_id, count(c.id) filter (where c.is_correct) as correct_count
--   from public.quiz_questions q
--   left join public.quiz_choices c on c.question_id = q.id
--  group by q.id, q.prompt_id
-- having count(c.id) filter (where c.is_correct) <> 1;
--
-- ② 選択肢が4件でない問題
-- select q.id as question_id, q.prompt_id, count(c.id) as choice_count
--   from public.quiz_questions q
--   left join public.quiz_choices c on c.question_id = q.id
--  group by q.id, q.prompt_id
-- having count(c.id) <> 4;
--
-- ③ 正解タグが prompt_cards の答えと一致しない問題
--    → 「その枠の答え」と「正解の印が付いた選択肢」がずれている
-- select q.id as question_id, q.prompt_id, q.card_slot_key,
--        pc.tag_id as answer_tag, c.tag_id as marked_correct_tag
--   from public.quiz_questions q
--   join public.quiz_choices c
--     on c.question_id = q.id and c.is_correct
--   left join public.prompt_cards pc
--     on pc.prompt_id = q.prompt_id and pc.card_slot_key = q.card_slot_key
--  where pc.tag_id is distinct from c.tag_id;
--
-- ④ prompt_cards の件数がモードの枠数と一致しないお題
-- select p.id as prompt_id, p.mode_key,
--        count(pc.id) as card_count,
--        (select count(*) from public.draft_mode_slots s
--          where s.mode_key = p.mode_key) as expected_count
--   from public.prompts p
--   left join public.prompt_cards pc on pc.prompt_id = p.id
--  group by p.id, p.mode_key
-- having count(pc.id) <> (select count(*) from public.draft_mode_slots s
--                          where s.mode_key = p.mode_key);
--
-- ⑤ status = 'submitted' なのに作品が存在しないお題（3B-3a 実行後に有効）
--    → 通常の掃除では消さず、この診断で検出する（P4）
-- select id, mode_key, submitted_at from public.prompts
--  where status = 'submitted'
--    and not exists (select 1 from public.works w where w.prompt_id = prompts.id);


-- ============================================================================
-- 確認用クエリ（実行は任意。SQL Editor に貼って結果を見る）
-- ============================================================================
--
-- ① 4表ができていて、すべて 0 行であること
-- select 'prompts' as t, count(*) from public.prompts
-- union all select 'prompt_cards',   count(*) from public.prompt_cards
-- union all select 'quiz_questions', count(*) from public.quiz_questions
-- union all select 'quiz_choices',   count(*) from public.quiz_choices;
--
--
-- ② ポリシーが1件（prompts の SELECT）だけであること。
--    機密3表の行が出てきたら設定ミス。
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public'
--    and tablename in ('prompts','prompt_cards','quiz_questions','quiz_choices')
--  order by tablename;
--
--
-- ③ 4表とも RLS が有効であること（rowsecurity = true が4件）
-- select relname, relrowsecurity from pg_class
--  where relname in ('prompts','prompt_cards','quiz_questions','quiz_choices');
--
--
-- ④ 【最重要】機密3表が誰からも読めないこと。
--    6つとも permission denied が正しい。0 件が返ったら設定ミス。
-- begin;
--   set local role anon;
--   select * from public.prompt_cards;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.prompt_cards;
-- rollback;
--
-- begin;
--   set local role anon;
--   select * from public.quiz_questions;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.quiz_questions;
-- rollback;
--
-- begin;
--   set local role anon;
--   select * from public.quiz_choices;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.quiz_choices;
-- rollback;
--
--
-- ⑤ anon は prompts も読めないこと（permission denied が正しい）
-- begin;
--   set local role anon;
--   select id, status from public.prompts;
-- rollback;
--
--
-- ⑥ authenticated は列を指定すれば読めること（0 件が返る。エラーにならない）
-- begin;
--   set local role authenticated;
--   select id, mode_key, status from public.prompts;   -- → 0 件
-- rollback;
--
--
-- ⑦ authenticated でも非公開列は読めないこと（3つとも permission denied）
-- begin;
--   set local role authenticated;
--   select created_by from public.prompts;
-- rollback;
-- begin;
--   set local role authenticated;
--   select draft_session_id from public.prompts;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.prompts;   -- * は非公開列を含むので拒否される
-- rollback;
--
--
-- ⑧ 【重要】本人だけが自分のお題を読めること（D34 の方式）。
--    (a) が 1、(b) が 0 なら RLS が正しく働いている。
-- begin;
--   insert into public.prompts (id, created_by, mode_key, time_limit_seconds)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy', 3600
--     from public.profiles order by created_at limit 1;
--
--   -- (a) 本人になりきる
--   select set_config(
--     'request.jwt.claim.sub',
--     (select created_by::text from public.prompts
--       where id = '33333333-3333-3333-3333-333333333333'),
--     true
--   );
--   set local role authenticated;
--   select count(id) as own_rows from public.prompts;      -- → 1 が正しい
--   reset role;
--
--   -- (b) 別人になりきる
--   select set_config(
--     'request.jwt.claim.sub',
--     '99999999-9999-9999-9999-999999999999',
--     true
--   );
--   set local role authenticated;
--   select count(id) as other_rows from public.prompts;    -- → 0 が正しい
-- rollback;
--
--
-- ⑨ 作成者が消えたお題が誰からも見えなくなること。
--    created_by を null にすると、本人でも 0 件になる。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   select set_config(
--     'request.jwt.claim.sub',
--     (select created_by::text from public.prompts
--       where id = '33333333-3333-3333-3333-333333333333'),
--     true
--   );
--
--   update public.prompts set created_by = null
--    where id = '33333333-3333-3333-3333-333333333333';
--
--   set local role authenticated;
--   select count(id) as visible from public.prompts;       -- → 0 が正しい
-- rollback;
--
--
-- ⑩ 1つのドラフトから2つのお題を作れないこと。
--    2件目で unique 違反が出るのが正しい。
--    （draft_sessions に行が無い環境では ⑩ は飛ばしてよい）
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '44444444-4444-4444-4444-444444444444', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333',
--          '44444444-4444-4444-4444-444444444444', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '55555555-5555-5555-5555-555555555555',
--          '44444444-4444-4444-4444-444444444444', id, 'easy'
--     from public.profiles order by created_at limit 1;
--   -- → ERROR: duplicate key value violates unique constraint
--   --           "prompts_draft_session_id_key"
-- rollback;
--
--
-- ⑪ draft_session_id が null のお題は何件でも作れること（⑩の裏返し）。
--    2件とも成功するのが正しい。
-- begin;
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', null, id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '55555555-5555-5555-5555-555555555555', null, id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   select count(*) as both_inserted from public.prompts
--    where id in ('33333333-3333-3333-3333-333333333333',
--                 '55555555-5555-5555-5555-555555555555');
--   -- → 2 が正しい
-- rollback;
--
--
-- ⑫ 状態と日時の整合が守られること。
--    「submitted にしたのに submitted_at を入れない」更新が拒否される。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   update public.prompts set status = 'submitted'
--    where id = '33333333-3333-3333-3333-333333333333';
--   -- → ERROR: violates check constraint "prompts_status_timestamps"
-- rollback;
--
--
-- ⑬ 開示日時と理由がセットであること。
--    片方だけ入れる更新が拒否される。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   update public.prompts set candidates_revealed_at = now()
--    where id = '33333333-3333-3333-3333-333333333333';
--   -- → ERROR: violates check constraint "prompts_reveal_pair"
-- rollback;
--
--
-- ⑭ 1問に正解を2件付けられないこと。
--    2件目の insert で unique 違反が出るのが正しい。
--    （tags が 0 行の間は実行できないので、3D 実行後に試す）
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.quiz_questions (id, prompt_id, card_slot_key, position)
--   overriding system value
--   values (999999, '33333333-3333-3333-3333-333333333333', 'motif_a', 0);
--
--   insert into public.quiz_choices (question_id, tag_id, position, is_correct)
--   select 999999, id, 0, true from public.tags limit 1;
--
--   insert into public.quiz_choices (question_id, tag_id, position, is_correct)
--   select 999999, id, 1, true from public.tags offset 1 limit 1;
--   -- → ERROR: duplicate key value violates unique constraint
--   --           "quiz_choices_one_correct_idx"
-- rollback;
--
--
-- ⑮ 列権限の一覧（anon の行が1件も出ないこと）
-- select
--   grantee,
--   table_name,
--   privilege_type,
--   string_agg(column_name, ', ' order by column_name) as columns
-- from information_schema.column_privileges
-- where table_schema = 'public'
--   and table_name in ('prompts','prompt_cards','quiz_questions','quiz_choices')
--   and grantee in ('anon', 'authenticated')
-- group by grantee, table_name, privilege_type
-- order by grantee, table_name, privilege_type;
--
--    期待される結果は1行だけ:
--      authenticated | prompts | SELECT | candidates_revealed_at, created_at,
--                      id, mode_key, reroll_count, status,
--                      time_limit_seconds, was_rerolled
--    anon の行、機密3表の行、INSERT/UPDATE/DELETE の行が
--    1件でも出たら設定ミス。
