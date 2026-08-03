-- ============================================================================
-- 004_prompts_quiz_rollback.sql ／ 004_prompts_quiz.sql を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3B-2b のデータベース側の変更をやり直したい／
--   Step 3B-2a 完了時点の状態に戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → この中身を貼り付けて Run
--
-- 【消えるもの】
--   ・prompts / prompt_cards / quiz_questions / quiz_choices（表と全データ）
--   ・4表の RLS ポリシー・列権限・インデックス（表と一緒に消える）
--
-- 【消えないもの】
--   ・profiles と Step 2 のゲスト発行の仕組み
--   ・マスタ5表とその28行
--   ・ドラフト2表（draft_sessions / draft_candidates）と
--     updated_at 自動更新のトリガー・関数
--   ・すでに発行されたユーザー（auth.users の行）
--   → 既存8表はこの4表を参照していないため、消しても無傷。
--     逆向きの参照（prompts → draft_sessions / profiles / draft_modes、
--     prompt_cards → card_slots / tags など）は、
--     参照している側を消すので問題にならない。
--
-- 【この工程では関数を作っていない】
--   004_prompts_quiz.sql は関数もトリガーも作らないため、消すものは表だけ。
--
-- 【削除の順序】
--   参照している側から先に消す。
--
--     quiz_choices    ← quiz_questions を参照しているので最初
--       ↓
--     quiz_questions  ← prompts を参照している
--       ↓
--     prompt_cards    ← prompts を参照している
--       ↓
--     prompts         ← 参照されなくなってから最後
--
--   全体が begin / commit で囲まれているため、途中で失敗すれば
--   何も消えずに巻き戻る。中途半端に一部だけ消えることはない。
--
--   if exists を付けてあるので、対象が無くてもエラーにならない。
--
-- 【注意：3B-3a 実行後にこれを流す場合】
--   works が prompts を参照するようになるため、
--   先に 005 の取り消しを実行しないと、prompts の削除が拒否される。
--   （逆に言えば、作品が存在する状態でお題だけを消す事故は起きない）
--
-- ============================================================================


begin;

-- 1. 各問の4択と正解の印
drop table if exists public.quiz_choices;

-- 2. 出題される問
drop table if exists public.quiz_questions;

-- 3. お題の確定カード（答え）
drop table if exists public.prompt_cards;

-- 4. 確定したお題
drop table if exists public.prompts;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 4表が消えていること（0 行が返れば成功）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('prompts','prompt_cards','quiz_questions','quiz_choices');
--
-- ② ドラフト2表が無事であること（2 行返る）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('draft_sessions','draft_candidates');
--
-- ③ ドラフトの updated_at 関数が無事であること（1 行返る）
-- select proname from pg_proc
--  where proname = 'draft_sessions_set_updated_at';
--
-- ④ マスタ5表と行数が変わっていないこと（8 / 10 / 2 / 8 / 0）
-- select 'tag_pools' as t, count(*) from public.tag_pools
-- union all select 'card_slots',       count(*) from public.card_slots
-- union all select 'draft_modes',      count(*) from public.draft_modes
-- union all select 'draft_mode_slots', count(*) from public.draft_mode_slots
-- union all select 'tags',             count(*) from public.tags;
--
-- ⑤ Step 2 の profiles とトリガーが無事であること
-- select tablename from pg_tables
--  where schemaname = 'public' and tablename = 'profiles';
-- select tgname from pg_trigger where tgrelid = 'auth.users'::regclass
--    and not tgisinternal;   -- → 2件返る
