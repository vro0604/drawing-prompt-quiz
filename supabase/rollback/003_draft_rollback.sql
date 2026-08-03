-- ============================================================================
-- 003_draft_rollback.sql ／ 003_draft.sql を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3B-2a のデータベース側の変更をやり直したい／
--   Step 3B-1 完了時点の状態に戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → この中身を貼り付けて Run
--
-- 【消えるもの】
--   ・draft_sessions と draft_candidates（表と全データ）
--   ・両表の RLS ポリシー・列権限・インデックス（表と一緒に消える）
--   ・updated_at 自動更新のトリガーと関数
--
-- 【消えないもの】
--   ・profiles と Step 2 のゲスト発行の仕組み
--   ・マスタ5表（tag_pools / card_slots / draft_modes /
--     draft_mode_slots / tags）とその28行
--   ・すでに発行されたユーザー（auth.users の行）
--   → マスタ5表はこの2表を参照していないため、消しても無傷。
--     逆向きの参照（draft_sessions → draft_modes 等）は、
--     参照している側を消すので問題にならない。
--
-- 【削除の順序】
--   参照している側から先に消す。
--
--     draft_candidates  ← draft_sessions を参照しているので最初
--       ↓
--     draft_sessions    ← 表を消すとトリガーも一緒に消える
--       ↓
--     draft_sessions_set_updated_at()
--                       ← トリガーが消えてから関数を消す。
--                          順序を逆にすると「まだ使われている」と拒否される
--
--   全体が begin / commit で囲まれているため、途中で失敗すれば
--   何も消えずに巻き戻る。中途半端に一部だけ消えることはない。
--
--   if exists を付けてあるので、対象が無くてもエラーにならない。
--   途中まで実行した状態から流しても問題ない。
--
-- 【この関数が専用名である理由】
--   draft_sessions_set_updated_at は汎用の set_updated_at ではなく
--   表専用の名前にしてある。汎用にすると、この rollback で消したときに
--   後の工程で作る表（works など）のトリガーまで壊れる。
--   各工程が独立して戻せる状態を優先した。
--
-- ============================================================================


begin;

-- 1. 伏せカードの中身
drop table if exists public.draft_candidates;

-- 2. ドラフトの進行状態（トリガーも一緒に消える）
drop table if exists public.draft_sessions;

-- 3. updated_at 自動更新の関数
drop function if exists public.draft_sessions_set_updated_at();

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 2表が消えていること（0 行が返れば成功）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('draft_sessions','draft_candidates');
--
-- ② 関数が消えていること（0 行が返れば成功）
-- select proname from pg_proc
--  where proname = 'draft_sessions_set_updated_at';
--
-- ③ マスタ5表が無事であること（5 行返る）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('tag_pools','card_slots','draft_modes',
--                      'draft_mode_slots','tags')
--  order by tablename;
--
-- ④ マスタの行数が変わっていないこと（8 / 10 / 2 / 8 / 0）
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
