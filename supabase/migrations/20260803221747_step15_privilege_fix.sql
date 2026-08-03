-- ============================================================================
-- step15_privilege_fix ／ handle_history の権限を落とし、再発を防ぐ
-- ============================================================================
--
-- 【このファイルがやること】
--   1. handle_history から利用者向けの権限をすべて落とす
--   2. profiles の保護列に UPDATE が付いていないことを、明示的に確かめ直す
--   3. **今後 public に作る表へ権限が自動で付かないようにする**（再発防止）
--
-- 【このファイルがやらないこと】
--   ・表・列・制約・データに一切触れない
--   ・関数に触れない
--   ・service_role と所有者（postgres）の権限には触れない
--   ・**利用者がいま直接更新できる6列の権限を落とさない**
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/018_step15_privilege_fix_rollback.sql
--   （ただし戻すと権限が開く。理由はそのファイルに書いた）
--
--
-- ============================================================================
-- 何が起きていたか
-- ============================================================================
--
--   db:verify が2項目で失敗した。
--
--     handle_history に権限もポリシーも無い      期待 0 / 実際 24
--     handle_updated_at を直接書き換えられない   期待 0 / 実際 2
--
--   数が理由をそのまま示している。
--
--   【24 = 3列 × 4種 × 2ロール】… **本物の権限**
--
--     Supabase は public スキーマに作られた表へ、既定で
--     anon / authenticated / service_role に ALL を自動で付ける。
--
--     001〜006 の遮断表はこれを打ち消すため、例外なく
--     `revoke all on <表> from anon, authenticated` を流していた。
--     Step 15 の migration は create table だけで、**その1行を書き忘れた。**
--
--     列単位で数えられる権限は SELECT / INSERT / UPDATE / REFERENCES の4種。
--     handle_history は3列なので 3 × 4 × 2 = 24。ぴったり合う。
--
--     いま実害が出ていないのは RLS が有効でポリシーが0本だから。
--     ただしこれは D20 が警告していた状態そのもので、
--     **誰かが「読めないので」とポリシーを1本足した瞬間に開く。**
--     権限が無ければ、ポリシーを足しても読めない。
--
--   【2 = 1列 × SELECT × 2ロール】… **検査式の誤り**
--
--     001 は profiles に2種類の権限を配っている。
--
--       grant select on public.profiles to anon, authenticated;   ← 表単位
--       grant update (6列) on public.profiles to authenticated;   ← 列単位
--
--     information_schema.column_privileges は**表単位の grant を
--     全列に展開して見せる**。だから新しい handle_updated_at にも
--     SELECT の行が2件出る。UPDATE は列単位でしか配っていないので、
--     この列は最初から直接更新できない。
--
--     つまり DB は正しく、検査が privilege_type を絞っていなかった。
--     検査式は db-checks.mjs 側で直す。ここでは念のため、
--     保護列に UPDATE が無いことを明示的な revoke で固定しておく。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. handle_history ／ 利用者向けの権限をすべて落とす
-- ----------------------------------------------------------------------------
--
-- 001〜006 の遮断表と同じ形にそろえる。
--
-- **public（＝全ロール）も対象に入れる。** Supabase の既定は
-- anon / authenticated / service_role だけだが、PUBLIC に付いていれば
-- どのロールからも読めてしまうので、まとめて落とす。
--
-- service_role と所有者には触らない（001 と同じ方針）。
-- 管理用の経路まで塞ぐと、運営の調査ができなくなる。

revoke all on public.handle_history from public, anon, authenticated;

comment on table public.handle_history is
  '手放された ID の控え。他人による再取得を防ぐ（P5 / D62）。'
  '権限もポリシーも与えない。読むのは RPC 2本だけ。';


-- ----------------------------------------------------------------------------
-- 2. profiles ／ 保護列に UPDATE が無いことを固定する
-- ----------------------------------------------------------------------------
--
-- いま UPDATE が付いているのは 001 が列単位で配った6列だけで、
-- ここに挙げる列には最初から付いていない。**この revoke は何も落とさない。**
--
-- それでも書くのは、将来 `grant update on public.profiles to authenticated`
-- のような表単位の grant を足したときに、この行が「その列は違う」という
-- 意思表示として残るため。実際の守りは db:verify の
-- has_column_privilege 検査が担う（付いたら気づける）。
--
-- 【保護列とその理由】
--   id                … 行の持ち主。変えられると他人の行を乗っ取れる
--   handle            … ID の先取りを防ぐ（001 の設計 / D55）
--   handle_updated_at … 30日制限の基準。ずらせると制限が無意味になる（P5）
--   is_anonymous      … 公開範囲の判定に使う（D12 / D13）
--   created_at        … 記録の改ざんを許さない

revoke update (id)                on public.profiles from public, anon, authenticated;
revoke update (handle)            on public.profiles from public, anon, authenticated;
revoke update (handle_updated_at) on public.profiles from public, anon, authenticated;
revoke update (is_anonymous)      on public.profiles from public, anon, authenticated;
revoke update (created_at)        on public.profiles from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 直接更新してよい6列を配り直す（落としていないことの確認を兼ねる）
-- ----------------------------------------------------------------------------
--
-- **上の revoke で公開設定の更新が壊れていないこと**を、ここで確定させる。
-- 001 と同じ内容をもう一度流すだけなので、何度実行しても同じ結果になる。
--
-- update_my_visibility は security definer なので、この権限が無くても動く。
-- それでも配り直すのは、001 が「直接更新できる列」として決めた設計を
-- この工程で黙って変えないため（D55 で「取り上げない」と決めている）。

grant update (
  display_name,
  bio,
  links,
  show_answer_stats,
  show_answer_history,
  show_saved_works
) on public.profiles to authenticated;


-- ----------------------------------------------------------------------------
-- 4. 今後作る表へ権限が自動で付かないようにする（再発防止）
-- ----------------------------------------------------------------------------
--
-- 今回の取りこぼしは「書き忘れると権限が付く」構造から生まれた。
-- 既定を逆にして、**書き忘れても付かない**ようにする。
--
-- 20260803021911 が関数に対して同じことをしている。その表版。
--
-- 【効き方（注意点）】
--   ・この設定は「**このロールが今後作る**表」に効く
--   ・すでにある22表には遡って効かない
--     → だから第1節で handle_history を明示的にかけ直した
--   ・今後、利用者に見せたい表を作るときは、これまでどおり
--     作成時に明示的に grant する。**明示が必要になるのが狙い**
--
-- service_role には触らない。管理用の経路は残す。

alter default privileges in schema public
  revoke all on tables from anon, authenticated;


-- ============================================================================
-- 確認用（実行は任意。db:verify が同じことを見ている）
-- ============================================================================
--
-- ① handle_history の権限を grantee 別に並べる（0行が正常）
--
-- select coalesce(nullif(a.grantee::regrole::text, '-'), 'PUBLIC') as grantee,
--        a.privilege_type
--   from pg_class c
--   join pg_namespace n on n.oid = c.relnamespace,
--        aclexplode(c.relacl) a
--  where n.nspname = 'public' and c.relname = 'handle_history'
--    and a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid);
--
-- ② profiles の保護列に UPDATE が無いこと（すべて false）
--
-- select c.column_name, r.role,
--        has_column_privilege(r.role, 'public.profiles', c.column_name, 'UPDATE')
--   from unnest(array['id','handle','handle_updated_at',
--                     'is_anonymous','created_at']) as c(column_name),
--        unnest(array['anon','authenticated']) as r(role);
--
-- ③ 直接更新してよい6列は authenticated から更新できること（すべて true）
--
-- select c.column_name,
--        has_column_privilege('authenticated', 'public.profiles', c.column_name, 'UPDATE')
--   from unnest(array['display_name','bio','links','show_answer_stats',
--                     'show_answer_history','show_saved_works']) as c(column_name);
