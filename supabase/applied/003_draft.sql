-- ============================================================================
-- 003_draft.sql  ／ Step 3B-2a: ドラフト2表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. draft_sessions（ドラフトの進行状態）を作る
--   2. draft_candidates（伏せカードの中身【機密】）を作る
--   3. updated_at を自動更新するトリガーを付ける
--   4. RLS と権限を設定する
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（両表とも 0 行のまま）
--   ・抽選やめくる処理（RPC）を作らない。それは Step 4
--   ・既存の6表（profiles とマスタ5表）に一切触れない
--   ・prompt_id 列を持たない。お題との接続は 3B-2b で
--     prompts.draft_session_id として行う
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。初回実行が途中で失敗した場合は、
--   原因を直してからもう一度まるごと実行できる。
--
-- 【重要：正常終了した番号付きマイグレーションは再実行しない】
--   create table に if not exists を付けていない。すでに表がある状態で
--   実行すると「already exists」で止まる。これは意図した動作。
--   やり直すときは 003_draft_rollback.sql で消してから流し直す。
--
-- 【取り消し】
--   003_draft_rollback.sql を実行する。
--
--
-- 【この工程でいちばん大事なこと】
--
--   draft_candidates は「まだめくっていないカードの中身」を持つ。
--   これが漏れると、カードをめくる体験そのものが成立しなくなるうえ、
--   後で作品を見る人がお題を推測できてしまう。
--
--   守り方は三重。
--     ① テーブル権限を anon にも authenticated にも一切与えない
--     ② RLS を有効にし、ポリシーを1つも作らない
--     ③ 中身を返せるのは Step 4 以降のサーバー関数だけで、
--        それも「めくった1枚の名前」しか返さない
--
--   ①だけでも防げるが、将来誰かが「読めないので」とポリシーを1本足した
--   瞬間に開いてしまう。②があれば、ポリシーを足しても権限が無いので読めない。
--
--
-- 【権限のまとめ】
--
--   ロールの整理（混同しやすいので明記する）:
--     anon          … サインインしていない訪問者（JWT を持たない）
--     authenticated … サインイン済みの全員。
--                     **ゲスト（匿名サインイン）もこちら**
--
--   表                 anon        authenticated
--   -----------------  ----------  --------------------------------
--   draft_sessions     権限なし    SELECT（12列のみ・本人の行だけ）
--   draft_candidates   権限なし    権限なし
--
--   INSERT / UPDATE / DELETE はどちらのロールにも与えない（すべて RPC 経由）。
--
--   draft_sessions で読める12列:
--     id, mode_key, candidate_count, max_rerolls, reroll_count,
--     quiz_question_count, time_limit_seconds, current_generation,
--     current_slot_order, status, created_at, updated_at
--
--   読めない3列: user_id, completed_at, abandoned_at
--     user_id は RLS の条件に使うが、列権限は与えない。
--     列権限を与えなくてもポリシーは正しく働く（3B-1 で実地検証済み・D29）。
--
--
-- 【確認時に期待される結果（2種類の拒否を区別する・D31）】
--
--   操作                                        結果
--   ------------------------------------------  --------------------------
--   anon で draft_sessions を読む               permission denied（エラー）
--   authenticated で他人の draft_sessions を読む  0件（エラーにならない）
--   誰でも draft_candidates を読む               permission denied（エラー）
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. draft_sessions ／ ドラフトの進行状態
-- ----------------------------------------------------------------------------
--
-- 利用者が1回ドラフトを始めるごとに1行増える。
-- 「いまどのモードで、何枠目を引いていて、引き直しが残っているか」を持つ。
--
-- タグの中身は一切持たないため、この表は本人が直接読んでも安全。

create table public.draft_sessions (
  id uuid primary key default gen_random_uuid(),

  -- 誰のドラフトか。ゲスト（匿名サインイン）も含む。
  -- 【非公開列】RLS の条件に使うが、列権限は与えない。
  -- ゲストが30日で削除されると、このセッションも一緒に消える（cascade）。
  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  mode_key text not null
    references public.draft_modes (mode_key) on delete restrict on update restrict,

  -- --- ここから3列は draft_modes からの「開始時点の写し」 ------------------
  --
  -- なぜ写しを持つのか:
  --   マスタの設定を後から変更しても、進行中のドラフトのルールが
  --   途中で変わらないようにするため。
  --   「5枚引くはずが、途中で3枚になった」という事故を防ぐ。

  candidate_count int not null
    constraint draft_sessions_candidate_count_range check (candidate_count between 2 and 10),

  max_rerolls int not null
    constraint draft_sessions_max_rerolls_range check (max_rerolls between 0 and 5),

  quiz_question_count int not null
    constraint draft_sessions_quiz_count_range check (quiz_question_count between 1 and 10),

  -- --- ここから進行状態 -----------------------------------------------------

  reroll_count int not null default 0
    constraint draft_sessions_reroll_count_positive check (reroll_count >= 0),

  -- 制作時間。null は「無制限」を表す（spec 3-4 / D18）。
  -- 60秒〜600000秒（1分〜10000分）
  time_limit_seconds int
    constraint draft_sessions_time_limit_range check (
      time_limit_seconds is null or time_limit_seconds between 60 and 600000
    ),

  -- 何回目の抽選か。引き直すと +1 される。
  -- 古い世代の候補は残すが無効として扱う（常に最終世代だけを見る）。
  current_generation int not null default 1
    constraint draft_sessions_generation_positive check (current_generation >= 1),

  -- いま何枠目を引いているか（1 始まり）。引き直すと 1 に戻る。
  current_slot_order int not null default 1
    constraint draft_sessions_slot_order_positive check (current_slot_order >= 1),

  status text not null default 'in_progress',

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- 【非公開列】掃除の基準に使う。利用者には見せない。
  completed_at timestamptz,
  abandoned_at timestamptz,

  -- --- ここから表全体にかかる整合条件 ---------------------------------------

  -- ① status は3つの値のいずれか
  constraint draft_sessions_status_valid check (
    status in ('in_progress', 'completed', 'abandoned')
  ),

  -- ② 引き直し回数が上限を超えない
  constraint draft_sessions_reroll_within_limit check (
    reroll_count <= max_rerolls
  ),

  -- ③ 世代と引き直し回数の整合。
  --    引き直すたびに世代が1つ進むので、必ずこの関係になる。
  --    片方だけ更新するバグを DB が止める。
  constraint draft_sessions_generation_matches_reroll check (
    current_generation = reroll_count + 1
  ),

  -- ④ status と日時列の整合。
  --    「完了したのに日時が無い」「完了と放棄の両方の日時が入っている」を防ぐ。
  constraint draft_sessions_status_timestamps check (
    (status = 'in_progress' and completed_at is null     and abandoned_at is null)
    or
    (status = 'completed'   and completed_at is not null and abandoned_at is null)
    or
    (status = 'abandoned'   and abandoned_at is not null and completed_at is null)
  ),

  -- ⑤ 日時の前後関係。作成より前の更新・完了・放棄はあり得ない。
  constraint draft_sessions_updated_after_created check (
    updated_at >= created_at
  ),
  constraint draft_sessions_completed_after_created check (
    completed_at is null or completed_at >= created_at
  ),
  constraint draft_sessions_abandoned_after_created check (
    abandoned_at is null or abandoned_at >= created_at
  )
);

comment on table public.draft_sessions is
  'ドラフトの進行状態。タグの中身は持たないため本人が直接読んでも安全。';
comment on column public.draft_sessions.candidate_count is
  '1枠あたりの伏せカード枚数。開始時点の draft_modes からの写し。';
comment on column public.draft_sessions.current_slot_order is
  'いま何枠目を引いているか（1始まり）。引き直すと1に戻る。';
comment on column public.draft_sessions.updated_at is
  'すべての操作で自動更新される（トリガー）。in_progress の掃除基準。';


-- ----------------------------------------------------------------------------
-- 2. updated_at の自動更新トリガー
-- ----------------------------------------------------------------------------
--
-- 「in_progress は最終操作から30日で削除」という掃除の規則は、
-- updated_at が正確であることに依存する。RPC の中に書き忘れると、
-- エラーにならないまま放置セッションが永久に残る。
-- 書き忘れようのない DB 側の仕組みに寄せる。
--
-- security definer は使わない。この関数は NEW の1列を書き換えるだけで、
-- 他のテーブルを一切触らないため、強い権限が要らない。
--
-- 関数名を汎用の set_updated_at() ではなく表専用にしているのは、
-- 各工程の取り消し SQL が独立して動くようにするため。
-- 汎用にすると、この工程の rollback で消したときに
-- 後の工程で作る表（works など）のトリガーが壊れる。
--
-- set search_path = '' は Step 2 と同じ作法。この関数は他のオブジェクトを
-- 参照しないので実害はないが、揃えておく。
--
-- 【now() ではなく clock_timestamp() を使う理由】
--   now() は「トランザクションが始まった時刻」を返すため、同じ
--   トランザクションの中では何度呼んでも同じ値になる。
--   RPC が1つのトランザクションで INSERT と UPDATE の両方を行うと、
--   created_at と updated_at がまったく同じ時刻になってしまい、
--   「最後に操作した時刻」として役に立たない。
--   clock_timestamp() は呼んだ瞬間の実時刻を返すので、この問題が起きない。
--
--   created_at 側は now()（トランザクション開始時刻）のままでよい。
--   clock_timestamp() は必ずそれ以降になるため、
--   updated_at >= created_at の CHECK と矛盾しない。

create or replace function public.draft_sessions_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

comment on function public.draft_sessions_set_updated_at() is
  'draft_sessions の UPDATE のたびに updated_at を現在時刻にする（Step 3B-2a）。';

-- トリガー型を返す関数は直接呼び出せない仕様だが、
-- Step 2 と作法を揃えて呼び出し口を塞いでおく。
-- 更新は所有者権限で動く RPC から行われるため、この revoke の影響を受けない。
revoke all on function public.draft_sessions_set_updated_at()
  from public, anon, authenticated;

create trigger draft_sessions_set_updated_at_trigger
  before update on public.draft_sessions
  for each row
  execute function public.draft_sessions_set_updated_at();


-- ----------------------------------------------------------------------------
-- 3. draft_sessions のインデックス
-- ----------------------------------------------------------------------------

-- 3-a. 進行中のドラフトは1人1件まで。
--
-- where を付けた部分インデックスなので、完了・放棄した過去のセッションは
-- いくつあっても構わない。制限がかかるのは in_progress の行だけ。
--
-- 「新しく始めたら前のを放棄する」処理は Step 4 の start_draft RPC の中で
-- トランザクションとして行う。この制約はそれが失敗したときの最終防御であり、
-- 通常は発火しない。
create unique index draft_sessions_one_in_progress_idx
  on public.draft_sessions (user_id)
  where status = 'in_progress';

-- 3-b. 本人のセッションを引くための通常のインデックス。
--
-- 3-a は in_progress の行しか含まないため、
-- 「自分の過去のドラフト一覧」のような検索には使えない。別に必要。
create index draft_sessions_user_id_idx
  on public.draft_sessions (user_id);

-- 3-c. 掃除（Step 16）で「30日動いていない進行中セッション」を抽出する用
create index draft_sessions_stale_in_progress_idx
  on public.draft_sessions (updated_at)
  where status = 'in_progress';

-- 3-d. 掃除で「放棄から30日たったセッション」を抽出する用
create index draft_sessions_stale_abandoned_idx
  on public.draft_sessions (abandoned_at)
  where status = 'abandoned';


-- ----------------------------------------------------------------------------
-- 4. draft_candidates ／ 伏せカードの中身【機密】
-- ----------------------------------------------------------------------------
--
-- 1回のドラフトで「枠数 × candidate_count」行できる。
-- 標準モードなら 5枠 × 5枚 = 25行。
--
-- tag_id がこの表の機密の本体。これが漏れると、めくる前に中身が分かる。

create table public.draft_candidates (
  id bigint generated always as identity primary key,

  session_id uuid not null
    references public.draft_sessions (id) on delete cascade on update restrict,

  -- 何回目の抽選か。引き直すと新しい世代の行が増え、古い世代は残るが無効。
  generation int not null
    constraint draft_candidates_generation_positive check (generation >= 1),

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 開始時点の枠の提示順の写し。
  -- draft_mode_slots の並び順は将来変更され得る。写しを持たないと、
  -- 後から未選択カードを開示したときに当時と違う順番で表示されてしまう。
  slot_order int not null
    constraint draft_candidates_slot_order_positive check (slot_order >= 1),

  -- その枠の中での位置。0 から candidate_count - 1 まで。
  -- 上限が candidate_count 未満であることは別表を見ないと判定できないため、
  -- ここでは形式的な範囲（0〜9）だけを見る。実際の検査は Step 4 の RPC が行う。
  candidate_index int not null
    constraint draft_candidates_index_range check (candidate_index between 0 and 9),

  -- 【機密】めくるまで誰にも渡さない。
  -- 一度でも使われたタグは削除できない（restrict）。
  -- やめたいタグは行を消さず tags.is_active = false にする。
  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- お題に採用されたか
  is_chosen boolean not null default false,

  -- 中身が本人に見えた日時。
  -- is_chosen とは別の概念であることに注意:
  --   めくって選んだ           → is_chosen = true,  revealed_at = めくった時刻
  --   選ばなかった（開示前）   → is_chosen = false, revealed_at = null
  --   選ばなかった（後日開示） → is_chosen = false, revealed_at = 開示した時刻
  revealed_at timestamptz,

  created_at timestamptz not null default now(),

  -- --- 整合条件 -------------------------------------------------------------

  -- 選んだのに中身を見ていない、という状態はあり得ない
  constraint draft_candidates_chosen_requires_revealed check (
    is_chosen = false or revealed_at is not null
  ),

  constraint draft_candidates_revealed_after_created check (
    revealed_at is null or revealed_at >= created_at
  ),

  -- --- 重複の禁止 -----------------------------------------------------------

  -- 同じ世代・同じ枠に同じ位置が2つ存在しない
  constraint draft_candidates_slot_index_unique
    unique (session_id, generation, card_slot_key, candidate_index),

  -- 同じ世代で同じタグが2回出ない。
  -- motif_a と motif_b の両方に「傘」が出るのを DB が防ぐ（リスク R7）。
  -- 異なる分類のタグは元々重複しないので、実際に効くのは
  -- 同じ分類を使う枠の間だけ。そこがまさにバグの出やすい箇所。
  constraint draft_candidates_tag_unique_per_generation
    unique (session_id, generation, tag_id)
);

comment on table public.draft_candidates is
  '伏せカードの中身【機密】。権限もポリシーも与えず、RPC 経由でのみ読む。';
comment on column public.draft_candidates.tag_id is
  '【機密】めくるまでクライアントに渡さない。正解に直結する。';
comment on column public.draft_candidates.slot_order is
  '開始時点の枠の提示順の写し。後日の開示で当時の順番を再現するため。';
comment on column public.draft_candidates.revealed_at is
  '中身が本人に見えた日時。is_chosen とは別（選ばなくても開示され得る）。';


-- ----------------------------------------------------------------------------
-- 5. draft_candidates のインデックス
-- ----------------------------------------------------------------------------

-- 1つの枠で選べるのは1枚だけ。
-- where is_chosen を付けた部分インデックスなので、選ばれていない候補は
-- 同じ枠にいくつあってもよい。
-- めくる処理にバグがあっても「同じ枠で2枚選ばれた」状態は作れない。
create unique index draft_candidates_one_chosen_per_slot_idx
  on public.draft_candidates (session_id, generation, card_slot_key)
  where is_chosen;

-- 「このセッションの最終世代の候補」を引くのが最も多い操作。
-- 上の unique 制約（session_id, generation, ...）の先頭2列で足りるため、
-- 追加のインデックスは作らない。


-- ----------------------------------------------------------------------------
-- 6. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- draft_sessions   … 本人の行だけ SELECT できる。書き込みのポリシーは作らない
-- draft_candidates … ポリシーを1つも作らない（完全遮断）
--
-- draft_candidates は権限も与えていないため、実際には RLS が働く前に
-- 権限エラーで止まる。それでも RLS を有効にしておくのは、
-- 将来うっかり grant を足したときの保険。

alter table public.draft_sessions   enable row level security;
alter table public.draft_candidates enable row level security;

-- 本人のセッションだけ読める。
-- to authenticated としているのは、サインインしていない訪問者（anon）は
-- そもそもドラフトを持たないため。ゲストは authenticated 側に含まれる。
create policy draft_sessions_select_own
  on public.draft_sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

-- draft_sessions の INSERT / UPDATE / DELETE ポリシーは作らない。
-- 作成も更新も Step 4 以降の RPC が行う。

-- draft_candidates のポリシーは1つも作らない。


-- ----------------------------------------------------------------------------
-- 7. 列単位の権限
-- ----------------------------------------------------------------------------
--
-- revoke all を先に流して、Supabase の既定設定で付いている可能性のある
-- 権限を確実に落とす。service_role と所有者には触らない。

revoke all on public.draft_sessions   from anon, authenticated;
revoke all on public.draft_candidates from anon, authenticated;

-- draft_sessions: サインイン済みの利用者に、安全な12列だけ。
--   user_id      … RLS の条件に使うが値は見せない
--   completed_at … 掃除の基準。利用者には不要
--   abandoned_at … 同上
grant select (
  id,
  mode_key,
  candidate_count,
  max_rerolls,
  reroll_count,
  quiz_question_count,
  time_limit_seconds,
  current_generation,
  current_slot_order,
  status,
  created_at,
  updated_at
) on public.draft_sessions to authenticated;

-- anon には何も与えない（grant 文を書かない）。

-- draft_candidates には誰にも何も与えない（grant 文を書かない）。
-- 中身を返せるのは Step 4 以降の security definer 関数だけ。


commit;


-- ============================================================================
-- Step 4 の RPC が保証する不変条件（この工程では実装しない）
-- ============================================================================
--
-- 下記は複数の表をまたぐ条件のため、CHECK 制約では表現できない。
-- start_draft / reroll_draft / reveal_card / complete_draft を実装するときに、
-- 関数の中で必ず検査する。テストでも確認する。
--
--  1. candidate_index は 0 以上 candidate_count 未満であること
--       DB 側の CHECK は形式的な範囲（0〜9）しか見ていない。
--       そのセッションの candidate_count に対する上限は RPC が守る
--
--  2. 各枠に candidate_count 件の候補を作ること
--       多くても少なくてもいけない。3件しか作らずに5件目を
--       めくろうとする、という状態を生まない
--
--  3. 選択できるのは current_generation の候補だけであること
--       引き直しで無効になった古い世代の候補をめくれてはいけない（リスク R8）
--
--  4. tag の pool_key と card_slot の pool_key が一致すること
--       「モチーフAの候補に色のタグが入っている」を防ぐ。
--       外部キーは tags と card_slots をそれぞれ見るだけで、
--       両者の分類が同じかまでは見ないため
--
--  5. 同じ枠の全候補で slot_order が一致すること
--       motif_a の5枚がすべて slot_order = 1 であること
--
--  6. 異なる枠で slot_order が重複しないこと
--       motif_a と main_color が両方 slot_order = 1 にならないこと
--
--  7. 状態遷移は in_progress → completed または in_progress → abandoned だけ
--
--  8. completed / abandoned から in_progress へ戻せないこと
--       確定したお題を後から引き直せてはいけない
--
-- 1〜6 は draft_candidates の作り方、7〜8 は draft_sessions.status の
-- 更新の仕方に関する条件。


-- ============================================================================
-- 確認用クエリ（実行は任意。SQL Editor に貼って結果を見る）
-- ============================================================================
--
-- ① 2表ができていて、どちらも 0 行であること
-- select 'draft_sessions' as t, count(*) from public.draft_sessions
-- union all select 'draft_candidates', count(*) from public.draft_candidates;
--
--
-- ② ポリシーが1件（draft_sessions の SELECT）だけであること。
--    draft_candidates の行が出てきたら設定ミス。
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public'
--    and tablename in ('draft_sessions','draft_candidates')
--  order by tablename;
--
--
-- ③ 両表とも RLS が有効であること（rowsecurity = true が2件）
-- select relname, relrowsecurity from pg_class
--  where relname in ('draft_sessions','draft_candidates');
--
--
-- ④ 【最重要】draft_candidates が誰からも読めないこと。
--    どちらも permission denied for table draft_candidates が正しい。
--    0 件が返ってきたら設定ミス（権限が残っている）。
-- begin;
--   set local role anon;
--   select * from public.draft_candidates;
-- rollback;
--
-- begin;
--   set local role authenticated;
--   select * from public.draft_candidates;
-- rollback;
--
--
-- ⑤ anon は draft_sessions も読めないこと。
--    permission denied for table draft_sessions が正しい。
-- begin;
--   set local role anon;
--   select id, status from public.draft_sessions;
-- rollback;
--
--
-- ⑥ authenticated は列を指定すれば読めること（0 件が返る）。
--    行が無いので 0 件だが、エラーにならないことが確認できる。
--    ここでエラーが出たら列権限の設定ミス。
-- begin;
--   set local role authenticated;
--   select id, mode_key, status from public.draft_sessions;   -- → 0 件
-- rollback;
--
--
-- ⑦ authenticated でも非公開列は読めないこと。
--    3つとも permission denied for table draft_sessions が正しい。
-- begin;
--   set local role authenticated;
--   select user_id from public.draft_sessions;
-- rollback;
--
-- begin;
--   set local role authenticated;
--   select completed_at from public.draft_sessions;
-- rollback;
--
-- begin;
--   set local role authenticated;
--   select * from public.draft_sessions;   -- * は非公開列を含むので拒否される
-- rollback;
--
--
-- ⑧ 一般利用者が書き込めないこと。
--    3つとも permission denied が正しい。
--
--    【注意】UPDATE と DELETE には必ず where を付けること。
--    万一 grant の設定を誤っていた場合、where の無い文は表全体を
--    書き換えてしまう。テスト用の ID だけを対象にする。
-- begin;
--   set local role authenticated;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   values ('11111111-1111-1111-1111-111111111111',
--           gen_random_uuid(), 'easy', 3, 1, 3);
-- rollback;
--
-- begin;
--   set local role authenticated;
--   update public.draft_sessions set status = 'completed'
--    where id = '11111111-1111-1111-1111-111111111111';
-- rollback;
--
-- begin;
--   set local role authenticated;
--   delete from public.draft_sessions
--    where id = '11111111-1111-1111-1111-111111111111';
-- rollback;
--
--
-- ⑨ 使用中のモードが削除できないこと（セッションを1件作って確かめ、戻す）。
--    delete の行で「violates foreign key constraint」が出るのが正しい。
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '11111111-1111-1111-1111-111111111111', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   delete from public.draft_modes where mode_key = 'easy';
--   -- → ERROR: update or delete on table "draft_modes" violates
--   --           foreign key constraint ... on table "draft_sessions"
-- rollback;
--
--
-- ⑩ updated_at の自動更新が働くこと。
--
--    pg_sleep で少し待つのは、時刻の差を確実に出すため。
--    トリガーは clock_timestamp()（呼んだ瞬間の実時刻）を使うので、
--    待たなくても差は出るはずだが、判定を確実にする。
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '11111111-1111-1111-1111-111111111111', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1
--   returning id, created_at, updated_at;
--
--   select pg_sleep(0.01);
--
--   update public.draft_sessions set current_slot_order = 2
--    where id = '11111111-1111-1111-1111-111111111111'
--    returning created_at, updated_at, updated_at > created_at as trigger_worked;
--   -- → trigger_worked が true なら成功
-- rollback;
--
--
-- ⑪ 状態と日時の整合が守られること。
--    「完了にしたのに completed_at を入れない」更新が拒否される。
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '11111111-1111-1111-1111-111111111111', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   update public.draft_sessions set status = 'completed'
--    where id = '11111111-1111-1111-1111-111111111111';
--   -- → ERROR: violates check constraint "draft_sessions_status_timestamps"
-- rollback;
--
--
-- ⑫ 進行中のドラフトが1人1件に制限されること。
--    2件目の insert で unique 違反が出るのが正しい。
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '11111111-1111-1111-1111-111111111111', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '22222222-2222-2222-2222-222222222222', id, 'standard', 5, 1, 3
--     from public.profiles order by created_at limit 1;
--   -- → ERROR: duplicate key value violates unique constraint
--   --           "draft_sessions_one_in_progress_idx"
-- rollback;
--
--
-- ⑬ 列権限の一覧（anon の行が1件も出ないこと）
-- select
--   grantee,
--   table_name,
--   privilege_type,
--   string_agg(column_name, ', ' order by column_name) as columns
-- from information_schema.column_privileges
-- where table_schema = 'public'
--   and table_name in ('draft_sessions', 'draft_candidates')
--   and grantee in ('anon', 'authenticated')
-- group by grantee, table_name, privilege_type
-- order by grantee, table_name, privilege_type;
--
--    期待される結果は1行だけ:
--      authenticated | draft_sessions | SELECT | candidate_count, created_at,
--                      current_generation, current_slot_order, id, max_rerolls,
--                      mode_key, quiz_question_count, reroll_count, status,
--                      time_limit_seconds, updated_at
--    anon の行、draft_candidates の行、INSERT/UPDATE/DELETE の行が
--    1件でも出たら設定ミス。
--
--
-- ⑭ 【重要】本人だけが自分のセッションを読めること。
--
--    ⑥は「エラーにならない」ことしか確認していない。行が 0 件なのは
--    そもそも表が空だからで、RLS が正しく効いているかは分からない。
--    ここでは実際に行を作り、本人と別人で結果が変わることを確かめる。
--
--    【なぜ set local role authenticated だけでは足りないか】
--      ロールを切り替えても、ポリシーが使う auth.uid() は null のまま。
--      auth.uid() は JWT（身分証）の sub という項目を読む関数で、
--      ロール名とは別のもの。SQL Editor には JWT が無いので、
--      request.jwt.claim.sub を手で設定して本人になりきる必要がある。
--
--    set_config(..., true) の true は「このトランザクション内だけ有効」の意味。
--    rollback すれば設定も行も残らない。
--
-- begin;
--   -- 既存の profiles の行を1つ借りて、その人のセッションを作る
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '11111111-1111-1111-1111-111111111111', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   -- (a) 本人になりきる ------------------------------------------------
--   select set_config(
--     'request.jwt.claim.sub',
--     (select user_id::text from public.draft_sessions
--       where id = '11111111-1111-1111-1111-111111111111'),
--     true
--   );
--   set local role authenticated;
--
--   select auth.uid() as acting_as;          -- → 借りた profiles の id が出る
--   select count(id) as own_rows from public.draft_sessions;
--   -- → 1 が正しい（本人なので自分の行が見える）
--
--   reset role;
--
--   -- (b) 別人になりきる ------------------------------------------------
--   select set_config(
--     'request.jwt.claim.sub',
--     '99999999-9999-9999-9999-999999999999',
--     true
--   );
--   set local role authenticated;
--
--   select count(id) as other_rows from public.draft_sessions;
--   -- → 0 が正しい（他人の行は見えない。エラーにはならない）
-- rollback;
--
--    (a) が 1、(b) が 0 なら RLS が正しく働いている。
--    (b) が 1 になったら、ポリシーの条件が効いていない。
--    (a) が 0 になったら、auth.uid() の設定が効いていない
--    （その場合は request.jwt.claim.sub ではなく request.jwt.claims に
--      '{"sub":"..."}' という JSON を設定する方式を試す）。
