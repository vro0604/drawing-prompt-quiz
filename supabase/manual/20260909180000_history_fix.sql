-- ============================================================================
-- 20260909180000_history_fix.sql ／ 履歴表の1行だけを、手元のファイルどおりに直す
-- ============================================================================
--
-- 【何を直すか】
--   supabase_migrations.schema_migrations の version = 20260909180000 の行は、
--   name が billing_founding_creator_v0・statements が106文（古い課金の下書き）に
--   なっている。実際にその版で入っているのは profile_rpc_revoke_anon の効き目。
--   この SQL は、その1行の name と statements を、
--   supabase/migrations/20260909180000_profile_rpc_revoke_anon.sql を
--   CLI（2.111.0）が記録するときと1文字も違わない値へ書き換える。
--
-- 【触らないもの】
--   表・関数・権限・データ・ほかの66行。スキーマを変える文は1つも無い。
--
-- 【直接実行しない】
--   node scripts/db-history-0909.mjs fix から流す。前後の読み取り確認がそちらにある。
--   経緯と実測は docs/history-20260909180000.md。
--
-- 【値の出どころ】
--   新しい name / statements … 使い捨ての PostgreSQL 17.6 へ CLI の db push で
--   67本を当てたときに CLI が書いた行をそのまま文字列にした（手で写していない）。
--   md5 の値 … 本番（2026-09-17 読み取り）と使い捨て DB で同じ値を確かめた。
-- ============================================================================

-- CASE C: 履歴の1行を、手元のファイルを CLI が記録するのと同じ name / statements に書き換える
-- 対象: supabase_migrations.schema_migrations の version='20260909180000' の1行だけ。
-- 前提が1つでも違えば例外で止まり、何も変わらない（1トランザクション）。
begin;
set local lock_timeout = '4s';
set local statement_timeout = '30s';
do $check$
declare v_n int; v_total int;
begin
  select count(*) into v_total from supabase_migrations.schema_migrations;
  if v_total <> 67 then raise exception 'STOP: 履歴が67行ではない（%）', v_total; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20260909180000' and name = 'billing_founding_creator_v0' and md5(statements::text) = 'e98153b0892a896ab75bb24860515720' and array_length(statements, 1) = 106) then
    raise exception 'STOP: 対象行が想定の状態（name=billing_founding_creator_v0 / 106文 / md5 e98153b0892a896ab75bb24860515720）ではない';
  end if;
  update supabase_migrations.schema_migrations
     set name = 'profile_rpc_revoke_anon', statements = E'{"-- ============================================================================
-- 20260909180000_profile_rpc_revoke_anon.sql
--   プロフィールの受け口4本から、未サインインの役（anon）の実行権を外す
-- ============================================================================
--
-- 【何が起きたか】
--   20260908150000（プロフィール拡張）を本番へ当てたあと、本番の検査で
--   3項目が不合格になった（実測 2026-09-09）。
--     ・本人用9本は anon から実行できない        期待 0 / 実際 1
--     ・登録ユーザー限定RPC 7本は anon から実行できない  期待 0 / 実際 3
--     ・拒否されるべき呼び出しがすべて拒否された   104 / 105
--
--   本番の権限を数えると、次の4本に anon の実行権が直接付いていた。
--     get_my_specialties / set_my_specialties /
--     set_my_avatar / enqueue_my_avatar_cleanup
--
-- 【なぜ起きたか】
--   Supabase は「postgres が public スキーマに関数を作ったら、anon にも
--   実行を配る」という既定を持っている。**PUBLIC 経由ではなく anon へ直接**
--   配られるので、`revoke all ... from public` だけでは外れない。
--
--   持ち込み（art_first）の migration は `from public, anon, authenticated`
--   と3つ並べて外していた。プロフィールのぶんだけ anon を書き落としていた。
--
--   手元の検査用DB（PGlite）はこの既定を持たないため、
--   `revoke ... from public` だけでも anon には付かない。
--   **だから手元では通り、本番でだけ落ちた。**
--
-- 【実害の範囲（実測。begin … rollback の中で確かめた）】
--   get_my_specialties        … 通る。返り値は {\\"drawing\\":[],\\"viewing\\":[]}
--                               （auth.uid() が null なので、誰の行も返らない）
--   set_my_specialties        … NOT_SIGNED_IN で断られる
--   set_my_avatar             … NOT_SIGNED_IN で断られる
--   enqueue_my_avatar_cleanup … NOT_SIGNED_IN で断られる
--
--   誰かのデータが読めた・書けた形跡は無い。ただし
--   「本人用の受け口は未サインインから呼べない」という取り決めは崩れている。
--
-- 【この migration がすること】
--   4本から anon（と PUBLIC）の実行権を外し、authenticated へ配り直す。
--   関数の中身は1行も変えない。
-- ============================================================================

revoke all on function public.get_my_specialties()
  from public, anon, authenticated","grant execute on function public.get_my_specialties() to authenticated","revoke all on function public.set_my_specialties(bigint[], bigint[])
  from public, anon, authenticated","grant execute on function public.set_my_specialties(bigint[], bigint[]) to authenticated","revoke all on function public.set_my_avatar(text)
  from public, anon, authenticated","grant execute on function public.set_my_avatar(text) to authenticated","revoke all on function public.enqueue_my_avatar_cleanup(text)
  from public, anon, authenticated","grant execute on function public.enqueue_my_avatar_cleanup(text) to authenticated","-- 内部用。誰にも配らない（20260908150000 で既に外してあるが、念のため）
revoke all on function public.app_specialty_rows(uuid)
  from public, anon, authenticated","-- ----------------------------------------------------------------------------
-- 投入の検証
-- ----------------------------------------------------------------------------

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = ''public''
     and p.proname in (''get_my_specialties'', ''set_my_specialties'',
                       ''set_my_avatar'', ''enqueue_my_avatar_cleanup'',
                       ''app_specialty_rows'')
     and has_function_privilege(''anon'', p.oid, ''EXECUTE'');
  if v_bad <> 0 then
    raise exception ''ANON_STILL_HAS_EXECUTE: %'', v_bad;
  end if;

  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = ''public''
     and p.proname in (''get_my_specialties'', ''set_my_specialties'',
                       ''set_my_avatar'', ''enqueue_my_avatar_cleanup'')
     and not has_function_privilege(''authenticated'', p.oid, ''EXECUTE'');
  if v_bad <> 0 then
    raise exception ''AUTHENTICATED_LOST_EXECUTE: %'', v_bad;
  end if;

  raise notice ''プロフィール受け口の権限を直しました: anon 0本 / authenticated 4本'';
end $$","-- ============================================================================
-- 逆にする手順（rollback）
-- ============================================================================
--   grant execute on function public.get_my_specialties() to anon;
--   grant execute on function public.set_my_specialties(bigint[], bigint[]) to anon;
--   grant execute on function public.set_my_avatar(text) to anon;
--   grant execute on function public.enqueue_my_avatar_cleanup(text) to anon;
--   **戻す理由は無い。**元の状態は、そもそも意図していなかった配りかた。"}'::text[]
   where version = '20260909180000' and name = 'billing_founding_creator_v0' and md5(statements::text) = 'e98153b0892a896ab75bb24860515720';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'STOP: 更新した行が1行ではない（%）', v_n; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '20260909180000' and name = 'profile_rpc_revoke_anon' and md5(statements::text) = 'e2158bec568e70801cefdfeff057b193' and array_length(statements, 1) = 11) then
    raise exception 'STOP: 更新後の行が想定（name=profile_rpc_revoke_anon / 11文 / md5 e2158bec568e70801cefdfeff057b193）と違う';
  end if;
  select count(*) into v_total from supabase_migrations.schema_migrations;
  if v_total <> 67 then raise exception 'STOP: 更新後に履歴が67行ではない（%）', v_total; end if;
end
$check$;
commit;
