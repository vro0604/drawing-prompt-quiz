/**
 * db-checks.mjs ／ 検証項目の定義
 *
 * ここには「何を確かめるか」だけを書く。実行と表示は db-verify.mjs が行う。
 * 項目を足したいときはこのファイルだけを編集する。
 *
 * 種類は3つ。
 *   expect  … SQL が返す1つの値が expected と一致すること
 *   zero    … SQL が0行を返すこと（Step 3E の診断。1行でも返れば異常）
 *   rpc     … 指定のロールで関数を呼び、成功／権限エラーを判定すること
 */

/** 誰も直接読めない12表 */
export const SEALED_TABLES = [
  "draft_candidates",
  "prompt_cards",
  "quiz_questions",
  "quiz_choices",
  "works",
  "answers",
  "answer_items",
  "work_slot_stats",
  "likes",
  "saves",
  "reports",
  // Step 15。手放した ID の控え。「誰が昔どの ID だったか」は
  // 本人が明かすまで見せる必要が無い（P5 / D62）
  "handle_history",
];

/** anon / authenticated が列権限を持つ10表 */
export const GRANTED_TABLES = [
  "profiles",
  "tag_pools",
  "card_slots",
  "draft_modes",
  "draft_mode_slots",
  "tags",
  "draft_sessions",
  "prompts",
  "user_stats",
  "user_slot_stats",
];

/** 誰でも呼べる取得系RPC */
export const PUBLIC_RPCS = [
  "get_public_works",
  "get_work_detail",
  "get_work_quiz",
  "get_public_saves",
  "get_rankings",
  "get_public_profile",
  "get_user_works",
  "get_saved_works",
  "get_public_answers",
  "get_handle_redirect",
];

/** 本人だけの取得系RPC */
export const OWNER_RPCS = [
  "get_my_works",
  "get_my_work",
  "get_my_prompts",
  "get_my_prompt",
  "get_my_answers",
  "get_my_answer",
  "get_my_likes",
  "get_my_saves",
  "get_my_reaction",
];

/** ドラフトRPC（authenticated のみ） */
export const DRAFT_RPCS = [
  "start_draft",
  "reveal_card",
  "reroll_draft",
  "complete_draft",
  "get_current_draft",
  "abandon_draft",
];

/**
 * 作品の書き込みRPC（authenticated のみ）。
 *
 * 【権限だけでは守り切れない点】
 *   匿名ゲストも登録ユーザーも Postgres 側では同じ authenticated ロールになる。
 *   「投稿は登録必須」は grant では表現できないので、関数の中で
 *   JWT の is_anonymous を見て弾いている。下の rpcSourceChecks で
 *   その一行が消えていないことを確かめる。
 */
export const WRITE_RPCS = [
  "create_work",
  "update_work",
  // Step 15。論理削除と、画像を消せたことの記録。
  // 投稿と同じく登録ユーザー限定（ゲストはそもそも作品を持てない）
  "delete_work",
  "mark_work_image_deleted",
];

/**
 * 回答の書き込みRPC（authenticated のみ）。
 *
 * **WRITE_RPCS とは分けている。** 作品の投稿は登録ユーザー限定だが、
 * 回答は匿名ゲストにも許す（spec 10 の権限表）。
 * 同じ配列に入れると「is_anonymous を見ているか」の検査が
 * 回答RPCまで巻き込んでしまい、意味が逆になる。
 */
export const ANSWER_RPCS = ["submit_answer"];

/**
 * 登録ユーザー限定の書き込みRPC。
 *
 * 作品の投稿（WRITE_RPCS）と同じく、匿名ゲストを JWT で弾く。
 * ANSWER_RPCS とは分ける（回答はゲストにも許すため、条件が逆）。
 *
 *   update_my_profile … ID の先取りを防ぐ（001 の設計）
 *   toggle_like / toggle_save … 人気ランキングを成立させる（D7 / spec 10）
 */
export const MEMBER_RPCS = [
  "update_my_profile",
  "update_my_visibility",
  "toggle_like",
  "toggle_save",
];

/** いいね・保存の件数を works へ同期するトリガー */
export const COUNT_TRIGGERS = ["likes_after_change_counts", "saves_after_change_counts"];

/** storage.objects に張った works バケット用のポリシー */
export const STORAGE_POLICIES = [
  "works_objects_read_public",
  "works_objects_insert_own",
  "works_objects_update_own",
  "works_objects_delete_own",
];

/** 外部へ公開しない内部ヘルパー */
export const INTERNAL_FUNCS = ["draft_generate_candidates", "draft_state_json"];

/**
 * 検証のための目印を返すだけの関数。
 *
 * quiz_choice_dedupe_cutoff は「選択肢の重複を禁止した時点の
 * quiz_choices.id」を返す。診断 A23 が、修正後に作られたクイズだけを
 * 厳格に見るために使う。外から呼ぶ必要はない。
 */
export const META_FUNCS = ["quiz_choice_dedupe_cutoff"];

/** トリガー関数など、外から呼ばれないもの */
export const TRIGGER_FUNCS = [
  "handle_new_user",
  "sync_profile_anonymous_flag",
  "draft_sessions_set_updated_at",
  "answers_after_insert_stats",
  "answer_items_after_insert_stats",
  "likes_after_change_counts",
  "saves_after_change_counts",
];

/** 回答が入ったときに集計を進めるトリガー */
export const STATS_TRIGGERS = [
  "answers_after_insert_stats",
  "answer_items_after_insert_stats",
];

/** public スキーマに自作した関数すべて */
export const ALL_FUNCS = [
  ...PUBLIC_RPCS,
  ...OWNER_RPCS,
  ...DRAFT_RPCS,
  ...WRITE_RPCS,
  ...ANSWER_RPCS,
  ...MEMBER_RPCS,
  ...INTERNAL_FUNCS,
  ...META_FUNCS,
  ...TRIGGER_FUNCS,
];

/**
 * 関数ごとの EXECUTE 権限を、引数型つきの正確なシグネチャで並べる診断。
 *
 * oid::regprocedure は public.get_my_work(uuid) のように
 * 「どの関数か」を取り違えようのない形で表示してくれる。
 * 同じ名前で引数違いの関数があっても区別できる。
 */
export const FUNCTION_PRIV_SQL = `
  select
    p.oid::regprocedure::text as signature,
    p.prosecdef               as security_definer,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             where a.grantee = 0 and a.privilege_type = 'EXECUTE')      as public_exec,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             where a.grantee = 'anon'::regrole::oid
               and a.privilege_type = 'EXECUTE')                        as anon_exec,
    exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
             where a.grantee = 'authenticated'::regrole::oid
               and a.privilege_type = 'EXECUTE')                        as authenticated_exec,
    coalesce(array_to_string(p.proacl, ' | '), '(デフォルトのまま)')     as acl
  from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = any($1)
  order by p.proname, p.oid::regprocedure::text
`;

/**
 * 表の権限を grantee 別に並べる。
 *
 * 【aclexplode に空配列を渡さない】← 以前ここで落ちていた
 *   aclexplode は **1次元の配列しか受け付けない**。
 *   `'{}'::aclitem[]` は「要素数0」ではなく「**次元数0**」の配列なので、
 *   coalesce の逃げ道に使うと `ACL arrays must be one-dimensional` になる。
 *
 *   関数側（FUNCTION_PRIV_SQL）が acldefault() を使って無事なのは、
 *   あちらが常に1次元を返すため。表と列には同じ手が使えない
 *   （列の既定 ACL は空なので、同じ問題に戻る）。
 *
 *   そこで **null の行はそもそも渡さない**。relacl / attacl が null なら
 *   「既定のまま」＝ PUBLIC / anon / authenticated には何も付いていない
 *   ので、数えなくてよい。
 *
 * 【as materialized を付ける理由】
 *   FROM に置いた集合返し関数は、WHERE より先に評価されることがある。
 *   `where relacl is not null` と書いても、条件が後回しになれば
 *   null の行を aclexplode へ渡してしまう。
 *   materialized なら CTE がそこで確定するので、順序が入れ替わらない。
 *
 * 【relacl と attacl をつながない】
 *   型は同じでも意味が違う（表に付いた権限と、列に付いた権限）。
 *   配列として結合すると出所が分からなくなる。別々に展開して UNION ALL する。
 *
 *   information_schema.column_privileges を使わないのも同じ理由。
 *   あちらは SELECT / INSERT / UPDATE / REFERENCES の4種しか見えず
 *   （**DELETE や TRUNCATE だけを配られていても現れない**）、
 *   さらに表単位の grant を全列へ展開して見せる。
 *
 * 【PUBLIC は grantee = 0】
 *   ACL を文字列で照合すると 'anon=arwd/' にも '=arwd/' が含まれて
 *   取り違えるので、必ず oid で見る（D34 と同じ理由）。
 *   0::regrole::text は '-' になるので PUBLIC と読み替える。
 */
const TABLE_ACL_CTE = `
  with rel as materialized (
    select c.relname, c.relacl
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = any($1)
       and c.relacl is not null
  ),
  col as materialized (
    select c.relname, at.attname, at.attacl
      from pg_attribute at
      join pg_class c on c.oid = at.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = any($1)
       and at.attacl is not null
  )
`;

/** 利用者向けのロール（PUBLIC / anon / authenticated）だけを対象にする条件 */
const USER_GRANTEES = `(0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)`;

/**
 * 退会・規約で足した7表。すべて遮断する（権限もポリシーも与えない）。
 * 読み書きは security definer の RPC と service_role だけ。
 */
const WITHDRAWAL_TABLES = [
  "app_secrets",
  "handle_reservations",
  "storage_cleanup_queue",
  "account_deletions",
  "terms_versions",
  "privacy_versions",
  "terms_agreements",
];

/** PUBLIC / anon / authenticated に付いている権限の件数（表単位＋列単位） */
export const TABLE_USER_PRIV_COUNT_SQL = `
  ${TABLE_ACL_CTE}
  select (
      (select count(*) from rel r, aclexplode(r.relacl) a
        where a.grantee in ${USER_GRANTEES})
    + (select count(*) from col c, aclexplode(c.attacl) a
        where a.grantee in ${USER_GRANTEES})
  )::int
`;

/** 権限を1件ずつ並べる（合否には使わず、目で見るためのもの） */
export const TABLE_PRIV_SQL = `
  ${TABLE_ACL_CTE}
  select r.relname                                                as table_name,
         '表単位'                                                  as scope,
         '-'                                                      as column_name,
         coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee,
         a.privilege_type
    from rel r, aclexplode(r.relacl) a
  union all
  select c.relname,
         '列単位',
         c.attname,
         coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC'),
         a.privilege_type
    from col c, aclexplode(c.attacl) a
  order by 1, 2, 4, 3, 5
`;

/**
 * 既定権限（今後作られる表・関数などに自動で付く権限）を並べる。
 *
 * **所有者ロールごとに別の行になる。** Supabase は postgres と
 * supabase_admin の両方に既定を置くため、片方だけ落としてももう片方が残る。
 * どちらの行なのかが分からないと直しようがないので owner_role を必ず出す。
 *
 * defaclacl は行が存在する時点で必ず中身があるので、
 * ここは空配列を渡す心配が無い。
 */
export const DEFAULT_ACL_SQL = `
  select pg_get_userbyid(d.defaclrole)                            as owner_role,
         coalesce(n.nspname, '(全スキーマ)')                        as schema,
         case d.defaclobjtype
           when 'r' then '表'
           when 'f' then '関数'
           when 'S' then '順序'
           when 'T' then '型'
           when 'n' then 'スキーマ'
           else d.defaclobjtype::text
         end                                                      as object_type,
         coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee,
         a.privilege_type
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace,
         aclexplode(d.defaclacl) a
   where n.nspname = 'public' or d.defaclnamespace = 0
   order by 1, 2, 3, 4, 5
`;

export const checks = [
  // ───────────────────────────── 構造 ─────────────────────────────
  {
    group: "構造",
    // 22表（Step 3B まで）＋ handle_history（P5）は 3B の数に含む。
    // 退会・規約で7表増えて29。増減したら必ずここを直す
    //   ＝「知らないうちに表が増えていた」を検出する仕掛け。
    name: "public スキーマの表が29個",
    expected: 29,
    sql: `select count(*)::int from pg_tables where schemaname = 'public'`,
    detailSql: `select tablename from pg_tables
                 where schemaname = 'public' order by tablename`,
  },
  {
    group: "構造",
    name: "遮断12表がすべて存在する",
    expected: SEALED_TABLES.length,
    sql: `select count(*)::int from pg_tables
           where schemaname = 'public' and tablename = any($1)`,
    params: [SEALED_TABLES],
  },
  {
    group: "構造",
    name: "29表すべてで RLS が有効",
    expected: 29,
    sql: `select count(*)::int from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity`,
  },
  {
    group: "構造",
    name: "マスタ行数 tag_pools=8",
    expected: 8,
    sql: `select count(*)::int from public.tag_pools`,
  },
  {
    group: "構造",
    name: "マスタ行数 card_slots=10",
    expected: 10,
    sql: `select count(*)::int from public.card_slots`,
  },
  {
    group: "構造",
    name: "マスタ行数 draft_modes=2",
    expected: 2,
    sql: `select count(*)::int from public.draft_modes`,
  },
  {
    group: "構造",
    name: "マスタ行数 draft_mode_slots=8",
    expected: 8,
    sql: `select count(*)::int from public.draft_mode_slots`,
  },

  // ───────────────────────────── 権限 ─────────────────────────────
  {
    group: "権限",
    name: "遮断12表に anon/authenticated の権限が0件",
    expected: 0,
    sql: `select count(*)::int from information_schema.column_privileges
           where table_schema = 'public'
             and table_name = any($1)
             and grantee in ('anon','authenticated')`,
    params: [SEALED_TABLES],
  },
  {
    group: "権限",
    name: "遮断12表に PUBLIC / anon / authenticated の権限が0件（種類を漏らさず）",
    // 上の information_schema による検査は SELECT / INSERT / UPDATE /
    // REFERENCES の4種しか見えない。**DELETE や TRUNCATE だけを
    // 配られていても気づけない。** relacl / attacl を展開して、
    // 表単位・列単位の両方を種類ごとに漏れなく数える。
    //
    // PUBLIC（grantee = 0）も対象に入れる。付いていればどのロールからも読める。
    expected: 0,
    sql: TABLE_USER_PRIV_COUNT_SQL,
    params: [SEALED_TABLES],
    detailSql: TABLE_PRIV_SQL,
    detailParams: [SEALED_TABLES],
  },
  {
    group: "権限",
    name: "遮断12表に RLS ポリシーが0本",
    expected: 0,
    sql: `select count(*)::int from pg_policies
           where schemaname = 'public' and tablename = any($1)`,
    params: [SEALED_TABLES],
    detailSql: `select tablename, policyname, cmd, roles::text
                  from pg_policies
                 where schemaname='public' and tablename = any($1)
                 order by tablename, policyname`,
    detailParams: [SEALED_TABLES],
  },
  {
    group: "権限",
    name: "権限を持つ表がちょうど10表",
    expected: 10,
    sql: `select count(distinct table_name)::int from information_schema.column_privileges
           where table_schema = 'public' and grantee in ('anon','authenticated')`,
  },
  {
    group: "権限",
    name: "user_stats は anon からも読める（5列）",
    expected: 5,
    sql: `select count(*)::int from information_schema.column_privileges
           where table_schema='public' and table_name='user_stats'
             and grantee='anon' and privilege_type='SELECT'`,
  },
  {
    group: "権限",
    name: "集計2表に SELECT 以外の権限が無い",
    expected: 0,
    sql: `select count(*)::int from information_schema.column_privileges
           where table_schema='public'
             and table_name in ('user_stats','user_slot_stats')
             and grantee in ('anon','authenticated')
             and privilege_type <> 'SELECT'`,
  },

  // ───────────────────────────── 関数 ─────────────────────────────
  {
    group: "関数",
    name: "security definer なのに search_path 未固定の関数が0本",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosecdef
             and not exists (
               select 1 from unnest(coalesce(p.proconfig,'{}')) c
                where c like 'search\\_path=%')`,
  },
  {
    group: "関数",
    name: "PUBLIC に EXECUTE が残っている関数が0本",
    expected: 0,
    // aclexplode で ACL を1件ずつ展開し、grantee = 0（＝PUBLIC）だけを見る。
    //
    // 【以前ここを間違えていた】
    //   aclitem を文字列にして '%=X/%' で探していたが、
    //   PUBLIC は '=X/postgres'、anon は 'anon=X/postgres' と表記され、
    //   後者にも '=X/' が含まれるため **全関数が誤検出**されていた。
    //   grantee の oid で判定すれば取り違えようがない。
    //
    // proacl が null のときは「デフォルトのまま」＝ PUBLIC に EXECUTE がある状態。
    // acldefault('f', 所有者) で補ってから同じ判定をかける。
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public'
             and p.proname = any($1)
             and exists (
               select 1
                 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                where a.grantee = 0
                  and a.privilege_type = 'EXECUTE')`,
    params: [[...ALL_FUNCS]],
    detailSql: FUNCTION_PRIV_SQL,
    detailParams: [[...ALL_FUNCS]],
  },
  {
    group: "関数",
    name: "今後作る関数へ PUBLIC EXECUTE が自動付与されない設定がある",
    expected: 1,
    sql: `select (exists (
             select 1 from pg_default_acl d
               join pg_namespace n on n.oid = d.defaclnamespace
              where n.nspname = 'public' and d.defaclobjtype = 'f'))::int`,
  },
  {
    group: "関数",
    name: "そのデフォルト設定に PUBLIC の EXECUTE が含まれない",
    expected: 0,
    sql: `select count(*)::int from pg_default_acl d
            join pg_namespace n on n.oid = d.defaclnamespace
           where n.nspname = 'public' and d.defaclobjtype = 'f'
             and exists (select 1 from aclexplode(d.defaclacl) a
                          where a.grantee = 0 and a.privilege_type = 'EXECUTE')`,
  },
  {
    group: "関数",
    name: "公開10本は anon から実行できる",
    expected: 10,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    params: [PUBLIC_RPCS],
  },
  {
    group: "関数",
    name: "本人用9本は anon から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    params: [OWNER_RPCS],
  },
  {
    group: "関数",
    name: "内部ヘルパーは anon/authenticated から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    params: [INTERNAL_FUNCS],
  },
  {
    group: "関数",
    name: "書き込みRPC 4本が存在する",
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)`,
    params: [WRITE_RPCS],
  },
  {
    group: "関数",
    name: "書き込みRPC 4本は authenticated から実行できる",
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
    params: [WRITE_RPCS],
  },
  {
    group: "関数",
    name: "書き込みRPC 4本は anon から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    params: [WRITE_RPCS],
  },

  {
    group: "関数",
    name: "回答RPC submit_answer が存在する",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)`,
    params: [ANSWER_RPCS],
  },
  {
    group: "関数",
    name: "submit_answer は authenticated から実行できる（ゲスト含む）",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
    params: [ANSWER_RPCS],
  },
  {
    group: "関数",
    name: "submit_answer は anon から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    params: [ANSWER_RPCS],
  },
  {
    group: "関数",
    name: "集計トリガー2本が設置されている",
    expected: 2,
    sql: `select count(*)::int from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public'
             and not t.tgisinternal
             and t.tgname = any($1)`,
    params: [STATS_TRIGGERS],
  },
  {
    group: "関数",
    name: "集計トリガー関数は anon/authenticated から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    params: [STATS_TRIGGERS],
  },

  {
    group: "関数",
    name: "登録ユーザー限定RPC 4本が存在する",
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)`,
    params: [MEMBER_RPCS],
  },
  {
    group: "関数",
    name: "登録ユーザー限定RPC 4本は anon から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('anon', p.oid, 'EXECUTE')`,
    params: [MEMBER_RPCS],
  },
  {
    group: "関数",
    name: "いいね・保存のカウンタ同期トリガー2本が設置されている",
    expected: 2,
    sql: `select count(*)::int from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public'
             and not t.tgisinternal
             and t.tgname = any($1)`,
    params: [COUNT_TRIGGERS],
  },
  {
    group: "関数",
    name: "そのトリガー関数は anon/authenticated から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    params: [COUNT_TRIGGERS],
  },

  // ─────────────────────── 選択肢のタグを重複させない ───────────────────────
  //
  // 同じタグが2つの問に出ると、そのタグは**どちらの問でも不正解だと確定する**
  // （ハズレはお題の正解タグを全枠ぶん除いて選ばれるため）。
  // 4択が実質3択になるだけでなく、絵を見ずに候補を消せてしまう。
  //
  // 実際に重複していないことは診断 A23 と smoke:answer が見る。
  // ここでは、防いでいる仕掛けが定義から消えていないことを確かめる。
  {
    group: "選択肢",
    name: "complete_draft がプール単位でハズレを配っている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='complete_draft'
             and p.prosrc like '%seq_in_pool%'`,
  },
  {
    group: "選択肢",
    name: "complete_draft が重複を検算して失敗させる",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='complete_draft'
             and p.prosrc like '%QUIZ_CHOICES_DUPLICATE%'
             and p.prosrc like '%QUIZ_CHOICES_INSUFFICIENT%'`,
  },
  {
    group: "選択肢",
    name: "重複禁止の境目を返す関数がある（診断 A23 が使う）",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)`,
    params: [META_FUNCS],
  },
  {
    group: "選択肢",
    name: "その関数は anon/authenticated から実行できない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and (has_function_privilege('anon', p.oid, 'EXECUTE')
               or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`,
    params: [META_FUNCS],
  },

  // ─────────────────────────────── 退会・規約 ───────────────────────────────
  //
  // spec 13 の P1 / P2 / P3。実際の流れは smoke:account が見る。
  //
  // **ここでしか見られないものがある。** 退会したあと「他人の回答と
  // work_slot_stats が残っていること」は HTTP からは確かめられない。
  // 削除済みの作品は誰にも開けないためで、スモークからは覗けない。
  //
  // だからここでは**作りのほう**を見る。
  // 「消していないこと」を、消す命令が無いことで確かめる。
  {
    group: "退会",
    name: "退会が作品・回答・通報・集計の行を消していない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='start_account_deletion'
             and (p.prosrc ilike '%delete from public.works%'
               or p.prosrc ilike '%delete from public.answers%'
               or p.prosrc ilike '%delete from public.reports%'
               or p.prosrc ilike '%delete from public.work_slot_stats%')`,
  },
  {
    group: "退会",
    name: "退会が持ち主と回答者の線だけを切っている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='start_account_deletion'
             and p.prosrc like '%a set user_id     = null%'
             and p.prosrc like '%r set reporter_id = null%'
             and p.prosrc like '%p set created_by  = null%'`,
  },
  {
    group: "退会",
    name: "退会が本人だけのものを消している",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='start_account_deletion'
             and p.prosrc like '%delete from public.likes%'
             and p.prosrc like '%delete from public.saves%'
             and p.prosrc like '%delete from public.user_stats%'
             and p.prosrc like '%delete from public.user_slot_stats%'
             and p.prosrc like '%delete from public.draft_sessions%'`,
  },
  {
    group: "退会",
    name: "退会が作品を即座に公開から外している",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='start_account_deletion'
             and p.prosrc like '%is_published     = false%'
             and p.prosrc like '%deleted_at       = coalesce(w.deleted_at, now())%'`,
  },
  {
    group: "退会",
    name: "works.user_id を外せる（nullable ＋ set null）",
    expected: 1,
    sql: `select count(*)::int
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and c.relname='works'
             and con.conname='works_user_id_fkey'
             and con.confdeltype='n'
             and not (select a.attnotnull from pg_attribute a
                       where a.attrelid=c.oid and a.attname='user_id')`,
  },
  {
    group: "退会",
    name: "持ち主のいない作品は公開対象になれない",
    expected: 1,
    sql: `select count(*)::int
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and c.relname='works'
             and con.conname='works_owner_or_deleted'`,
  },
  {
    group: "退会",
    name: "書き込みの門番が8つ付いている",
    expected: 8,
    sql: `select count(*)::int
            from pg_trigger t
            join pg_class c on c.oid = t.tgrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and not t.tgisinternal
             and t.tgname in ('guard_account_active','guard_works','guard_profiles')`,
    detailSql: `select c.relname as table_name, t.tgname
                  from pg_trigger t
                  join pg_class c on c.oid = t.tgrelid
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname='public' and not t.tgisinternal
                   and t.tgname in ('guard_account_active','guard_works','guard_profiles')
                 order by 1`,
  },
  {
    group: "退会",
    name: "退会した人の ID を平文で持っていない",
    expected: 1,
    sql: `select count(*)::int
            from information_schema.columns
           where table_schema='public' and table_name='handle_reservations'
             and column_name='handle_hash' and data_type='bytea'`,
    detailSql: `select column_name, data_type from information_schema.columns
                 where table_schema='public' and table_name='handle_reservations'
                 order by ordinal_position`,
  },
  {
    group: "退会",
    name: "ID ハッシュの鍵が DB の中にある（Git には無い）",
    expected: 1,
    sql: `select count(*)::int from public.app_secrets
           where key_name='handle_hash_key' and octet_length(secret) >= 32`,
  },
  {
    group: "退会",
    name: "退会まわりの7表に PUBLIC / anon / authenticated の権限が0件",
    expected: 0,
    sql: TABLE_USER_PRIV_COUNT_SQL,
    params: [WITHDRAWAL_TABLES],
    detailSql: TABLE_PRIV_SQL,
    detailParams: [WITHDRAWAL_TABLES],
  },
  {
    group: "退会",
    name: "Storage の書き込み3本が退会処理中を見ている",
    expected: 3,
    sql: `select count(*)::int from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname in ('works_objects_insert_own','works_objects_update_own',
                                'works_objects_delete_own')
             and coalesce(qual,'') || coalesce(with_check,'') like '%account_status%'`,
  },
  {
    group: "退会",
    name: "退会が他人を指せない（引数に利用者を取らない）",
    expected: 1,
    // 引数は合言葉の text 1つだけ。uuid を受け取る口が無いことを見る。
    // 文字列の見た目ではなく型そのもので判定する（表記は版で変わりうる）。
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='start_account_deletion'
             and p.pronargs = 1
             and p.proargtypes[0] = 'text'::regtype`,
    detailSql: `select p.proname,
                       pg_get_function_identity_arguments(p.oid) as args
                  from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname='public' and p.proname='start_account_deletion'`,
  },
  {
    group: "規約",
    name: "いま有効な版が規約とポリシーに1つずつ",
    expected: 2,
    sql: `select ((select count(*) from public.terms_versions where is_current)
                + (select count(*) from public.privacy_versions where is_current))::int`,
  },
  {
    group: "規約",
    name: "同意の記録に保存期限が必ず入る（無期限にしない）",
    expected: 1,
    sql: `select count(*)::int from information_schema.columns
           where table_schema='public' and table_name='terms_agreements'
             and column_name='retain_until' and is_nullable='NO'`,
  },
  {
    group: "規約",
    name: "同意の記録が退会で個人と切り離される",
    expected: 1,
    sql: `select count(*)::int
            from pg_constraint con
            join pg_class c on c.oid = con.conrelid
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname='public' and c.relname='terms_agreements'
             and con.contype='f' and con.confdeltype='n'`,
  },
  {
    group: "規約",
    name: "未同意では作品を作れない",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='app_guard_works'
             and p.prosrc like '%TERMS_NOT_AGREED%'`,
  },
  {
    group: "規約",
    name: "保存期限を過ぎた同意の記録が残っていない",
    expected: 0,
    sql: `select count(*)::int from public.terms_agreements
           where retain_until < now()`,
  },

  // ────────────────────────────── タグマスタ ──────────────────────────────
  //
  // spec 13 Step 3D。本番156件。原案は docs/tags-master.md。
  //
  // 投入そのものは migration の中で8項目を検算している。ここで見るのは
  // **投入したあとに崩れていないか**。タグは誰でも増やせてしまう場所で、
  // 1件足すだけで抽選の均衡もクイズの成立条件も変わる。
  //
  // 件数を数えるだけにしないこと。件数が合っていても中身が入れ替われば
  // 意味が無いので、下限（4-1 の式）と重みの分布も見る。
  {
    group: "タグ",
    name: "有効タグが156件ある",
    expected: 156,
    sql: `select count(*)::int from public.tags where is_active`,
  },
  {
    group: "タグ",
    name: "プール別の件数が 102 / 15 / 24 / 15",
    expected: 4,
    sql: `select count(*)::int from (
            select pool_key from public.tags where is_active
             group by pool_key
            having (pool_key = 'motif'   and count(*) = 102)
                or (pool_key = 'color'   and count(*) =  15)
                or (pool_key = 'species' and count(*) =  24)
                or (pool_key = 'genre'   and count(*) =  15)
          ) t`,
    detailSql: `select pool_key, count(*)::int as active
                  from public.tags where is_active
                 group by pool_key order by pool_key`,
  },
  {
    group: "タグ",
    name: "pool_key + label の重複が無い",
    expected: 0,
    sql: `select count(*)::int from (
            select pool_key, label from public.tags
             group by pool_key, label having count(*) > 1
          ) d`,
  },
  {
    // spec 4-1 の下限。標準モードは motif を 2枠×5 = 10件使い、
    // クイズは正解2件＋ハズレ6件を重複なしで要求する。
    // どちらか一方でも割ると、お題の確定が失敗する。
    group: "タグ",
    name: "抽選とクイズの下限を全プールが満たす",
    expected: 0,
    sql: `select count(*)::int from (
            select pool_key, count(*) as n from public.tags where is_active
             group by pool_key
          ) t
          where (t.pool_key = 'motif'   and t.n < 10)
             or (t.pool_key = 'color'   and t.n <  5)
             or (t.pool_key = 'species' and t.n <  5)
             or (t.pool_key = 'genre'   and t.n <  5)`,
    detailSql: `select pool_key, count(*)::int as active
                  from public.tags where is_active
                 group by pool_key order by pool_key`,
  },
  {
    // 均一投入をやめた（要件）。全部が同じ重みに戻っていたら、
    // 誰かが一括更新したということ。
    group: "タグ",
    name: "重みが均一ではない",
    expected: 4,
    sql: `select count(distinct weight)::int
            from public.tags where is_active`,
  },
  {
    // 重みの差が開きすぎると「珍しい語はたいていハズレ」が学習できてしまう。
    // ハズレは重みを見ずに引くため、正解側だけが偏るとこの推測が成立する。
    group: "タグ",
    name: "重みの最大が最小の4倍未満（推測を成立させない）",
    expected: 0,
    sql: `select count(*)::int from (
            select max(weight)::numeric / min(weight) as ratio
              from public.tags where is_active
          ) r where r.ratio >= 4`,
    detailSql: `select min(weight)::int as min_weight,
                       max(weight)::int as max_weight
                  from public.tags where is_active`,
  },
  {
    // 停止したタグが混ざっていないこと。156件ちょうどで、
    // is_active = false の行はいまのところ1件も無い。
    group: "タグ",
    name: "停止中のタグが無い",
    expected: 0,
    sql: `select count(*)::int from public.tags where not is_active`,
    detailSql: `select pool_key, label, weight from public.tags
                 where not is_active order by pool_key, label`,
  },
  {
    // 参照の宛先が全部いること。外部キーがあるので本来起きないが、
    // 制約が外れていないことの確認を兼ねる。
    group: "タグ",
    name: "お題とクイズが存在しないタグを指していない",
    expected: 0,
    sql: `select (
            (select count(*) from public.prompt_cards pc
              where not exists (select 1 from public.tags t where t.id = pc.tag_id))
          + (select count(*) from public.quiz_choices qc
              where not exists (select 1 from public.tags t where t.id = qc.tag_id))
          )::int`,
  },

  // ──────────────────────── 通常フィードと AI の分離 ────────────────────────
  //
  // spec 13 Step 8 の終了条件「AI作品が通常フィードに出ない」。
  // 実際に出ないことは smoke:answer が確かめる。ここでは
  // 絞り込みの式そのものが消えていないことを見る。
  {
    group: "フィード",
    name: "通常フィード（p_division = null）が AI 部門を除いている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_public_works'
             and p.prosrc like '%w.division <> ''ai''%'`,
  },

  // ──────────────────────────── ランキング ────────────────────────────
  //
  // spec 13 Step 13。実際の並びは smoke:ranking が見る。
  // ここでは、順位の公平さを支えている条件が定義から消えていないことを確かめる。
  // ─────────────────────── 公開プロフィール・お気に入り ───────────────────────
  //
  // spec 13 Step 14。実際の見えかたは smoke:profile が見る。
  // ここでは、公開範囲を決めている条件が定義から消えていないことを確かめる。
  {
    group: "公開",
    name: "公開プロフィール系の関数4本が存在する",
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public'
             and p.proname in ('get_public_profile','get_user_works',
                               'get_saved_works','get_public_answers')`,
  },
  {
    group: "公開",
    name: "お気に入りの公開が show_saved_works に従っている",
    // 他人へ返す条件。ここが消えると、設定を切っている人の
    // お気に入りが誰にでも見える。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_saved_works'
             and p.prosrc like '%show_saved_works%'
             and p.prosrc like '%o.is_anonymous = false%'`,
  },
  {
    group: "公開",
    name: "他人のお気に入りは公開中の作品だけ",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_saved_works'
             and p.prosrc like '%w.is_published and w.review_status = ''ok'' and w.deleted_at is null%'`,
  },
  {
    group: "公開",
    name: "お気に入りのお題は「閲覧者が回答済み」のときだけ添えている",
    // **この項目と、上の「prompt_cards に触れる関数が4本」は対で見る。**
    // 本数だけ見ていると、無条件に prompt_cards を読む関数が
    // 4本目として紛れ込んでも気づけない。
    //
    // 条件は get_my_answer と同じ「その閲覧者の answers 行があるか」。
    // 空白の入れかたに左右されないよう、詰めてから照合する。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_saved_works'
             and regexp_replace(p.prosrc, '\\s+', ' ', 'g') like
                 '%case when exists ( select 1 from public.answers a where a.work_id = w.id and a.user_id = (select auth.uid()) ) then%'`,
  },
  {
    group: "公開",
    name: "お気に入り一覧が likes に触れていない",
    // お気に入りといいねは別の機能として扱う（spec 12-1）。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_saved_works'
             and p.prosrc like '%public.likes%'`,
  },
  {
    group: "公開",
    name: "ランキングが saves に触れていない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and p.prosrc like '%public.saves%'`,
  },
  {
    group: "公開",
    name: "回答履歴が show_answer_history に従い、選んだタグを返さない",
    // 他人へ出すのは「作品・日時・正答数」だけ（spec 12-0）。
    // selected_tag_id と is_correct が揃うと正解が割れる（spec 8-4）。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_public_answers'
             and p.prosrc like '%show_answer_history%'
             and p.prosrc not like '%selected_tag_id%'
             and pg_get_function_result(p.oid) not ilike '%tag%'`,
  },
  {
    group: "公開",
    name: "回答者としての成績が show_answer_stats に従っている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_public_profile'
             and p.prosrc like '%show_answer_stats%'`,
  },
  {
    group: "公開",
    name: "獲得いいねから作者本人のぶんを除いている",
    // D57 と同じ考え方。自分で押すだけで数字が増えないようにする。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_public_profile'
             and p.prosrc like '%l.user_id <> t.id%'`,
  },
  {
    group: "公開",
    name: "ID の予約語を配らない検査がある",
    // なりすまし（admin / official など）と、将来 URL を短くしたときの
    // ページ名との衝突を、両方まとめて押さえている（D59）。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='update_my_profile'
             and p.prosrc like '%HANDLE_RESERVED%'
             and p.prosrc like '%''admin''%'
             and p.prosrc like '%''official''%'`,
  },
  {
    group: "公開",
    name: "公開プロフィールは登録済み（is_anonymous = false）の人だけ",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_public_profile'
             and p.prosrc like '%p.is_anonymous = false%'`,
  },

  // ─────────────────────── 旧IDの保護・通報・削除（Step 15）───────────────────
  {
    group: "削除通報",
    name: "handle_history に PUBLIC / anon / authenticated の権限が0件",
    // 「誰が昔どの ID だったか」は本人が明かすまで見せない（P5 / D62）。
    // 遮断表の一括検査にも含めているが、狙いが分かるように単独でも見る。
    //
    // 【aclexplode で数える理由】
    //   information_schema.column_privileges は
    //   SELECT / INSERT / UPDATE / REFERENCES の4種しか見えない。
    //   **DELETE や TRUNCATE だけを配られていても気づけない。**
    //   relacl を展開すれば、表に付いた権限を種類ごとに漏れなく数えられる。
    //
    // 【PUBLIC を grantee = 0 で見る】
    //   PUBLIC に付いていればどのロールからも読める。
    //   ACL を文字列で照合すると 'anon=arwd/' にも '=arwd/' が含まれて
    //   取り違えるので、grantee の oid で判定する（D34 と同じ理由）。
    // **権限とポリシーを1つの数にまとめない。** 別々の守りなので、
    // まとめるとどちらが破れたのか分からない。ポリシーは次の項目で見る。
    expected: 0,
    sql: TABLE_USER_PRIV_COUNT_SQL,
    params: [["handle_history"]],
    detailSql: TABLE_PRIV_SQL,
    detailParams: [["handle_history"]],
  },
  {
    group: "削除通報",
    name: "handle_history に RLS ポリシーが0本",
    expected: 0,
    sql: `select count(*)::int from pg_policies
           where schemaname='public' and tablename='handle_history'`,
    detailSql: `select policyname, cmd, roles::text as roles
                  from pg_policies
                 where schemaname='public' and tablename='handle_history'
                 order by policyname`,
  },
  {
    group: "削除通報",
    name: "他人が手放した ID を配らない",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='update_my_profile'
             and p.prosrc like '%HANDLE_RETIRED%'
             and p.prosrc like '%public.handle_history%'`,
  },
  {
    group: "削除通報",
    name: "ID の変更が30日に1回に制限されている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='update_my_profile'
             and p.prosrc like '%HANDLE_TOO_SOON%'
             and p.prosrc like '%interval ''30 days''%'`,
  },
  {
    group: "削除通報",
    name: "profiles の保護列を利用者が直接更新できない",
    // 直接書けると、ID の先取り（D55）と30日制限の回避（P5）ができる。
    //
    // 【以前ここを間違えていた】
    //   information_schema.column_privileges で「何か権限があれば失格」に
    //   していた。ところがこのビューは**表単位の grant を全列に展開して
    //   見せる**ため、001 の `grant select on profiles` が
    //   handle_updated_at にも SELECT の行として現れ、必ず失格になった。
    //
    //   見たいのは「読めるか」ではなく「**更新できるか**」。
    //   has_column_privilege なら表単位と列単位の両方をまとめて評価でき、
    //   privilege_type を取り違えようがない。
    expected: 0,
    sql: `select count(*)::int
            from unnest(array['id','handle','handle_updated_at',
                              'is_anonymous','created_at']) as col,
                 unnest(array['anon','authenticated']) as role
           where has_column_privilege(role, 'public.profiles', col, 'UPDATE')`,
    detailSql: `select col, role,
                       has_column_privilege(role, 'public.profiles', col, 'UPDATE') as can_update
                  from unnest(array['id','handle','handle_updated_at',
                                    'is_anonymous','created_at']) as col,
                       unnest(array['anon','authenticated']) as role
                 order by col, role`,
  },
  {
    group: "削除通報",
    name: "公開設定など6列は authenticated から更新できる（壊していない）",
    // 上の revoke で、001 が配った直接更新の権限まで落としていないこと。
    // 落とすと /account の公開設定が動かなくなる（D55 で「取り上げない」と
    // 決めている）。**守りを足したついでに機能を壊していないか**を見る。
    expected: 6,
    sql: `select count(*)::int
            from unnest(array['display_name','bio','links','show_answer_stats',
                              'show_answer_history','show_saved_works']) as col
           where has_column_privilege('authenticated', 'public.profiles', col, 'UPDATE')`,
  },
  {
    group: "削除通報",
    name: "この工程が表を作るロールの既定権限に、利用者向けの権限が無い",
    // 今回の取りこぼしは「書き忘れると権限が付く」構造から生まれた。
    // 既定を逆にして、書き忘れても付かないようにしてある。
    //
    // 【なぜロールを絞るのか】
    //   ALTER DEFAULT PRIVILEGES は**ロールごと**の設定で、
    //   pg_default_acl には所有者ロールぶんの行が並ぶ。Supabase は
    //   postgres と supabase_admin の両方に既定を置くため、
    //   片方を落としてももう片方が残る。
    //
    //   ただし**残った行が危ないとは限らない**。既定が効くのは
    //   「そのロールが表を作ったとき」だけなので、この工程が使わない
    //   内部ロールの行を数えても、防げるものは1つも増えない。
    //   数えれば必ず失敗し続け、本当の失敗が埋もれる。
    //
    //   そこで **実際にこの工程の表を持っているロール**だけを見る。
    //   基準には handle_history を使う。Step 15 の migration が作った表で、
    //   その所有者がまさに「migration が表を作るロール」。
    //
    //   残りの行がどのロールのものかは [一覧] にすべて出す。
    //   数だけでは「本当に危ないのか、対象外の行なのか」が分からない（D66）。
    expected: 0,
    sql: `select count(*)::int
            from pg_default_acl d
            left join pg_namespace n on n.oid = d.defaclnamespace
           -- スキーマを指定せずに設定された既定（defaclnamespace = 0）も
           -- public に効くので、取りこぼさないよう両方見る
           where (n.nspname = 'public' or d.defaclnamespace = 0)
             and d.defaclobjtype = 'r'
             and d.defaclrole = (
                   select c.relowner
                     from pg_class c
                     join pg_namespace n2 on n2.oid = c.relnamespace
                    where n2.nspname = 'public'
                      and c.relname = 'handle_history')
             and exists (
                   select 1 from aclexplode(d.defaclacl) a
                    where a.grantee in (0, 'anon'::regrole::oid,
                                           'authenticated'::regrole::oid))`,
    detailSql: DEFAULT_ACL_SQL,
  },
  {
    group: "削除通報",
    name: "削除は公開から外すのが先（行は消さない）",
    // is_published=false と deleted_at を同時に立てる。
    // delete 文が入っていたら、それは行を消しているということ。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='delete_work'
             and p.prosrc like '%is_published = false%'
             and p.prosrc like '%deleted_at   = now()%'
             and p.prosrc not like '%delete from%'`,
  },
  {
    group: "削除通報",
    name: "削除済みの作品は公開へ戻せない",
    // 画像の削除に失敗しても、作品だけが公開へ戻ることがないようにする。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='update_work'
             and p.prosrc like '%WORK_DELETED%'`,
  },
  {
    group: "削除通報",
    name: "画像の消し残しを見つけられる列がある",
    // Step 16 の掃除が「deleted_at はあるが image_deleted_at が無い」
    // 作品を拾って再試行する。
    expected: 1,
    sql: `select count(*)::int from information_schema.columns
           where table_schema='public' and table_name='works'
             and column_name='image_deleted_at'`,
  },
  {
    group: "削除通報",
    name: "画像を消せた印は削除済みの作品にしか付かない",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='mark_work_image_deleted'
             and p.prosrc like '%w.deleted_at is not null%'`,
  },
  {
    group: "削除通報",
    name: "通報の対象は公開中の作品だけ",
    // 非公開・削除済み・存在しない、を同じ文言で断る（D40）。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='create_report'
             and p.prosrc like '%REPORT_TARGET_NOT_FOUND%'
             and p.prosrc like '%w.is_published%'
             and p.prosrc like '%w.review_status = ''ok''%'
             and p.prosrc like '%w.deleted_at is null%'`,
  },
  {
    group: "削除通報",
    name: "通報にレート制限がある",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='create_report'
             and p.prosrc like '%REPORT_RATE_LIMITED%'
             and p.prosrc like '%REPORT_ALREADY_SENT%'`,
  },
  {
    group: "削除通報",
    name: "通報はゲストも送れる（is_anonymous を見ない）",
    // 通報は「見つけた人が知らせる」行為なので登録を求めない（spec 8-4）。
    // 投稿RPCと条件が逆なので、見ていないことを確かめる。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='create_report'
             and p.prosrc like '%is_anonymous%'`,
  },
  {
    group: "削除通報",
    name: "通報の件数を外へ返していない",
    // 「何件集まると何が起きるか」を外から測らせない。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='create_report'
             and p.prosrc like '%''report_count''%'`,
  },
  {
    group: "削除通報",
    name: "旧ID の読み替えは公開プロフィールにだけ向く",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_handle_redirect'
             and p.prosrc like '%p.is_anonymous = false%'
             and p.prosrc like '%p.handle is not null%'`,
  },

  {
    group: "ランキング",
    name: "get_rankings が存在する",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'`,
  },
  {
    group: "ランキング",
    name: "順位の票数から作者本人のいいねを除いている",
    // 自作へのいいねは禁じていない（D56）。表示用の総数はそれでよいが、
    // 順位に数えると投稿者が自分で1票ぶん押し上げられる。
    // works.likes_count ではなく likes 表を数え直しているのはそのため。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and p.prosrc like '%l.user_id <> w.user_id%'
             and p.prosrc like '%public.likes%'`,
  },
  {
    group: "ランキング",
    name: "公開3条件（公開中・審査OK・未削除）で絞っている",
    // ここが緩むと、下書きや削除済み作品の存在がランキング経由で漏れる。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and p.prosrc like '%w.is_published%'
             and p.prosrc like '%w.review_status = ''ok''%'
             and p.prosrc like '%w.deleted_at is null%'`,
  },
  {
    group: "ランキング",
    name: "伝達率は回答5人以上の作品だけを対象にしている",
    // R6。ブラウザのデータを消せば新しいゲストになれるので、
    // 1人しか答えていない作品が 100% で1位に出ないようにする下限。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and p.prosrc like '%w.answers_count >= 5%'`,
  },
  {
    group: "ランキング",
    name: "時間区分4つが定義されている",
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and p.prosrc like '%''short''%'
             and p.prosrc like '%''medium''%'
             and p.prosrc like '%''long''%'
             and p.prosrc like '%''unlimited''%'`,
  },
  {
    group: "ランキング",
    name: "同点のときも id まで並べ切っている",
    // 最後まで一意に決まらないと、開くたびに順位が入れ替わり、
    // ページ送りで同じ作品が二度出たり一度も出なかったりする。
    // 空白の入れかたに左右されないよう、詰めてから照合する。
    expected: 1,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and regexp_replace(p.prosrc, '\\s+', ' ', 'g')
                 like '%b.created_at desc, b.id desc%'`,
  },
  {
    group: "ランキング",
    name: "お題の制限時間を秒のまま返していない",
    // 区分の文字（short など）だけを返す。prompts への結合は関数の中だけ（D23）。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_rankings'
             and pg_get_function_result(p.oid) ilike '%time_limit_seconds%'`,
  },

  // ──────────────────────── 投稿は登録ユーザーだけ ────────────────────────
  //
  // spec C3 / D27-1。Postgres のロールでは匿名ゲストと登録ユーザーを
  // 区別できないため、この防御は「関数の中の1行」と「ポリシーの中の1行」
  // だけで成り立っている。消えても表面上は動いてしまうので、
  // 定義文そのものに条件式が残っていることを確かめる。
  {
    group: "登録必須",
    name: "書き込みRPCのうち3本が JWT の is_anonymous を見ている",
    // mark_work_image_deleted だけは見ない。**削除済みの自分の作品にしか
    // 印を付けられない**ので、そこへ到達できる時点で登録ユーザーである
    // （ゲストは作品を持てない）。二重に見ても意味が無い。
    expected: 3,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and p.prosrc like '%is_anonymous%'
             and p.prosrc like '%auth.jwt()%'`,
    params: [WRITE_RPCS],
  },
  {
    group: "登録必須",
    name: "Storage への追加ポリシーも is_anonymous を見ている",
    expected: 1,
    sql: `select count(*)::int from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname='works_objects_insert_own'
             and with_check like '%is_anonymous%'`,
  },
  {
    group: "登録必須",
    name: "登録ユーザー限定RPC 4本が JWT の is_anonymous を見ている",
    // update_my_profile … ID の先取りを防ぐ（001 が handle を列権限から外した意図）
    // toggle_like / toggle_save … 人気ランキングを成立させる（D7）
    //
    // Postgres のロールでは匿名ゲストと登録ユーザーを区別できないので、
    // この防御は関数の中の1行だけで成り立っている。消えても表面上は動く。
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and p.prosrc like '%is_anonymous%'
             and p.prosrc like '%auth.jwt()%'`,
    params: [MEMBER_RPCS],
  },
  {
    group: "登録必須",
    name: "書き込みRPCが profiles.is_anonymous で判定していない",
    // 表の値ではなく JWT で判定する（spec 9-1）。
    // profiles を参照していれば、その経路が混ざっている疑いがある。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and p.prosrc like '%public.profiles%'`,
    params: [WRITE_RPCS],
  },

  // ───────────────────────────── Storage ─────────────────────────────
  {
    group: "Storage",
    name: "works バケットが存在し、公開読み取りである",
    expected: 1,
    sql: `select count(*)::int from storage.buckets
           where id='works' and public`,
  },
  {
    group: "Storage",
    name: "works バケットの上限が 5MiB",
    expected: 5242880,
    sql: `select file_size_limit::int from storage.buckets where id='works'`,
  },
  {
    group: "Storage",
    name: "works バケットが画像3種しか受け付けない",
    expected: 3,
    sql: `select coalesce(array_length(allowed_mime_types, 1), 0)::int
            from storage.buckets where id='works'`,
  },
  {
    group: "Storage",
    name: "画像以外の MIME が許可されていない",
    expected: 0,
    sql: `select count(*)::int from storage.buckets b,
                unnest(coalesce(b.allowed_mime_types, '{}'::text[])) m
           where b.id='works'
             and m not in ('image/jpeg','image/png','image/webp')`,
  },
  {
    group: "Storage",
    name: "works 用ポリシーが4本ある",
    expected: 4,
    sql: `select count(*)::int from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname = any($1)`,
    params: [STORAGE_POLICIES],
  },
  {
    group: "Storage",
    name: "追加・更新・削除は自分のフォルダに限られている",
    expected: 3,
    sql: `select count(*)::int from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname in ('works_objects_insert_own',
                                'works_objects_update_own',
                                'works_objects_delete_own')
             and coalesce(qual, '') || coalesce(with_check, '')
                 like '%foldername%'`,
  },
  {
    group: "Storage",
    name: "storage.objects へ anon の書き込みポリシーが無い",
    // anon（未サインイン）に許してよいのは読み取りだけ。
    expected: 0,
    sql: `select count(*)::int from pg_policies
           where schemaname='storage' and tablename='objects'
             and policyname = any($1)
             and cmd <> 'SELECT'
             and 'anon' = any(roles)`,
    params: [STORAGE_POLICIES],
  },

  // ───────────────────────── 漏洩経路の封鎖 ─────────────────────────
  {
    group: "漏洩",
    name: "取得系RPCの返り値に prompt_id が現れない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname like 'get\\_%'
             and pg_get_function_result(p.oid) ilike '%prompt_id%'`,
  },
  {
    group: "漏洩",
    name: "取得系RPCが prompt_id を JSON キーに出さない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname like 'get\\_%'
             and p.prosrc like '%''prompt_id''%'`,
  },
  {
    group: "漏洩",
    name: "書き込みRPCも prompt_id を JSON キーに出さない",
    // create_work は引数で prompt_id を受け取るが、返り値には含めない（D23）。
    // 列名としての prompt_id は出てよいので、JSON キーの形
    // （引用符で囲まれた 'prompt_id'）だけを探す。
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and p.prosrc like '%''prompt_id''%'`,
    params: [WRITE_RPCS],
  },
  {
    group: "漏洩",
    name: "submit_answer も prompt_id を JSON キーに出さない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and p.prosrc like '%''prompt_id''%'`,
    params: [ANSWER_RPCS],
  },
  {
    group: "漏洩",
    name: "prompt_cards（＝答え）に触れる関数が4本のまま",
    // 内訳は complete_draft（書く）／ get_my_prompt（本人のお題）／
    // get_my_answer（回答済み本人へ正解を返す）／
    // get_saved_works（回答済みの作品だけお題を添える。Step 14）の4本だけ。
    //
    // submit_answer はここに入らない。正解の組み立てはせず、
    // 最後に get_my_answer を呼ぶだけだからで、それが狙いどおりであることを
    // この数で確かめている。5本目が増えたら、それが新しい漏洩経路になりうる。
    //
    // **数を増やすのは意図した変更のときだけ。** 下の「回答済み判定」の項目と
    // 対で見ること（本数が増えても、無条件に読む関数は許さない）。
    expected: 4,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public'
             and p.prosrc like '%public.prompt_cards%'`,
    detailSql: `select p.proname from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname='public'
                   and p.prosrc like '%public.prompt_cards%'
                 order by p.proname`,
  },
  {
    group: "漏洩",
    name: "get_work_quiz が is_correct に触れない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='get_work_quiz'
             and p.prosrc like '%is_correct%'`,
  },
  {
    group: "漏洩",
    name: "どのRPCも tags.weight を読まない",
    expected: 0,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public'
             and p.proname = any($1)
             and p.prosrc like '%weight%'`,
    params: [[...PUBLIC_RPCS, ...OWNER_RPCS]],
  },
  {
    group: "漏洩",
    name: "draft_state_json が未公開カードを隠している",
    expected: 2,
    sql: `select (length(p.prosrc) - length(replace(p.prosrc,
             'when dc.revealed_at is null then null', '')))
             / length('when dc.revealed_at is null then null')
           from pg_proc p
             join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname='draft_state_json'`,
  },
];

/**
 * Step 3E の必須診断。すべて0行なら正常。
 * 表が空のうちは当然0行だが、データが入り始めてから効いてくる。
 */
export const diagnostics = [
  {
    id: "A1",
    label: "正解がちょうど1件でない問",
    sql: `select qq.id from public.quiz_questions qq
           where (select count(*) from public.quiz_choices qc
                   where qc.question_id = qq.id and qc.is_correct) <> 1`,
  },
  {
    id: "A2",
    label: "選択肢が4件でない問",
    sql: `select qq.id from public.quiz_questions qq
           where (select count(*) from public.quiz_choices qc
                   where qc.question_id = qq.id) <> 4`,
  },
  {
    id: "A3",
    label: "正解タグが答えと一致しない問",
    sql: `select qq.id
            from public.quiz_questions qq
            join public.quiz_choices qc on qc.question_id = qq.id and qc.is_correct
            join public.prompt_cards pc on pc.prompt_id = qq.prompt_id
                                       and pc.card_slot_key = qq.card_slot_key
           where qc.tag_id <> pc.tag_id`,
  },
  {
    id: "A4",
    label: "答えの枚数がモードの枠数と合わないお題",
    sql: `select p.id from public.prompts p
           where (select count(*) from public.prompt_cards pc where pc.prompt_id = p.id)
              <> (select count(*) from public.draft_mode_slots dms
                   where dms.mode_key = p.mode_key)`,
  },
  {
    id: "A5",
    label: "submitted なのに作品が無いお題",
    sql: `select p.id from public.prompts p
           where p.status = 'submitted'
             and not exists (select 1 from public.works w where w.prompt_id = p.id)`,
  },
  {
    id: "A6",
    label: "correct_count が内訳の正解数と合わない回答",
    sql: `select a.id from public.answers a
           where a.correct_count <> (select count(*) from public.answer_items ai
                                      where ai.answer_id = a.id and ai.is_correct)`,
  },
  {
    id: "A7",
    label: "内訳の件数が問題数と合わない回答",
    sql: `select a.id from public.answers a
            join public.works w on w.id = a.work_id
           where (select count(*) from public.answer_items ai where ai.answer_id = a.id)
              <> (select count(*) from public.quiz_questions q where q.prompt_id = w.prompt_id)`,
  },
  {
    id: "A8",
    label: "answers_count が実件数と合わない作品",
    sql: `select w.id from public.works w
           where w.answers_count <> (select count(*) from public.answers a
                                      where a.work_id = w.id)`,
  },
  {
    id: "A9",
    label: "内訳の枠が問の枠と一致しない",
    sql: `select ai.id from public.answer_items ai
            join public.quiz_questions q on q.id = ai.question_id
           where ai.card_slot_key <> q.card_slot_key`,
  },
  {
    id: "A10",
    label: "いいね／保存の持ち主が匿名ユーザー",
    sql: `select l.work_id::text from public.likes l
            join public.profiles pf on pf.id = l.user_id where pf.is_anonymous
          union all
          select s.work_id::text from public.saves s
            join public.profiles pf on pf.id = s.user_id where pf.is_anonymous`,
  },
  {
    id: "A11",
    label: "likes_count / saves_count が実件数と合わない作品",
    sql: `select w.id from public.works w
           where w.likes_count <> (select count(*) from public.likes l where l.work_id = w.id)
              or w.saves_count <> (select count(*) from public.saves s where s.work_id = w.id)`,
  },
  {
    id: "A12",
    label: "search_path 未固定の security definer 関数",
    sql: `select p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.prosecdef
             and not exists (select 1 from unnest(coalesce(p.proconfig,'{}')) c
                              where c like 'search\\_path=%')`,
  },
  {
    id: "A13",
    label: "同一世代でタグが重複しているドラフト",
    sql: `select dc.session_id::text from public.draft_candidates dc
           group by dc.session_id, dc.generation, dc.tag_id having count(*) > 1`,
  },
  {
    id: "A14",
    label: "1枠に2枚以上選ばれているドラフト",
    sql: `select dc.session_id::text from public.draft_candidates dc
           where dc.is_chosen
           group by dc.session_id, dc.generation, dc.card_slot_key having count(*) > 1`,
  },

  // --- Step 7 で足した4本 ---------------------------------------------------
  {
    id: "A15",
    label: "image_path が投稿者の領域を指していない作品",
    // spec 8-6 の {user_id}/{work_id}.{ext} から外れた行。
    // create_work の検査6を通っていれば発生しない。
    sql: `select w.id from public.works w
           where w.image_path !~ ('^' || w.user_id::text || '/' || w.id::text
                                      || '\\.(jpg|jpeg|png|webp)$')`,
  },
  {
    id: "A16",
    label: "匿名ゲストが投稿している作品",
    // spec C3 / D27-1。RPC と Storage ポリシーの両方が破られないと起きない。
    sql: `select w.id from public.works w
            join public.profiles pf on pf.id = w.user_id
           where pf.is_anonymous`,
  },
  {
    id: "A17",
    label: "作品があるのに未選択カードが未開示のお題",
    // D8 / §9-4。create_work が開示まで行うので、作品があれば必ず開示済み。
    sql: `select p.id from public.prompts p
            join public.works w on w.prompt_id = p.id
           where p.candidates_revealed_at is null`,
  },
  {
    id: "A18",
    label: "作品があるのに status が submitted でないお題",
    sql: `select p.id from public.prompts p
            join public.works w on w.prompt_id = p.id
           where p.status <> 'submitted'`,
  },

  // --- Step 10 / 11 で足した4本 ---------------------------------------------
  {
    id: "A19",
    label: "作者が自分の作品に回答している（D28 違反）",
    // submit_answer の検査3を通っていれば発生しない。
    sql: `select a.id::text from public.answers a
            join public.works w on w.id = a.work_id
           where a.user_id = w.user_id`,
  },
  {
    id: "A20",
    label: "user_stats が実データと合わない",
    sql: `select us.user_id::text from public.user_stats us
           where us.total_answers <> (
                   select count(*) from public.answers a
                    where a.user_id = us.user_id)
              or us.total_items <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.user_id = us.user_id)
              or us.total_correct_items <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.user_id = us.user_id and ai.is_correct)`,
  },
  {
    id: "A21",
    label: "work_slot_stats が実データと合わない",
    sql: `select st.work_id::text from public.work_slot_stats st
           where st.attempts <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.work_id = st.work_id
                      and ai.card_slot_key = st.card_slot_key)
              or st.corrects <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.work_id = st.work_id
                      and ai.card_slot_key = st.card_slot_key
                      and ai.is_correct)`,
  },
  {
    id: "A22",
    label: "user_slot_stats が実データと合わない",
    sql: `select uss.user_id::text from public.user_slot_stats uss
           where uss.attempts <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.user_id = uss.user_id
                      and ai.card_slot_key = uss.card_slot_key)
              or uss.corrects <> (
                   select count(*) from public.answer_items ai
                     join public.answers a on a.id = ai.answer_id
                    where a.user_id = uss.user_id
                      and ai.card_slot_key = uss.card_slot_key
                      and ai.is_correct)`,
  },
  {
    id: "A23",
    label: "選択肢のタグが重複しているお題（重複禁止の適用後に作られたぶん）",
    // 同じタグが2つの問に出ると、そのタグはどちらでも不正解だと確定する。
    //
    // **既存クイズは作り直さない方針**（回答済みの selected_tag_id が
    // 存在しない選択肢を指しうるため）。だから適用前のぶんは対象外にする。
    // 対象外にしたぶんの件数は notices の legacy 側で別途表示する。
    //
    // 境目を id で見るのは、時計のずれや「ファイル名の日時 ≠ 適用時刻」で
    // 判定が揺れないようにするため。1つのお題の選択肢は1トランザクションで
    // まとめて入るので、お題が境目をまたぐこともない。
    sql: `select qq.prompt_id::text
            from public.quiz_questions qq
            join public.quiz_choices qc on qc.question_id = qq.id
           where qc.id > public.quiz_choice_dedupe_cutoff()
           group by qq.prompt_id
          having count(distinct qc.tag_id) <> count(*)`,
  },
  {
    id: "A24",
    label: "伝達率の2つの数え方が食い違う作品",
    // ランキングの伝達率は work_slot_stats（枠ごとの集計）を足して出す。
    // 仕様上の定義は「correct_count の合計 ÷ 回答項目数の合計」で、
    // 両者は同じ値になるはず。**軽いほうを使う代わりに、一致を見張る。**
    //
    // A21 は work_slot_stats と answer_items を突き合わせるが、
    // answers.correct_count 側は見ていない。ここで3つを閉じる。
    sql: `select w.id::text from public.works w
           where coalesce((select sum(st.corrects)::bigint
                             from public.work_slot_stats st
                            where st.work_id = w.id), 0)
                 <> coalesce((select sum(a.correct_count)::bigint
                                from public.answers a
                               where a.work_id = w.id), 0)
              or coalesce((select sum(st.attempts)::bigint
                             from public.work_slot_stats st
                            where st.work_id = w.id), 0)
                 <> (select count(*) from public.answer_items ai
                       join public.answers a on a.id = ai.answer_id
                      where a.work_id = w.id)`,
  },
  {
    id: "A25",
    label: "削除済みなのに公開されたままの作品",
    // delete_work は is_published=false と deleted_at を同時に立てる。
    // 片方だけの行があるなら、削除の順序が崩れているということ。
    sql: `select w.id::text from public.works w
           where w.deleted_at is not null and w.is_published`,
  },
  {
    id: "A26",
    label: "いま現役の ID が、手放した控えにも残っている",
    // 取り戻した ID の控えは消している。両方に居る行があると
    // 「いまの ID なのに旧IDでもある」という二重の状態になり、
    // 旧ID の読み替えが自分自身を指す。
    sql: `select h.handle from public.handle_history h
            join public.profiles p on p.handle = h.handle`,
  },
  {
    id: "A27",
    label: "画像を消した印があるのに削除されていない作品",
    // 掃除の対象から外れているのに、作品はまだ生きている状態。
    // 画像だけが欠けた作品になる。
    sql: `select w.id::text from public.works w
           where w.image_deleted_at is not null and w.deleted_at is null`,
  },
];

/**
 * 合否をつけずに数だけ見せる項目。
 *
 * 「0 であってほしいが、いまは 0 でないことが正しい」ものを置く。
 * checks に混ぜると常に失敗し、本当の失敗が埋もれてしまう。
 */
export const notices = [
  {
    label: "選択肢が重複しているお題（重複禁止より前に作られたぶん・legacy）",
    sql: `select count(*)::int from (
            select qq.prompt_id
              from public.quiz_questions qq
              join public.quiz_choices qc on qc.question_id = qq.id
             where qc.id <= public.quiz_choice_dedupe_cutoff()
             group by qq.prompt_id
            having count(distinct qc.tag_id) <> count(*)
          ) x`,
    note:
      "既存クイズは作り直さないため、この件数は 0 になりません（意図した状態）。" +
      "回答済みの selected_tag_id が、存在しない選択肢を指すのを避けるためです。",
  },
  {
    label: "重複禁止より前に作られたお題の総数",
    sql: `select count(distinct qq.prompt_id)::int
            from public.quiz_questions qq
            join public.quiz_choices qc on qc.question_id = qq.id
           where qc.id <= public.quiz_choice_dedupe_cutoff()`,
    note: "上の件数はこのうちの何件か、という見かたをします。",
  },
  {
    label: "重複禁止のあとに作られたお題の総数",
    sql: `select count(distinct qq.prompt_id)::int
            from public.quiz_questions qq
            join public.quiz_choices qc on qc.question_id = qq.id
           where qc.id > public.quiz_choice_dedupe_cutoff()`,
    note: "こちらは診断 A23 が 0 件であることを厳格に見ています。",
  },
];

/**
 * 合否をつけず、**中身をそのまま並べて見せる**項目。
 *
 * notices（数を1つ出す）と違い、行をすべて出す。
 * 「0件であること」を検査するだけでは、**本当に何も無いのか、
 * 数え方を間違えているのか**が読み取れない。目で見て確かめるための欄。
 *
 * emptyNote は0行のときに出す文言。0行が正常な項目では、
 * 何も出ないことが正常だと分かるようにする。
 */
export const listings = [
  {
    // 件数の検査は「合っているか」しか言わない。
    // 内訳と重みの散らばりは、目で見ないと崩れに気づけない。
    label: "タグの内訳（プール別・重み別）",
    sql: `select pool_key,
                 count(*)::int as active,
                 count(*) filter (where weight = 140)::int as w140_骨格,
                 count(*) filter (where weight = 100)::int as w100_既定,
                 count(*) filter (where weight =  70)::int as w70_抑制,
                 count(*) filter (where weight =  45)::int as w45_希少,
                 sum(weight)::int as 重み合計
            from public.tags
           where is_active
           group by pool_key
           order by count(*) desc`,
    note:
      "正しい姿は motif 102 / color 15 / species 24 / genre 15 の計156件。" +
      "重み合計は、標準モード1回でそのタグが候補に並ぶ確率の分母になる" +
      "（使う件数 × weight ÷ 重み合計）。原案は docs/tags-master.md。",
  },
  {
    label: "profiles の権限（grantee 別）",
    sql: TABLE_PRIV_SQL,
    params: [["profiles"]],
    note:
      "表単位の SELECT が anon / authenticated に、列単位の UPDATE が" +
      "authenticated の6列だけに付いているのが正しい状態（001 の設計）。" +
      "handle / handle_updated_at / id / is_anonymous / created_at に" +
      "UPDATE が現れたら異常。",
  },
  {
    label: "handle_history の権限（grantee 別）",
    sql: TABLE_PRIV_SQL,
    params: [["handle_history"]],
    emptyNote:
      "0行が正常。PUBLIC / anon / authenticated には何も配らない（P5 / D62）。" +
      "service_role と所有者の権限はここに出ない（対象外）。",
  },
  {
    label: "handle_history の RLS ポリシー",
    sql: `select policyname, cmd, roles::text as roles, permissive
            from pg_policies
           where schemaname='public' and tablename='handle_history'
           order by policyname`,
    emptyNote:
      "0行が正常。RLS は有効だがポリシーが0本なので、" +
      "security definer の RPC 以外からは1行も見えない。",
  },
  {
    label: "public スキーマの既定権限（所有者ロール別・すべて）",
    sql: DEFAULT_ACL_SQL,
    note:
      "既定権限は**ロールごと**の設定。効くのは「そのロールがオブジェクトを" +
      "作ったとき」だけなので、この工程が使わない内部ロール" +
      "（supabase_admin など）の行が残っていても、こちらの守りには影響しない。" +
      "見るべきは、migration が表を作るロール（handle_history の所有者）の行。" +
      "そこに PUBLIC / anon / authenticated が出ていたら異常。",
    emptyNote:
      "0行なら、Supabase の既定（新しいオブジェクトへ ALL を自動で配る）が" +
      "すべて打ち消されている状態。",
  },
  {
    label: "この工程の表を持っているロール（既定権限を見る基準）",
    sql: `select pg_get_userbyid(c.relowner) as owner_role,
                 count(*)::int              as tables
            from pg_class c
            join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r'
           group by 1
           order by 2 desc`,
    note:
      "ここに出るロールが表を作る。上の一覧のうち、このロールの行だけが" +
      "こちらの守りに関係する。",
  },
];

/**
 * 実際にロールを切り替えて呼んでみる項目。
 * mode: 'denied' … permission denied になるのが正しい
 *       'allowed' … エラーにならないのが正しい
 */
export const roleProbes = [
  ...SEALED_TABLES.flatMap((t) =>
    ["anon", "authenticated"].map((role) => ({
      role,
      mode: "denied",
      label: `${role} → ${t} を直接SELECT`,
      sql: `select 1 from public.${t} limit 1`,
    })),
  ),
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_public_works",
    sql: `select * from public.get_public_works(null,'new',5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_work_detail",
    sql: `select public.get_work_detail('00000000-0000-0000-0000-000000000000')`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_work_quiz",
    sql: `select public.get_work_quiz('00000000-0000-0000-0000-000000000000')`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_public_saves",
    sql: `select * from public.get_public_saves('00000000-0000-0000-0000-000000000000',5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_rankings（人気）",
    sql: `select * from public.get_rankings('popular','normal',null,5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_public_profile",
    sql: `select public.get_public_profile('no-such-handle')`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_handle_redirect",
    sql: `select public.get_handle_redirect('no-such-handle')`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_user_works",
    sql: `select * from public.get_user_works(
            '00000000-0000-0000-0000-000000000000','original','new',5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_saved_works",
    sql: `select * from public.get_saved_works(
            '00000000-0000-0000-0000-000000000000',5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_public_answers",
    sql: `select * from public.get_public_answers(
            '00000000-0000-0000-0000-000000000000',5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_rankings（伝達率）",
    sql: `select * from public.get_rankings('accuracy','normal',null,5,0)`,
  },
  {
    role: "anon",
    mode: "allowed",
    label: "anon → get_rankings（時間別・AI部門）",
    sql: `select * from public.get_rankings('duration','ai','short',5,0)`,
  },
  ...OWNER_RPCS.map((fn) => ({
    role: "anon",
    mode: "denied",
    label: `anon → ${fn}`,
    sql:
      fn.endsWith("s") && fn !== "get_my_reaction"
        ? `select * from public.${fn}(5,0)`
        : `select public.${fn}('00000000-0000-0000-0000-000000000000')`,
  })),
  ...DRAFT_RPCS.map((fn) => ({
    role: "anon",
    mode: "denied",
    label: `anon → ${fn}`,
    sql:
      fn === "start_draft"
        ? `select public.start_draft('easy', null)`
        : fn === "reveal_card"
          ? `select public.reveal_card('00000000-0000-0000-0000-000000000000','motif_a',0)`
          : fn === "get_current_draft"
            ? `select public.get_current_draft()`
            : `select public.${fn}('00000000-0000-0000-0000-000000000000')`,
  })),
  {
    role: "anon",
    mode: "denied",
    label: "anon → create_work",
    sql: `select public.create_work(
            '00000000-0000-0000-0000-000000000000'::uuid,
            '00000000-0000-0000-0000-000000000000'::uuid,
            'title', 'x/y.png', 1, 1, 'original')`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → update_work",
    sql: `select public.update_work('00000000-0000-0000-0000-000000000000'::uuid)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → delete_work",
    sql: `select public.delete_work('00000000-0000-0000-0000-000000000000'::uuid)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → mark_work_image_deleted",
    sql: `select public.mark_work_image_deleted(
            '00000000-0000-0000-0000-000000000000'::uuid)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → create_report（未サインインは送れない）",
    sql: `select public.create_report(
            '00000000-0000-0000-0000-000000000000'::uuid, 'spam', null)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → submit_answer",
    sql: `select public.submit_answer(
            '00000000-0000-0000-0000-000000000000'::uuid, '[]'::jsonb)`,
  },
  ...STATS_TRIGGERS.map((fn) => ({
    role: "authenticated",
    mode: "denied",
    label: `authenticated → ${fn}（トリガー専用）`,
    sql: `select public.${fn}()`,
  })),
  ...META_FUNCS.map((fn) => ({
    role: "authenticated",
    mode: "denied",
    label: `authenticated → ${fn}（検証用）`,
    sql: `select public.${fn}()`,
  })),
  ...COUNT_TRIGGERS.map((fn) => ({
    role: "authenticated",
    mode: "denied",
    label: `authenticated → ${fn}（トリガー専用）`,
    sql: `select public.${fn}()`,
  })),
  {
    role: "anon",
    mode: "denied",
    label: "anon → update_my_profile",
    sql: `select public.update_my_profile('taro', null, null, null)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → update_my_visibility",
    sql: `select public.update_my_visibility(true, true, true)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → toggle_like",
    sql: `select public.toggle_like('00000000-0000-0000-0000-000000000000'::uuid)`,
  },
  {
    role: "anon",
    mode: "denied",
    label: "anon → toggle_save",
    sql: `select public.toggle_save('00000000-0000-0000-0000-000000000000'::uuid)`,
  },
  ...INTERNAL_FUNCS.map((fn) => ({
    role: "authenticated",
    mode: "denied",
    label: `authenticated → ${fn}（内部専用）`,
    sql:
      fn === "draft_state_json"
        ? `select public.draft_state_json('00000000-0000-0000-0000-000000000000')`
        : `select public.draft_generate_candidates('00000000-0000-0000-0000-000000000000',1,'easy',3)`,
  })),
];
