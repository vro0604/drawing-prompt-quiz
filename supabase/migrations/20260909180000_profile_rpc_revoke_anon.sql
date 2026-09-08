-- ============================================================================
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
--   get_my_specialties        … 通る。返り値は {"drawing":[],"viewing":[]}
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
  from public, anon, authenticated;
grant execute on function public.get_my_specialties() to authenticated;

revoke all on function public.set_my_specialties(bigint[], bigint[])
  from public, anon, authenticated;
grant execute on function public.set_my_specialties(bigint[], bigint[]) to authenticated;

revoke all on function public.set_my_avatar(text)
  from public, anon, authenticated;
grant execute on function public.set_my_avatar(text) to authenticated;

revoke all on function public.enqueue_my_avatar_cleanup(text)
  from public, anon, authenticated;
grant execute on function public.enqueue_my_avatar_cleanup(text) to authenticated;

-- 内部用。誰にも配らない（20260908150000 で既に外してあるが、念のため）
revoke all on function public.app_specialty_rows(uuid)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 投入の検証
-- ----------------------------------------------------------------------------

do $$
declare
  v_bad int;
begin
  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_my_specialties', 'set_my_specialties',
                       'set_my_avatar', 'enqueue_my_avatar_cleanup',
                       'app_specialty_rows')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_bad <> 0 then
    raise exception 'ANON_STILL_HAS_EXECUTE: %', v_bad;
  end if;

  select count(*) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_my_specialties', 'set_my_specialties',
                       'set_my_avatar', 'enqueue_my_avatar_cleanup')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_bad <> 0 then
    raise exception 'AUTHENTICATED_LOST_EXECUTE: %', v_bad;
  end if;

  raise notice 'プロフィール受け口の権限を直しました: anon 0本 / authenticated 4本';
end $$;


-- ============================================================================
-- 逆にする手順（rollback）
-- ============================================================================
--   grant execute on function public.get_my_specialties() to anon;
--   grant execute on function public.set_my_specialties(bigint[], bigint[]) to anon;
--   grant execute on function public.set_my_avatar(text) to anon;
--   grant execute on function public.enqueue_my_avatar_cleanup(text) to anon;
--   **戻す理由は無い。**元の状態は、そもそも意図していなかった配りかた。
