-- ============================================================================
-- 006_likes_saves_reports_rollback.sql ／ 006 を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3B-3b をやり直したい／Step 3B-3a 完了時点（18表）へ戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--
-- 【消えるもの】
--   ・likes / saves / reports（表と全データ）
--   ・3表の RLS 設定・インデックス（表と一緒に消える）
--
-- 【消えないもの】
--   ・既存18表とそのデータすべて
--   ・profiles / auth.users のユーザー
--   → 既存18表はこの3表を参照していないため、消しても無傷。
--     逆向きの参照（likes → works / profiles など）は
--     参照している側を消すので問題にならない。
--
-- 【この工程では関数を作っていない】
--   消すものは表だけ。likes_count / saves_count の同期トリガーは
--   Step 11 で作るので、この時点ではまだ存在しない。
--
-- 【削除の順序】
--   3表とも他から参照されていないため、順序はどれでもよい。
--   全体が begin / commit で囲まれているので、失敗すれば何も消えずに巻き戻る。
--
-- ============================================================================


begin;

drop table if exists public.reports;
drop table if exists public.saves;
drop table if exists public.likes;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 3表が消えていること（0 行が返れば成功）
-- select tablename from pg_tables
--  where schemaname = 'public' and tablename in ('likes','saves','reports');
--
-- ② 既存18表が無事であること（18 行返る）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('profiles','tag_pools','card_slots','draft_modes',
--                      'draft_mode_slots','tags','draft_sessions',
--                      'draft_candidates','prompts','prompt_cards',
--                      'quiz_questions','quiz_choices','works','answers',
--                      'answer_items','work_slot_stats','user_stats',
--                      'user_slot_stats')
--  order by tablename;
--
-- ③ マスタ行数が変わっていないこと（8 / 10 / 2 / 8 / 0）
-- select 'tag_pools' as t, count(*) from public.tag_pools
-- union all select 'card_slots',       count(*) from public.card_slots
-- union all select 'draft_modes',      count(*) from public.draft_modes
-- union all select 'draft_mode_slots', count(*) from public.draft_mode_slots
-- union all select 'tags',             count(*) from public.tags;
--
-- ④ Step 2 の profiles とトリガーが無事であること
-- select tgname from pg_trigger where tgrelid = 'auth.users'::regclass
--    and not tgisinternal;   -- → 2件返る
