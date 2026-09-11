-- ============================================================================
-- 20260910210000_touch_session_as_owner.sql
--   引きかけのお題の「最後にさわった時刻」を書き直す引き金を、
--   表の持ち主の資格で走らせる
-- ============================================================================
--
-- 【何が起きたか】
--   利用者を正規の経路（Supabase Auth の管理API）で消すと、
--   引きかけのお題を持っている人だけが必ず失敗する。
--
--     HTTP 500 {"code":500,"error_code":"unexpected_failure",
--               "msg":"Database error deleting user"}
--
--   本番の Postgres ログに出ていた本当の中身（実測 2026-09-10T14:36:46Z）:
--
--     user_name : supabase_auth_admin
--     query     : DELETE FROM "users" AS users WHERE users.id = $1
--     sqlstate  : 42501
--     message   : permission denied for table draft_sessions
--     context   : SQL statement "update public.draft_sessions ds
--                    set last_activity_at = clock_timestamp()
--                  where ds.id = v_id and ds.status = 'in_progress'"
--                 PL/pgSQL function public.draft_candidates_touch_session()
--                 line 5 at SQL statement
--
--   検査用の利用者 317 人を消したとき、198 人は通り 119 人が落ちた。
--   落ちた 119 人は全員 draft_candidates の行を持っていた（実測）。
--
-- 【なぜ起きるか（値がどこからどこへ渡るか）】
--   auth.users を1行消すと、外部キーの後始末が次の順に走る。
--
--     auth.users
--       → public.profiles            （持ち主が消えたら一緒に消す）
--         → public.draft_sessions    （同上）
--           → public.draft_candidates（同上）
--
--   Postgres は、この後始末そのものは「消される側の表の持ち主」の資格で
--   実行する。だから profiles も draft_sessions も draft_candidates も、
--   postgres の資格で消える。
--
--   ところが draft_candidates には AFTER 行トリガーが付いていて、
--   これは**文が終わったあとにまとめて実行される。**そのときには
--   持ち主への切り替えが解けていて、資格は呼び出し元のものに戻っている。
--   呼び出し元は認証サービス（supabase_auth_admin）で、public スキーマの
--   表には1つも権限を持っていない（実測: role_table_grants に0行）。
--   その資格で draft_sessions を書き直そうとして断られる。
--
--   同じ形の AFTER トリガーは他に2つあるが（likes と saves の数え直し）、
--   どちらも SECURITY DEFINER なので断られない。
--   draft_candidates のこれだけが、そう書かれていなかった。
--
-- 【手元で確かめたこと（実測）】
--   PostgreSQL 17.5 に migration を全部当て、public に権限の無い役を作って
--   auth.users を消した。
--     引きかけのお題がある人  … 断られた（本番と同じ 42501・同じ context）
--     引きかけのお題が無い人  … 通った
--     この migration を当てたあと … どちらも通った
--
--   PostgreSQL 18 では、直す前でも断られない（AFTER トリガーの資格の
--   扱いが変わっている）。**手元の既定の検査用DBは 18 なので、
--   この不具合は手元では出ない。**本番は 17.6。
--
-- 【誰に影響するか】
--   退会（start_account_deletion）は、auth.users を消す前に
--   draft_sessions を自分で消しているので、この経路には当たらない。
--   当たるのは、下ごしらえ無しに管理APIで消す経路2つ。
--     ・使われていないゲストの掃除（日次。src/features/cleanup/run.ts）
--     ・検査用利用者の片づけ（scripts/_smoke-users.mjs）
--   ゲストの掃除は、いまのところ対象が0人なので表に出ていない。
--   ただし匿名の利用者24人のうち16人が draft_candidates を持っている（実測）。
--
-- 【この migration がすること】
--   関数の中身は1行も変えない。実行資格だけを、表の持ち主のものにする。
--   アプリの通常の経路（SECURITY DEFINER の RPC か service_role）は
--   もともと持ち主か service_role の資格で動いているので、動きは変わらない。
--   anon と authenticated は draft_sessions / draft_candidates に
--   1つも権限を持っていないため（実測）、この2つの表を直に触る経路は無い。
-- ============================================================================

alter function public.draft_candidates_touch_session() security definer;


-- ----------------------------------------------------------------------------
-- 投入の検証
-- ----------------------------------------------------------------------------

do $$
declare
  v_secdef  boolean;
  v_owner   text;
  v_path    text[];
begin
  select p.prosecdef, p.proowner::regrole::text, p.proconfig
    into v_secdef, v_owner, v_path
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'draft_candidates_touch_session';

  if v_secdef is null then
    raise exception 'TOUCH_SESSION_MISSING: 関数が見つかりません';
  end if;

  if not v_secdef then
    raise exception 'TOUCH_SESSION_NOT_SECDEF: 実行資格が切り替わっていません';
  end if;

  -- SECURITY DEFINER にするなら search_path が固定されていること。
  -- 固定されていないと、呼び出し側の search_path で別の表を掴まされうる。
  if v_path is null
     or not exists (select 1 from unnest(v_path) c where c in ('search_path=', 'search_path=""')) then
    raise exception 'TOUCH_SESSION_NO_SEARCH_PATH: search_path が空に固定されていません（%）', v_path;
  end if;

  raise notice '引きかけのお題の時刻更新を、% の資格で走らせます', v_owner;
end $$;


-- ============================================================================
-- 逆にする手順（rollback）
-- ============================================================================
--   alter function public.draft_candidates_touch_session() security invoker;
--
--   戻すと、認証サービスからの利用者削除がまた断られる状態に戻る。
