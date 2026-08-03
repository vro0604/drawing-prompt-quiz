-- ============================================================================
-- 008_draft_rpcs_rollback.sql ／ draft_rpcs マイグレーションを取り消す
-- ============================================================================
--
-- 【使うとき】
--   Step 4（最小タグ＋ドラフトRPC）をやり直したいとき。
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 貼り付けて Run
--   （取り消しは CLI では流さない。db push は「前へ進む」ためのものなので、
--     戻す操作は意図を持って手で行う）
--
-- 【消えるもの】
--   ・ドラフトRPC 6本と内部ヘルパー2本
--   ・**最小タグ46件**（下の注意を読むこと）
--
-- 【消えないもの】
--   ・全21表とその構造
--   ・001〜007 で作った関数・ポリシー・権限
--   ・マスタ28行（tag_pools / card_slots / draft_modes / draft_mode_slots）
--
-- ============================================================================
-- 【重要な注意】タグを消せない場合がある
-- ============================================================================
--
--   draft_candidates / prompt_cards / quiz_choices / answer_items は
--   tags を ON DELETE RESTRICT で参照している。
--
--   一度でもドラフトを引いていると、そのタグは**削除が拒否される**。
--   その場合このファイル全体が巻き戻り、何も消えない（安全側の動作）。
--
--   タグを本当に消したいときは、先に該当するドラフトとお題を消す必要がある。
--   それはデータの削除にあたるため、このファイルには含めない。
--
--   関数だけを消したい場合は、下の「2. 関数」だけを実行すればよい。
--
-- ============================================================================


begin;

-- --- 1. 関数（先に消す。タグを参照しているため）-----------------------------

drop function if exists public.abandon_draft(uuid);
drop function if exists public.get_current_draft();
drop function if exists public.complete_draft(uuid);
drop function if exists public.reroll_draft(uuid);
drop function if exists public.reveal_card(uuid, text, int);
drop function if exists public.start_draft(text, int);
drop function if exists public.draft_state_json(uuid);
drop function if exists public.draft_generate_candidates(uuid, int, text, int);


-- --- 2. 最小タグ46件 --------------------------------------------------------
--
-- どこからも参照されていないタグだけを消す。
-- 参照されているタグが1つでもあれば RESTRICT で失敗し、全体が巻き戻る。

delete from public.tags t
 where t.pool_key in ('motif', 'color', 'species', 'genre')
   and not exists (select 1 from public.draft_candidates dc where dc.tag_id = t.id)
   and not exists (select 1 from public.prompt_cards   pc where pc.tag_id = t.id)
   and not exists (select 1 from public.quiz_choices   qc where qc.tag_id = t.id)
   and not exists (select 1 from public.answer_items   ai where ai.selected_tag_id = t.id);

commit;


-- ============================================================================
-- 確認用（実行は任意）
-- ============================================================================
--
-- ① ドラフトRPCが消えていること（0 行が返れば成功）
-- select proname from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('start_draft','reveal_card','reroll_draft','complete_draft',
--                      'get_current_draft','abandon_draft',
--                      'draft_state_json','draft_generate_candidates');
--
-- ② 取得系RPC 13本が無事であること（13 が返る）
-- select count(*) from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and p.proname like 'get\_%';
--
-- ③ 全21表が無事であること（21 が返る）
-- select count(*) from pg_tables where schemaname = 'public';
--
-- ④ 残っているタグ（0 なら全部消えた。残っていれば参照されている）
-- select pool_key, count(*) from public.tags group by pool_key order by pool_key;
--
-- ⑤ マスタ28行が無事であること（8 / 10 / 2 / 8）
-- select 'tag_pools' as t, count(*) from public.tag_pools
-- union all select 'card_slots',       count(*) from public.card_slots
-- union all select 'draft_modes',      count(*) from public.draft_modes
-- union all select 'draft_mode_slots', count(*) from public.draft_mode_slots;
