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

/** 誰も直接読めない11表 */
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
export const WRITE_RPCS = ["create_work", "update_work"];

/**
 * 回答の書き込みRPC（authenticated のみ）。
 *
 * **WRITE_RPCS とは分けている。** 作品の投稿は登録ユーザー限定だが、
 * 回答は匿名ゲストにも許す（spec 10 の権限表）。
 * 同じ配列に入れると「is_anonymous を見ているか」の検査が
 * 回答RPCまで巻き込んでしまい、意味が逆になる。
 */
export const ANSWER_RPCS = ["submit_answer"];

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

export const checks = [
  // ───────────────────────────── 構造 ─────────────────────────────
  {
    group: "構造",
    name: "public スキーマの表が21個",
    expected: 21,
    sql: `select count(*)::int from pg_tables where schemaname = 'public'`,
  },
  {
    group: "構造",
    name: "遮断11表がすべて存在する",
    expected: SEALED_TABLES.length,
    sql: `select count(*)::int from pg_tables
           where schemaname = 'public' and tablename = any($1)`,
    params: [SEALED_TABLES],
  },
  {
    group: "構造",
    name: "21表すべてで RLS が有効",
    expected: 21,
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
    name: "遮断11表に anon/authenticated の権限が0件",
    expected: 0,
    sql: `select count(*)::int from information_schema.column_privileges
           where table_schema = 'public'
             and table_name = any($1)
             and grantee in ('anon','authenticated')`,
    params: [SEALED_TABLES],
  },
  {
    group: "権限",
    name: "遮断11表に RLS ポリシーが0本",
    expected: 0,
    sql: `select count(*)::int from pg_policies
           where schemaname = 'public' and tablename = any($1)`,
    params: [SEALED_TABLES],
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
    name: "公開4本は anon から実行できる",
    expected: 4,
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
    name: "書き込みRPC 2本が存在する",
    expected: 2,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)`,
    params: [WRITE_RPCS],
  },
  {
    group: "関数",
    name: "書き込みRPC 2本は authenticated から実行できる",
    expected: 2,
    sql: `select count(*)::int from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
           where n.nspname='public' and p.proname = any($1)
             and has_function_privilege('authenticated', p.oid, 'EXECUTE')`,
    params: [WRITE_RPCS],
  },
  {
    group: "関数",
    name: "書き込みRPC 2本は anon から実行できない",
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

  // ──────────────────────── 投稿は登録ユーザーだけ ────────────────────────
  //
  // spec C3 / D27-1。Postgres のロールでは匿名ゲストと登録ユーザーを
  // 区別できないため、この防御は「関数の中の1行」と「ポリシーの中の1行」
  // だけで成り立っている。消えても表面上は動いてしまうので、
  // 定義文そのものに条件式が残っていることを確かめる。
  {
    group: "登録必須",
    name: "書き込みRPC 2本が JWT の is_anonymous を見ている",
    expected: 2,
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
    name: "prompt_cards（＝答え）に触れる関数が3本のまま",
    // 内訳は complete_draft（書く）／ get_my_prompt（本人のお題）／
    // get_my_answer（回答済み本人へ正解を返す）の3本だけ。
    //
    // submit_answer はここに入らない。正解の組み立てはせず、
    // 最後に get_my_answer を呼ぶだけだからで、それが狙いどおりであることを
    // この数で確かめている。4本目が増えたら、それが新しい漏洩経路になりうる。
    expected: 3,
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
