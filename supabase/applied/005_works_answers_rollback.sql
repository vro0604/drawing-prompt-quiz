-- ============================================================================
-- 005_works_answers_rollback.sql ／ 005_works_answers.sql を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3B-3a のデータベース側の変更をやり直したい／
--   Step 3B-2b 完了時点（12表）の状態に戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → この中身を貼り付けて Run
--
-- 【消えるもの】
--   ・works / answers / answer_items /
--     work_slot_stats / user_stats / user_slot_stats（表と全データ）
--   ・6表の RLS ポリシー・列権限・インデックス（表と一緒に消える）
--
-- 【消えないもの】
--   ・profiles と Step 2 のゲスト発行の仕組み
--   ・マスタ5表とその28行
--   ・ドラフト2表（draft_sessions / draft_candidates）と
--     updated_at 自動更新のトリガー・関数
--   ・お題クイズ4表（prompts / prompt_cards / quiz_questions / quiz_choices）
--   ・すでに発行されたユーザー（auth.users の行）
--   → 既存12表はこの6表を参照していないため、消しても無傷。
--     逆向きの参照（works → prompts / profiles、
--     answer_items → quiz_questions / card_slots / tags など）は、
--     参照している側を消すので問題にならない。
--
-- 【この工程では関数を作っていない】
--   005_works_answers.sql は関数もトリガーも作らないため、消すものは表だけ。
--   集計を更新するトリガーは Step 9 で作る（論点4-A）。
--
-- 【削除の順序】
--   参照している側から先に消す。
--
--     answer_items      ← answers / quiz_questions を参照
--       ↓
--     answers           ← works を参照
--       ↓
--     work_slot_stats   ← works を参照
--       ↓
--     works             ← 参照されなくなってから
--       ↓
--     user_slot_stats   ← profiles だけを参照（順不同でよいが最後にまとめる）
--     user_stats
--
--   全体が begin / commit で囲まれているため、途中で失敗すれば
--   何も消えずに巻き戻る。中途半端に一部だけ消えることはない。
--
--   if exists を付けてあるので、対象が無くてもエラーにならない。
--
-- 【注意：3B-3b 実行後にこれを流す場合】
--   likes / saves / reports が works を参照するようになるため、
--   先に 006 の取り消しを実行しないと、works の削除が拒否される。
--   （逆に言えば、いいねや通報が残ったまま作品だけを消す事故は起きない）
--
-- ============================================================================


begin;

-- 1. 回答の内訳【機密】
drop table if exists public.answer_items;

-- 2. 回答
drop table if exists public.answers;

-- 3. 作品×枠の集計
drop table if exists public.work_slot_stats;

-- 4. 投稿作品
drop table if exists public.works;

-- 5. 回答者×枠の成績
drop table if exists public.user_slot_stats;

-- 6. 回答者の通算成績
drop table if exists public.user_stats;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 6表が消えていること（0 行が返れば成功）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('works','answers','answer_items',
--                      'work_slot_stats','user_stats','user_slot_stats');
--
-- ② 既存12表が無事であること（12 行返る）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('profiles','tag_pools','card_slots','draft_modes',
--                      'draft_mode_slots','tags','draft_sessions',
--                      'draft_candidates','prompts','prompt_cards',
--                      'quiz_questions','quiz_choices')
--  order by tablename;
--
-- ③ ドラフトの updated_at 関数が無事であること（1 行返る）
-- select proname from pg_proc where proname = 'draft_sessions_set_updated_at';
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
