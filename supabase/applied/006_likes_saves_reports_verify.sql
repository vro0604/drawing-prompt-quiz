-- ============================================================================
-- 006_likes_saves_reports_verify.sql ／ Step 3B-3b の確認クエリ
-- ============================================================================
--
-- 006_likes_saves_reports.sql を実行したあとに使う。
-- **データは1行も変わらない。**
--
-- 【使い方】
--   ブロック1 と ブロック2 を分けて実行する（2回 Run する）。
--   ブロック2 は **必ずエラーで終わる**設計で、そのエラー文が結果表示になる。
--
-- ============================================================================


-- ============================================================================
-- ブロック1 ／ 表・行数・RLS・ポリシー・権限・既存18表（全部貼って Run）
-- ============================================================================
--
-- 【判定】result 列がすべて OK であること。

select * from (

  -- C-1. 3表が存在し、すべて0行であること
  select 1 as seq, 'C-1 likes 0行' as item,
         case when (select count(*) from public.likes) = 0
              then 'OK' else 'NG' end as result
  union all
  select 2, 'C-1 saves 0行',
         case when (select count(*) from public.saves) = 0 then 'OK' else 'NG' end
  union all
  select 3, 'C-1 reports 0行',
         case when (select count(*) from public.reports) = 0 then 'OK' else 'NG' end

  -- C-2. 3表とも RLS が有効であること
  union all
  select 10, 'C-2 3表すべて RLS 有効',
         case when (select count(*) from pg_class
                     where relname in ('likes','saves','reports')
                       and relrowsecurity) = 3
              then 'OK' else 'NG' end

  -- C-3. ポリシーが1本も無いこと
  union all
  select 11, 'C-3 3表のポリシー 0本',
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('likes','saves','reports')) = 0
              then 'OK' else 'NG' end

  -- C-4. anon / authenticated の権限が1つも無いこと
  union all
  select 20, 'C-4 3表の表権限 0件',
         case when (select count(*) from information_schema.role_table_grants
                     where table_schema = 'public'
                       and table_name in ('likes','saves','reports')
                       and grantee in ('anon','authenticated')) = 0
              then 'OK' else 'NG' end
  union all
  select 21, 'C-4 3表の列権限 0件',
         case when (select count(*) from information_schema.column_privileges
                     where table_schema = 'public'
                       and table_name in ('likes','saves','reports')
                       and grantee in ('anon','authenticated')) = 0
              then 'OK' else 'NG' end

  -- C-5. 制約が効いていること（存在確認）
  union all
  select 30, 'C-5 reports の CHECK が5本',
         case when (select count(*) from pg_constraint
                     where conrelid = 'public.reports'::regclass
                       and contype = 'c'
                       and conname in ('reports_reason_valid','reports_status_valid',
                                       'reports_other_requires_detail',
                                       'reports_resolved_pair',
                                       'reports_resolved_after_created')) = 5
              then 'OK' else 'NG' end
  union all
  select 31, 'C-5 likes / saves の主キーが (work_id, user_id)',
         case when (select count(*) from pg_constraint
                     where conrelid in ('public.likes'::regclass, 'public.saves'::regclass)
                       and contype = 'p'
                       and array_length(conkey, 1) = 2) = 2
              then 'OK' else 'NG' end

  -- C-6. 既存18表が無傷であること
  union all
  select 40, 'C-6 全21表がそろった',
         case when (select count(*) from pg_tables where schemaname = 'public') = 21
              then 'OK' else 'NG' end
  union all
  select 41, 'C-6 既存18表が全部ある',
         case when (select count(*) from pg_tables
                     where schemaname = 'public'
                       and tablename in ('profiles','tag_pools','card_slots','draft_modes',
                                         'draft_mode_slots','tags','draft_sessions',
                                         'draft_candidates','prompts','prompt_cards',
                                         'quiz_questions','quiz_choices','works','answers',
                                         'answer_items','work_slot_stats','user_stats',
                                         'user_slot_stats')) = 18
              then 'OK' else 'NG' end
  union all
  select 42, 'C-6 マスタ行数 8/10/2/8 のまま',
         case when (select count(*) from public.tag_pools)        = 8
               and (select count(*) from public.card_slots)       = 10
               and (select count(*) from public.draft_modes)      = 2
               and (select count(*) from public.draft_mode_slots) = 8
              then 'OK' else 'NG' end
  union all
  select 43, 'C-6 既存表のデータ 0行のまま',
         case when (select count(*) from public.works)   = 0
               and (select count(*) from public.answers) = 0
               and (select count(*) from public.prompts) = 0
              then 'OK' else 'NG' end

  -- C-7. 遮断表の総点検（21表のうち権限を持つのはどれか）
  --      期待：profiles / tag_pools / card_slots / draft_modes /
  --            draft_mode_slots / tags / draft_sessions / prompts /
  --            user_stats / user_slot_stats の10表だけ
  union all
  select 50, 'C-7 権限を持つ表が10表だけ',
         case when (select count(distinct table_name)
                      from information_schema.column_privileges
                     where table_schema = 'public'
                       and grantee in ('anon','authenticated')) = 10
              then 'OK' else 'NG' end

) t order by seq;


-- ============================================================================
-- ブロック2 ／ 遮断の実地確認（全部貼って Run）
-- ============================================================================
--
-- 【重要】このブロックは **必ずエラーで終わります。それが正常です。**
--   エラーメッセージの本文が確認結果です。
--   データは1行も変更しません。

do $$
declare
  t text;
  r text;
  v_denied int := 0;
  v_total  int := 0;
  v_bad    text := '';
begin

  -- 21表のうち「誰にも読ませない」11表すべてを一度に確認する。
  foreach t in array array[
    'draft_candidates',
    'prompt_cards', 'quiz_questions', 'quiz_choices',
    'works', 'answers', 'answer_items', 'work_slot_stats',
    'likes', 'saves', 'reports'
  ] loop
    foreach r in array array['anon','authenticated'] loop
      v_total := v_total + 1;
      begin
        execute 'set role ' || quote_ident(r);
        execute 'select 1 from public.' || quote_ident(t) || ' limit 1';
        v_bad := v_bad || format(E'\n  ★ %s が %s から読めてしまった', t, r);
      exception
        when insufficient_privilege then
          v_denied := v_denied + 1;
      end;
      execute 'reset role';
    end loop;
  end loop;

  raise exception E'\n===== Step 3B-3b 実地確認の結果 =====\n遮断11表の直接SELECT : %s / %s が permission denied%s\n\n%\n（このエラーは正常です。データは変更していません）',
    v_denied,
    v_total,
    v_bad,
    case when v_denied = v_total
         then '判定: すべて期待どおり'
         else '判定: ★の付いた行を確認してください' end;

end $$;
