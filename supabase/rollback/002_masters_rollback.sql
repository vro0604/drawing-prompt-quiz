-- ============================================================================
-- 002_masters_rollback.sql ／ 002_masters.sql を取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 3B-1 のデータベース側の変更をやり直したい／
--   Step 3A 完了時点の状態に戻したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → この中身を貼り付けて Run
--
-- 【消えるもの】
--   ・マスタ5表と、その中の全データ（28行）
--   ・5表の RLS ポリシーと列権限（表と一緒に消える）
--   ・tags の索引（表と一緒に消える）
--
-- 【消えないもの】
--   ・profiles と、Step 2 で作ったゲスト発行のトリガー・関数
--   ・すでに発行されたユーザー（auth.users の行）
--   → Step 3B-1 で作った5表は profiles を参照しておらず、
--     profiles からも参照されていないため、互いに影響しない。
--
-- 【補助関数について】
--   002_masters.sql は関数を1つも作らないため、消す関数も無い。
--   （設計検討の途中で card_slot_in_active_mode / mode_is_active という
--     判定用関数を置く案があったが、card_slots を全件公開する方針にしたため
--     作らないことにした。もし初期の案を実行した環境があれば、
--     末尾のコメントにある文を手動で実行する。）
--
-- 【削除の順序】
--   参照している側から先に消す。逆にすると
--   「まだ使われている」と拒否される。
--
--     draft_mode_slots  ← 他から参照されていないので最初
--       ↓
--     draft_modes       ← draft_mode_slots から参照されていた
--       ↓
--     tags              ← tag_pools を参照している
--       ↓
--     card_slots        ← tag_pools を参照している
--       ↓
--     tag_pools         ← 参照されなくなってから最後
--
--   全体が begin / commit で囲まれているため、途中で失敗すれば
--   何も消えずに巻き戻る。中途半端に一部だけ消えることはない。
--
--   if exists を付けてあるので、対象が無くてもエラーにならない。
--   途中まで実行した状態から流しても問題ない。
--
-- ============================================================================


begin;

-- 1. モードの構成
drop table if exists public.draft_mode_slots;

-- 2. モード
drop table if exists public.draft_modes;

-- 3. タグ本体（3D 実行後に流すとタグが全部消えるので注意）
drop table if exists public.tags;

-- 4. お題カードの枠
drop table if exists public.card_slots;

-- 5. タグの分類
drop table if exists public.tag_pools;

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① 5表がすべて消えていること（0 行が返れば成功）
-- select tablename from pg_tables
--  where schemaname = 'public'
--    and tablename in ('tag_pools','card_slots','draft_modes',
--                      'draft_mode_slots','tags');
--
-- ② Step 2 の profiles が無事であること（profiles が1件返る）
-- select tablename from pg_tables
--  where schemaname = 'public' and tablename = 'profiles';
--
-- ③ Step 2 のトリガーが無事であること（2件返る）
-- select tgname from pg_trigger where tgrelid = 'auth.users'::regclass
--    and not tgisinternal;
--
--
-- ============================================================================
-- 参考：初期の設計案を実行した環境だけで必要な後片付け
-- ============================================================================
--
-- 002_masters.sql の現行版は関数を作らないため、通常は不要。
-- 検討段階の案（card_slots を使用中の枠だけに絞る）を実行していた場合のみ、
-- 次の2行を手動で実行する。
--
-- drop function if exists public.card_slot_in_active_mode(text);
-- drop function if exists public.mode_is_active(text);
