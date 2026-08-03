-- ============================================================================
-- 005_works_answers_verify.sql ／ Step 3B-3a の確認クエリ
-- ============================================================================
--
-- 005_works_answers.sql を実行したあとに使う。
-- **データは1行も変わらない**（ブロック2のテストデータは必ず巻き戻る）。
--
-- 【使い方】
--   ブロック1 と ブロック2 は分けて実行する（2回 Run する）。
--   ブロック2 は **必ずエラーで終わる**設計で、そのエラー文が結果表示になる。
--   1回にまとめると、ブロック1 の結果が捨てられてしまうため分けてある。
--
-- ============================================================================


-- ============================================================================
-- ブロック1 ／ 表・行数・RLS・ポリシー・権限・既存12表（そのまま全部貼って Run）
-- ============================================================================
--
-- 【判定】result 列がすべて OK であること。
--         1つでも NG があれば設定ミス。

select * from (

  -- C-1. 6表が存在し、すべて0行であること
  select 1 as seq, 'C-1 works 0行'           as item,
         case when (select count(*) from public.works) = 0
              then 'OK' else 'NG' end as result
  union all
  select 2, 'C-1 answers 0行',
         case when (select count(*) from public.answers) = 0 then 'OK' else 'NG' end
  union all
  select 3, 'C-1 answer_items 0行',
         case when (select count(*) from public.answer_items) = 0 then 'OK' else 'NG' end
  union all
  select 4, 'C-1 work_slot_stats 0行',
         case when (select count(*) from public.work_slot_stats) = 0 then 'OK' else 'NG' end
  union all
  select 5, 'C-1 user_stats 0行',
         case when (select count(*) from public.user_stats) = 0 then 'OK' else 'NG' end
  union all
  select 6, 'C-1 user_slot_stats 0行',
         case when (select count(*) from public.user_slot_stats) = 0 then 'OK' else 'NG' end

  -- C-2. 6表とも RLS が有効であること
  union all
  select 10, 'C-2 6表すべて RLS 有効',
         case when (select count(*) from pg_class
                     where relname in ('works','answers','answer_items',
                                       'work_slot_stats','user_stats','user_slot_stats')
                       and relrowsecurity) = 6
              then 'OK' else 'NG' end

  -- C-3. 遮断する4表にポリシーが1本も無いこと
  union all
  select 11, 'C-3 遮断4表のポリシー 0本',
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('works','answers','answer_items','work_slot_stats')) = 0
              then 'OK' else 'NG' end

  -- C-4. 集計2表のポリシーが4本（各表 anon 用と authenticated 用）
  union all
  select 12, 'C-4 user_stats 系ポリシー 4本',
         case when (select count(*) from pg_policies
                     where schemaname = 'public'
                       and tablename in ('user_stats','user_slot_stats')) = 4
              then 'OK' else 'NG' end

  -- C-5. 遮断する4表に anon / authenticated の権限が1つも無いこと
  --      （権限が無い＝直接触ると permission denied。D31）
  union all
  select 20, 'C-5 遮断4表の表権限 0件',
         case when (select count(*) from information_schema.role_table_grants
                     where table_schema = 'public'
                       and table_name in ('works','answers','answer_items','work_slot_stats')
                       and grantee in ('anon','authenticated')) = 0
              then 'OK' else 'NG' end
  union all
  select 21, 'C-5 遮断4表の列権限 0件',
         case when (select count(*) from information_schema.column_privileges
                     where table_schema = 'public'
                       and table_name in ('works','answers','answer_items','work_slot_stats')
                       and grantee in ('anon','authenticated')) = 0
              then 'OK' else 'NG' end

  -- C-6. 集計2表は SELECT だけが、anon と authenticated の両方に付いていること
  union all
  select 22, 'C-6 集計2表は SELECT のみ',
         case when (select count(*) from information_schema.column_privileges
                     where table_schema = 'public'
                       and table_name in ('user_stats','user_slot_stats')
                       and grantee in ('anon','authenticated')
                       and privilege_type <> 'SELECT') = 0
              then 'OK' else 'NG' end
  union all
  select 23, 'C-6 user_stats は anon にも SELECT 可（5列）',
         case when (select count(*) from information_schema.column_privileges
                     where table_schema = 'public' and table_name = 'user_stats'
                       and grantee = 'anon' and privilege_type = 'SELECT') = 5
              then 'OK' else 'NG' end
  union all
  select 24, 'C-6 user_slot_stats は anon にも SELECT 可（5列）',
         case when (select count(*) from information_schema.column_privileges
                     where table_schema = 'public' and table_name = 'user_slot_stats'
                       and grantee = 'anon' and privilege_type = 'SELECT') = 5
              then 'OK' else 'NG' end

  -- C-7. 既存12表が無傷であること（表の数とマスタの行数）
  union all
  select 30, 'C-7 既存12表が全部ある',
         case when (select count(*) from pg_tables
                     where schemaname = 'public'
                       and tablename in ('profiles','tag_pools','card_slots','draft_modes',
                                         'draft_mode_slots','tags','draft_sessions',
                                         'draft_candidates','prompts','prompt_cards',
                                         'quiz_questions','quiz_choices')) = 12
              then 'OK' else 'NG' end
  union all
  select 31, 'C-7 マスタ行数 8/10/2/8 のまま',
         case when (select count(*) from public.tag_pools)        = 8
               and (select count(*) from public.card_slots)       = 10
               and (select count(*) from public.draft_modes)      = 2
               and (select count(*) from public.draft_mode_slots) = 8
              then 'OK' else 'NG' end
  union all
  select 32, 'C-7 公開前の全表数が18',
         case when (select count(*) from pg_tables where schemaname = 'public') = 18
              then 'OK' else 'NG' end

) t order by seq;


-- ============================================================================
-- ブロック2 ／ 権限と RLS の実地確認（そのまま全部貼って Run）
-- ============================================================================
--
-- 【重要】このブロックは **必ずエラーで終わります。それが正常です。**
--   エラーメッセージの本文が確認結果です。
--   わざとエラーで終わらせることで、途中で入れたテスト用データが
--   **確実に巻き戻る**ようにしてあります。データは1行も残りません。
--
-- 【見かた】
--   エラー本文に「すべて期待どおり」と出れば成功。
--   「★」が付いた行があれば、そこが設定ミス。

do $$
declare
  t text;
  r text;
  v_denied int := 0;
  v_report text := '';
  v_a uuid;
  v_b uuid;
  v1 int; v2 int; v3 int; v4 int;
  v_rls text;
begin

  -- --- (1) 遮断4表が anon / authenticated から読めないこと（8通り）----------
  foreach t in array array['works','answers','answer_items','work_slot_stats'] loop
    foreach r in array array['anon','authenticated'] loop
      begin
        execute 'set role ' || quote_ident(r);
        execute 'select 1 from public.' || quote_ident(t) || ' limit 1';
        v_report := v_report || format(E'\n  ★ %s が %s から読めてしまった', t, r);
      exception
        when insufficient_privilege then
          v_denied := v_denied + 1;
      end;
      execute 'reset role';
    end loop;
  end loop;

  v_report := format(E'\n[1] 遮断4表の直接SELECT : %s / 8 が permission denied', v_denied)
              || v_report;


  -- --- (2) user_stats の公開条件 4通り ---------------------------------------
  --
  -- A = 本人役、B = 別人役。既存のプロフィール2件を一時的に借りる。
  -- 最後に必ずエラーで終わるので、変更はすべて取り消される。

  select id into v_a from public.profiles order by created_at limit 1;
  select id into v_b from public.profiles order by created_at offset 1 limit 1;

  if v_a is null or v_b is null then
    v_rls := E'\n[2] user_stats の公開条件 : ★スキップ'
             || E'\n    プロフィールが2件必要です。'
             || E'\n    /health/auth をシークレットウィンドウでもう1つ開いて'
             || E'\n    ゲストを増やしてから、もう一度このブロックを実行してください。';
  else
    -- B を「公開設定ONの登録ユーザー」に仕立てる
    update public.profiles
       set is_anonymous     = false,
           handle           = 'zz-verify-b',
           show_answer_stats = true
     where id = v_b;

    -- A は本人役。公開設定は false のまま（本人だから見えるはず）
    update public.profiles set show_answer_stats = false where id = v_a;

    insert into public.user_stats (user_id, total_answers, total_items, total_correct_items)
    values (v_a, 3, 9, 5), (v_b, 4, 12, 7);

    -- 条件1: 本人のJWT → 自分の行が見える（期待 1）
    perform set_config('request.jwt.claim.sub', v_a::text, false);
    execute 'set role authenticated';
    select count(*) into v1 from public.user_stats where user_id = v_a;
    execute 'reset role';

    -- 条件2: 別人・show_answer_stats = true → 見える（期待 1）
    perform set_config('request.jwt.claim.sub', v_a::text, false);
    execute 'set role authenticated';
    select count(*) into v2 from public.user_stats where user_id = v_b;
    execute 'reset role';

    -- 条件3: 別人・show_answer_stats = false → 見えない（期待 0）
    update public.profiles set show_answer_stats = false where id = v_b;
    perform set_config('request.jwt.claim.sub', v_a::text, false);
    execute 'set role authenticated';
    select count(*) into v3 from public.user_stats where user_id = v_b;
    execute 'reset role';

    -- 条件4: JWTなしの anon・show_answer_stats = true → 見える（期待 1）
    update public.profiles set show_answer_stats = true where id = v_b;
    perform set_config('request.jwt.claim.sub', '', false);
    execute 'set role anon';
    select count(*) into v4 from public.user_stats where user_id = v_b;
    execute 'reset role';

    v_rls := E'\n[2] user_stats の公開条件'
      || format(E'\n  %s 条件1 本人のJWT              : 期待 1 / 実際 %s',
                case when v1 = 1 then ' ' else '★' end, v1)
      || format(E'\n  %s 条件2 別人・公開ON           : 期待 1 / 実際 %s',
                case when v2 = 1 then ' ' else '★' end, v2)
      || format(E'\n  %s 条件3 別人・公開OFF          : 期待 0 / 実際 %s',
                case when v3 = 0 then ' ' else '★' end, v3)
      || format(E'\n  %s 条件4 anon（JWTなし）・公開ON : 期待 1 / 実際 %s',
                case when v4 = 1 then ' ' else '★' end, v4);
  end if;


  -- --- (3) まとめて報告し、必ず巻き戻す --------------------------------------
  raise exception E'\n===== Step 3B-3a 実地確認の結果 =====\n%\n%\n\n%\n（このエラーは正常です。テストデータはすべて取り消されました）',
    v_report,
    v_rls,
    case
      when v_denied = 8 and position('★' in coalesce(v_rls, '')) = 0
        then '判定: すべて期待どおり'
      else '判定: ★の付いた行を確認してください'
    end;

end $$;
