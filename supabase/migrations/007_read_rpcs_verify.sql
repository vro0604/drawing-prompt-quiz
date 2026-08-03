-- ============================================================================
-- 007_read_rpcs_verify.sql ／ Step 3C の確認クエリ
-- ============================================================================
--
-- 007_read_rpcs.sql を実行したあとに使う。
-- **データは1行も変わらない。**
--
-- 【使い方】ブロック1 と ブロック2 を分けて実行する（2回 Run）。
--   ブロック2 は **必ずエラーで終わる**設計で、そのエラー文が結果表示になる。
--
-- ============================================================================


-- ============================================================================
-- ブロック1 ／ 関数の定義・安全設定・実行権限（全部貼って Run）
-- ============================================================================
--
-- 【判定】result 列がすべて OK であること。

select * from (

  -- C-1. 13本すべてが存在すること
  select 1 as seq, 'C-1 取得系RPC 13本が存在' as item,
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in (
                        'get_public_works','get_work_detail','get_work_quiz',
                        'get_public_saves','get_my_works','get_my_work',
                        'get_my_prompts','get_my_prompt','get_my_answers',
                        'get_my_answer','get_my_likes','get_my_saves',
                        'get_my_reaction')) = 13
              then 'OK' else 'NG' end as result

  -- C-2. 13本すべてが security definer であること
  union all
  select 2, 'C-2 13本とも security definer',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prosecdef
                      and p.proname like 'get\_%') = 13
              then 'OK' else 'NG' end

  -- C-3. 【最重要】search_path が固定されていること
  --      固定し忘れた関数は、偽テーブルを読まされる危険がある
  union all
  select 3, 'C-3 search_path 未固定の関数が0本',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public' and p.prosecdef
                      and not exists (
                        select 1 from unnest(coalesce(p.proconfig, '{}')) c
                         where c like 'search\_path=%')) = 0
              then 'OK' else 'NG' end

  -- C-4. 【最重要】PUBLIC に実行権限が残っていないこと
  --      Postgres は新しい関数の EXECUTE を自動で PUBLIC へ与えるため、
  --      revoke し忘れると誰でも呼べてしまう
  union all
  select 4, 'C-4 PUBLIC への実行権限が0件',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and (p.proacl is null
                           or array_to_string(p.proacl, ',') like '%=X/%')) = 0
              then 'OK' else 'NG' end

  -- C-5. 公開4本が anon から呼べること
  union all
  select 10, 'C-5 公開4本に anon の EXECUTE',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('get_public_works','get_work_detail',
                                        'get_work_quiz','get_public_saves')
                      and has_function_privilege('anon', p.oid, 'EXECUTE')) = 4
              then 'OK' else 'NG' end

  -- C-6. 本人用9本が anon から呼べないこと
  union all
  select 11, 'C-6 本人用9本は anon から呼べない',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname in ('get_my_works','get_my_work','get_my_prompts',
                                        'get_my_prompt','get_my_answers','get_my_answer',
                                        'get_my_likes','get_my_saves','get_my_reaction')
                      and has_function_privilege('anon', p.oid, 'EXECUTE')) = 0
              then 'OK' else 'NG' end

  -- C-7. 13本すべてが authenticated から呼べること
  union all
  select 12, 'C-7 13本とも authenticated から呼べる',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and has_function_privilege('authenticated', p.oid, 'EXECUTE')) = 13
              then 'OK' else 'NG' end

  -- C-8. 【最重要】返り値の型に prompt_id が現れないこと
  union all
  select 20, 'C-8 返り値に prompt_id が無い',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and pg_get_function_result(p.oid) ilike '%prompt_id%') = 0
              then 'OK' else 'NG' end

  -- C-9. 【最重要】JSON のキーとして prompt_id を出していないこと
  union all
  select 21, 'C-9 JSONキーに prompt_id が無い',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and p.prosrc like '%''prompt_id''%') = 0
              then 'OK' else 'NG' end

  -- C-10. 【最重要】get_work_quiz が is_correct に触れていないこと
  union all
  select 22, 'C-10 get_work_quiz が is_correct に触れない',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname = 'get_work_quiz'
                      and p.prosrc like '%is_correct%') = 0
              then 'OK' else 'NG' end

  -- C-11. どの関数も tags.weight を読んでいないこと（D21）
  union all
  select 23, 'C-11 どの関数も weight を読まない',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and p.prosrc like '%weight%') = 0
              then 'OK' else 'NG' end

  -- C-12. どの関数も select * を使っていないこと
  union all
  select 24, 'C-12 select * を使っていない',
         case when (select count(*) from pg_proc p
                     join pg_namespace n on n.oid = p.pronamespace
                    where n.nspname = 'public'
                      and p.proname like 'get\_%'
                      and p.prosrc like '%select *%') = 0
              then 'OK' else 'NG' end

  -- C-13. 表・権限・データが変わっていないこと
  union all
  select 30, 'C-13 全21表のまま',
         case when (select count(*) from pg_tables where schemaname = 'public') = 21
              then 'OK' else 'NG' end
  union all
  select 31, 'C-13 権限を持つ表は10表のまま',
         case when (select count(distinct table_name)
                      from information_schema.column_privileges
                     where table_schema = 'public'
                       and grantee in ('anon','authenticated')) = 10
              then 'OK' else 'NG' end
  union all
  select 32, 'C-13 マスタ行数 8/10/2/8 のまま',
         case when (select count(*) from public.tag_pools)        = 8
               and (select count(*) from public.card_slots)       = 10
               and (select count(*) from public.draft_modes)      = 2
               and (select count(*) from public.draft_mode_slots) = 8
              then 'OK' else 'NG' end

) t order by seq;


-- ============================================================================
-- ブロック2 ／ 実際に呼んでみる（全部貼って Run）
-- ============================================================================
--
-- 【重要】このブロックは **必ずエラーで終わります。それが正常です。**
--   エラーメッセージの本文が確認結果です。データは変更しません。
--
-- 確認する内容
--   (1) anon が公開4本を呼べて、エラーにならず空が返る
--   (2) anon が本人用9本を呼ぶと permission denied になる
--   (3) authenticated（JWTなし＝本人不明）が本人用を呼ぶと空が返る
--   (4) 遮断11表の直接SELECT は相変わらず permission denied

do $$
declare
  t text;
  r text;
  v_public_ok int := 0;
  v_denied    int := 0;
  v_my_empty  int := 0;
  v_tbl_denied int := 0;
  v_bad text := '';
  v_dummy uuid := '00000000-0000-0000-0000-000000000000';
  v_json jsonb;
  v_cnt int;
begin

  -- JWT クレームを確実に空にしておく（本人不明の状態を作る）
  perform set_config('request.jwt.claim.sub', '', false);

  -- --- (1) anon が公開4本を呼べること ---------------------------------------
  begin
    execute 'set role anon';

    select count(*) into v_cnt from public.get_public_works(null, 'new', 10, 0);
    v_public_ok := v_public_ok + 1;

    v_json := public.get_work_detail(v_dummy);
    v_public_ok := v_public_ok + 1;

    v_json := public.get_work_quiz(v_dummy);
    v_public_ok := v_public_ok + 1;

    select count(*) into v_cnt from public.get_public_saves(v_dummy, 10, 0);
    v_public_ok := v_public_ok + 1;
  exception
    when others then
      v_bad := v_bad || format(E'\n  ★ anon が公開RPCを呼べなかった: %s', sqlerrm);
  end;
  execute 'reset role';


  -- --- (2) anon が本人用9本を呼べないこと ------------------------------------
  foreach t in array array[
    'get_my_works(10,0)', 'get_my_work(''00000000-0000-0000-0000-000000000000'')',
    'get_my_prompts(10,0)', 'get_my_prompt(''00000000-0000-0000-0000-000000000000'')',
    'get_my_answers(10,0)', 'get_my_answer(''00000000-0000-0000-0000-000000000000'')',
    'get_my_likes(10,0)', 'get_my_saves(10,0)',
    'get_my_reaction(''00000000-0000-0000-0000-000000000000'')'
  ] loop
    begin
      execute 'set role anon';
      execute 'select public.' || t;
      v_bad := v_bad || format(E'\n  ★ anon が %s を呼べてしまった', t);
    exception
      when insufficient_privilege then
        v_denied := v_denied + 1;
    end;
    execute 'reset role';
  end loop;


  -- --- (3) authenticated（本人不明）が本人用を呼ぶと空が返ること --------------
  begin
    execute 'set role authenticated';

    select count(*) into v_cnt from public.get_my_works(10, 0);
    if v_cnt = 0 then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_works が空でない'; end if;

    select count(*) into v_cnt from public.get_my_prompts(10, 0);
    if v_cnt = 0 then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_prompts が空でない'; end if;

    select count(*) into v_cnt from public.get_my_answers(10, 0);
    if v_cnt = 0 then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_answers が空でない'; end if;

    select count(*) into v_cnt from public.get_my_likes(10, 0);
    if v_cnt = 0 then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_likes が空でない'; end if;

    select count(*) into v_cnt from public.get_my_saves(10, 0);
    if v_cnt = 0 then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_saves が空でない'; end if;

    if public.get_my_work(v_dummy)     is null then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_work が null でない'; end if;

    if public.get_my_prompt(v_dummy)   is null then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_prompt が null でない'; end if;

    if public.get_my_answer(v_dummy)   is null then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_answer が null でない'; end if;

    -- JWT が無いので auth.uid() は null → get_my_reaction も null
    if public.get_my_reaction(v_dummy) is null then v_my_empty := v_my_empty + 1;
    else v_bad := v_bad || E'\n  ★ get_my_reaction が null でない'; end if;

  exception
    when others then
      v_bad := v_bad || format(E'\n  ★ authenticated で本人用RPCが失敗: %s', sqlerrm);
  end;
  execute 'reset role';


  -- --- (4) 遮断11表の直接SELECT は変わらず拒否されること ----------------------
  foreach t in array array[
    'draft_candidates','prompt_cards','quiz_questions','quiz_choices',
    'works','answers','answer_items','work_slot_stats',
    'likes','saves','reports'
  ] loop
    foreach r in array array['anon','authenticated'] loop
      begin
        execute 'set role ' || quote_ident(r);
        execute 'select 1 from public.' || quote_ident(t) || ' limit 1';
        v_bad := v_bad || format(E'\n  ★ %s が %s から読めてしまった', t, r);
      exception
        when insufficient_privilege then
          v_tbl_denied := v_tbl_denied + 1;
      end;
      execute 'reset role';
    end loop;
  end loop;


  raise exception E'\n===== Step 3C 実地確認の結果 =====\n(1) anon が公開RPCを呼べた       : %s / 4\n(2) anon が本人用RPCを拒否された : %s / 9\n(3) 本人不明で本人用RPCが空だった: %s / 9\n(4) 遮断11表の直接SELECT拒否     : %s / 22%s\n\n%\n（このエラーは正常です。データは変更していません）',
    v_public_ok, v_denied, v_my_empty, v_tbl_denied, v_bad,
    case when v_public_ok = 4 and v_denied = 9 and v_my_empty = 9
              and v_tbl_denied = 22 and v_bad = ''
         then '判定: すべて期待どおり'
         else '判定: ★の付いた行を確認してください' end;

end $$;
