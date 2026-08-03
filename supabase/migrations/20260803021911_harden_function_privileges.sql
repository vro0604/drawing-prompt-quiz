-- ============================================================================
-- harden_function_privileges ／ 関数の実行権限を固め直す
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 今後 public スキーマに作る関数へ PUBLIC の EXECUTE が
--      自動で付かないようにする（デフォルト権限の変更）
--   2. 既存の関数24本について、引数型まで指定した正確な revoke / grant を
--      もう一度かけ直す
--
-- 【このファイルがやらないこと】
--   ・**関数を作り直さない**（create / create or replace を一切書かない）
--   ・**表・列・制約・データに触れない**
--   ・行を1つも追加・変更・削除しない
--
--   権限（GRANT / REVOKE）は関数の中身とは別に管理される情報なので、
--   中身をそのままに権限だけを変えられる。
--
--
-- 【なぜ必要か】
--
--   Postgres は `create function` のたびに、その関数の EXECUTE 権限を
--   **PUBLIC（全ロール）へ自動的に与える**。
--   007 と draft_rpcs では作成直後に revoke しているので現状は問題ないが、
--   「revoke を書き忘れた1本」が生まれた瞬間に穴が開く構造になっている。
--
--   デフォルト権限を変えておけば、書き忘れても PUBLIC には付かない。
--   守りを1枚増やす。
--
--
-- 【alter default privileges の効き方（注意点）】
--
--   この設定は「**このロールが今後作る**オブジェクト」に効く。
--   ・すでに存在する関数には遡って効かない
--     → だから下の第2節で既存24本を明示的にかけ直す
--   ・別のロールが作った関数には効かない
--     → マイグレーションは常に同じロール（postgres）で実行されるので問題ない
--
--
-- 【権限の設計（変更なし。ここで固定するだけ）】
--
--   区分            PUBLIC  anon  authenticated
--   --------------  ------  ----  -------------
--   公開RPC 4本       ×      ○         ○
--   本人用RPC 9本     ×      ×         ○
--   ドラフト6本       ×      ×         ○
--   内部ヘルパー2本   ×      ×         ×
--   トリガー3本       ×      ×         ×
--
--   トリガー関数は誰からも呼べなくてよい。
--   トリガーとして起動するときは、呼び出し元の EXECUTE 権限を必要としない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 今後作る関数のデフォルト権限
-- ----------------------------------------------------------------------------
--
-- これ以降 public スキーマに作られる関数には、PUBLIC の EXECUTE が付かなくなる。
-- 必要なロールへは、これまでどおり作成時に明示的に grant する。

alter default privileges in schema public
  revoke execute on functions from public;


-- ----------------------------------------------------------------------------
-- 2. 既存24本をかけ直す
-- ----------------------------------------------------------------------------
--
-- 引数の型まで書くのは、同じ名前で引数違いの関数があっても
-- 取り違えないようにするため。型を省いた書き方はしない。
--
-- 何度実行しても同じ結果になる（冪等）。


-- --- 2-a. 公開RPC 4本：anon と authenticated が呼べる --------------------------

revoke all on function public.get_public_works(text, text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.get_work_detail(uuid)
  from public, anon, authenticated;
revoke all on function public.get_work_quiz(uuid)
  from public, anon, authenticated;
revoke all on function public.get_public_saves(uuid, integer, integer)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, integer, integer)
  to anon, authenticated;
grant execute on function public.get_work_detail(uuid)
  to anon, authenticated;
grant execute on function public.get_work_quiz(uuid)
  to anon, authenticated;
grant execute on function public.get_public_saves(uuid, integer, integer)
  to anon, authenticated;


-- --- 2-b. 本人用RPC 9本：authenticated のみ ------------------------------------

revoke all on function public.get_my_works(integer, integer)   from public, anon, authenticated;
revoke all on function public.get_my_work(uuid)                from public, anon, authenticated;
revoke all on function public.get_my_prompts(integer, integer) from public, anon, authenticated;
revoke all on function public.get_my_prompt(uuid)              from public, anon, authenticated;
revoke all on function public.get_my_answers(integer, integer) from public, anon, authenticated;
revoke all on function public.get_my_answer(uuid)              from public, anon, authenticated;
revoke all on function public.get_my_likes(integer, integer)   from public, anon, authenticated;
revoke all on function public.get_my_saves(integer, integer)   from public, anon, authenticated;
revoke all on function public.get_my_reaction(uuid)            from public, anon, authenticated;

grant execute on function public.get_my_works(integer, integer)   to authenticated;
grant execute on function public.get_my_work(uuid)                to authenticated;
grant execute on function public.get_my_prompts(integer, integer) to authenticated;
grant execute on function public.get_my_prompt(uuid)              to authenticated;
grant execute on function public.get_my_answers(integer, integer) to authenticated;
grant execute on function public.get_my_answer(uuid)              to authenticated;
grant execute on function public.get_my_likes(integer, integer)   to authenticated;
grant execute on function public.get_my_saves(integer, integer)   to authenticated;
grant execute on function public.get_my_reaction(uuid)            to authenticated;


-- --- 2-c. ドラフトRPC 6本：authenticated のみ ----------------------------------
--
-- 匿名ゲストも匿名サインイン後は authenticated になるので、ドラフトは引ける。
-- 未サインイン（anon）は引けない。

revoke all on function public.start_draft(text, integer)       from public, anon, authenticated;
revoke all on function public.reveal_card(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.reroll_draft(uuid)               from public, anon, authenticated;
revoke all on function public.complete_draft(uuid)             from public, anon, authenticated;
revoke all on function public.get_current_draft()              from public, anon, authenticated;
revoke all on function public.abandon_draft(uuid)              from public, anon, authenticated;

grant execute on function public.start_draft(text, integer)       to authenticated;
grant execute on function public.reveal_card(uuid, text, integer) to authenticated;
grant execute on function public.reroll_draft(uuid)               to authenticated;
grant execute on function public.complete_draft(uuid)             to authenticated;
grant execute on function public.get_current_draft()              to authenticated;
grant execute on function public.abandon_draft(uuid)              to authenticated;


-- --- 2-d. 内部ヘルパー 2本：誰も呼べない ---------------------------------------
--
-- security definer 関数の中から呼ばれるときは、呼び出し元（postgres）の
-- 権限で動くため、外部への grant は要らない。

revoke all on function public.draft_generate_candidates(uuid, integer, text, integer)
  from public, anon, authenticated;
revoke all on function public.draft_state_json(uuid)
  from public, anon, authenticated;


-- --- 2-e. トリガー関数 3本：誰も呼べない ---------------------------------------
--
-- 001 / 003 でも revoke 済みだが、24本すべてを1か所で見渡せるように再掲する。

revoke all on function public.handle_new_user()
  from public, anon, authenticated;
revoke all on function public.sync_profile_anonymous_flag()
  from public, anon, authenticated;
revoke all on function public.draft_sessions_set_updated_at()
  from public, anon, authenticated;
