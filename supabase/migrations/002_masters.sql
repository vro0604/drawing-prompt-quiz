-- ============================================================================
-- 002_masters.sql  ／ Step 3B-1: マスタ5表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. マスタ5表を作る（tag_pools / card_slots / draft_modes /
--      draft_mode_slots / tags）
--   2. 5表すべてに RLS を有効にして SELECT ポリシーを張る
--   3. 列単位の権限を設定する（tags.weight を読めなくする等）
--   4. 初期データ28行を投入する（tags 本体は 0 行のまま）
--
-- 【このファイルがやらないこと】
--   ・既存のデータを消さない。profiles や Step 2 の仕組みには一切触れない
--   ・行の削除を一切行わない（upsert は追加と更新のみ）
--   ・tags にタグ本体を1件も入れない（3D で目視確認のうえ投入する）
--   ・advanced / full モードを作らない
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。中途半端な状態にはならない。
--   初回実行が途中で失敗した場合は、原因を直してからもう一度
--   まるごと実行できる。
--
-- 【重要：正常終了した番号付きマイグレーションは再実行しない】
--
--   create table に if not exists を付けていない。そのため、すでに表がある
--   状態でこのファイルを実行すると「already exists」で止まる。これは意図した動作。
--
--   if not exists を付けると、同名の表が存在するときに作成を飛ばすだけで、
--   その表の列・型・制約が今回の定義と同じかどうかは確認しない。
--   古い不完全な表を黙って使い続ける危険があるため、あえて付けない。
--
--   すでに実行済みの状態からやり直したい場合は、先に
--   002_masters_rollback.sql を実行して表を消してから、このファイルを実行する。
--
-- 【取り消し】
--   002_masters_rollback.sql を実行する。
--
--
-- 【権限のまとめ（ここだけ読めば全体が分かる）】
--
--   5表とも一般利用者は SELECT のみ。INSERT / UPDATE / DELETE は誰にもできない。
--   マスタの変更は SQL Editor（管理者権限）から行う。
--
--   表                 一般利用者が読める列
--   -----------------  --------------------------------------------------
--   tag_pools          pool_key, label, sort_order（全列）
--   card_slots         card_slot_key, label, is_quiz_eligible
--                        → pool_key と quiz_priority は読めない
--   draft_modes        mode_key, label, candidate_count, max_rerolls,
--                      quiz_question_count, sort_order
--                        → is_active は読めない
--   draft_mode_slots   mode_key, card_slot_key, sort_order（全列）
--   tags               id, pool_key, label
--                        → weight, is_active, note, created_at は読めない
--
--   行の絞り込み（RLS）:
--     draft_modes … is_active = true の行だけ
--     tags        … is_active = true の行だけ
--     他の3表     … 全行公開
--
--
-- 【重要な注意：select * が使えない】
--
--   列単位で権限を絞ったため、この5表に対して select * を実行すると
--   「権限がありません」というエラーになる。アプリ側では必ず列名を明示する。
--
--     NG:  .from("tags").select("*")
--     OK:  .from("tags").select("id, pool_key, label")
--
--   Step 2 の profiles は表全体に SELECT を与えているため * が使える。
--   この差は後で混乱しやすいので、アプリ側にも同じ注意書きを残すこと。
--
-- ============================================================================


begin;


-- ----------------------------------------------------------------------------
-- 1. tag_pools ／ タグの分類（8行）
-- ----------------------------------------------------------------------------
--
-- 「モチーフ」「色」といったタグの置き場所。1つのタグは必ず1つの分類に属する。
-- 分類を分けておくことで、「傘」を motif_a 用と motif_b 用に二重登録せずに済む。

create table public.tag_pools (
  -- 英小文字・数字・アンダースコアのみ。アプリのコードにそのまま書かれる値
  pool_key text primary key
    constraint tag_pools_key_format check (pool_key ~ '^[a-z][a-z0-9_]{1,19}$'),

  label text not null
    constraint tag_pools_label_length check (char_length(label) between 1 and 30),

  sort_order int not null
    constraint tag_pools_sort_order_positive check (sort_order >= 1),

  -- 並び順が重複しないようにする。
  -- deferrable initially deferred は「重複していないかの判定を、
  -- 1行ごとではなく commit の直前にまとめて行う」指定。
  -- 並び順を入れ替える更新をしたとき、途中経過で一時的に重複しても通せる。
  constraint tag_pools_sort_order_unique unique (sort_order)
    deferrable initially deferred
);

comment on table public.tag_pools is
  'タグの分類（マスタ）。1つのタグは必ず1つの分類に属する。';


-- ----------------------------------------------------------------------------
-- 2. card_slots ／ お題カードの枠（10行）
-- ----------------------------------------------------------------------------
--
-- 「モチーフA」「メインカラー」といったお題の枠。
-- 枠自体はタグを持たず、「どの分類から引くか」だけを指定する。
--
-- 10枠すべてを登録するが、MVP で実際に使うのは draft_mode_slots が
-- 参照する5枠のみ。未使用の枠は画面に出ない（画面は draft_mode_slots を見るため）。

create table public.card_slots (
  card_slot_key text primary key
    constraint card_slots_key_format check (card_slot_key ~ '^[a-z][a-z0-9_]{1,29}$'),

  label text not null
    constraint card_slots_label_length check (char_length(label) between 1 and 30),

  -- どの分類から引くか。分類が消えると枠の意味が失われるため RESTRICT。
  -- キー名の変更も禁止（アプリのコードに書かれている値なので、
  -- 黙って変わると対応が壊れる。変えるなら意図的な移行作業として行う）。
  pool_key text not null
    references public.tag_pools (pool_key) on delete restrict on update restrict,

  -- 小さいほど優先して出題される。クイズ対象外の枠は null。
  quiz_priority int
    constraint card_slots_quiz_priority_positive check (quiz_priority >= 1),

  is_quiz_eligible boolean not null default true,

  constraint card_slots_quiz_priority_unique unique (quiz_priority)
    deferrable initially deferred,

  -- 「クイズに出るのに優先順位が無い」「出ないのに優先順位がある」を防ぐ
  constraint card_slots_quiz_consistency check (
    (is_quiz_eligible = true  and quiz_priority is not null)
    or
    (is_quiz_eligible = false and quiz_priority is null)
  )
);

comment on table public.card_slots is
  'お題カードの枠（マスタ）。どの分類から引くかだけを持つ。10枠すべて登録し、'
  '実際に使う枠は draft_mode_slots で制御する。';


-- ----------------------------------------------------------------------------
-- 3. draft_modes ／ モード（2行）
-- ----------------------------------------------------------------------------
--
-- 遊び方の設定一式。「枠の構成」は別表（draft_mode_slots）が持ち、
-- ここは1枠あたりの候補枚数などの数値だけを持つ。
--
-- candidate_count と枠数は別の設定値であることに注意。
--   easy     = 3枠 × 候補3枚 =  9枚の伏せカード
--   standard = 5枠 × 候補5枚 = 25枚の伏せカード

create table public.draft_modes (
  mode_key text primary key
    constraint draft_modes_key_format check (mode_key ~ '^[a-z][a-z0-9_]{1,19}$'),

  label text not null
    constraint draft_modes_label_length check (char_length(label) between 1 and 30),

  -- 1枠あたりの伏せカード枚数。
  -- 下限を2にしているのは、1枚だと「選ばせているが選択肢が無い」状態になるため。
  candidate_count int not null
    constraint draft_modes_candidate_count_range check (candidate_count between 2 and 10),

  max_rerolls int not null default 1
    constraint draft_modes_max_rerolls_range check (max_rerolls between 0 and 5),

  quiz_question_count int not null default 3
    constraint draft_modes_quiz_count_range check (quiz_question_count between 1 and 10),

  sort_order int not null
    constraint draft_modes_sort_order_positive check (sort_order >= 1),

  -- false にすると一般利用者からは存在しないものとして扱われる（下の RLS 参照）。
  -- MVP では false の行を作らない。
  is_active boolean not null default true,

  constraint draft_modes_sort_order_unique unique (sort_order)
    deferrable initially deferred
);

comment on table public.draft_modes is
  'ドラフトのモード（マスタ）。MVP は easy / standard の2行のみ。';
comment on column public.draft_modes.candidate_count is
  '1枠あたりの伏せカード枚数。枠の数とは別の設定値。';


-- ----------------------------------------------------------------------------
-- 4. draft_mode_slots ／ モードが使う枠（8行）
-- ----------------------------------------------------------------------------
--
-- どのモードがどの枠を、どの順番で使うか。
-- ドラフト画面はこの表を読むため、ここに載っていない枠は画面に出ない。

create table public.draft_mode_slots (
  -- モードを消したら、その構成も一緒に消える（構成はモードの一部なので）
  mode_key text not null
    references public.draft_modes (mode_key) on delete cascade on update restrict,

  -- 使われている枠は消せない
  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  sort_order int not null
    constraint draft_mode_slots_sort_order_positive check (sort_order >= 1),

  -- 同じモードに同じ枠を2回登録できない
  primary key (mode_key, card_slot_key),

  -- 同じモードの中で提示順が重複しない
  constraint draft_mode_slots_order_unique unique (mode_key, sort_order)
    deferrable initially deferred
);

comment on table public.draft_mode_slots is
  'モードが使う枠と提示順（マスタ）。ドラフト画面はこの表を見る。';


-- ----------------------------------------------------------------------------
-- 5. tags ／ タグ本体（この工程では 0 行）
-- ----------------------------------------------------------------------------
--
-- 「傘」「深い青」といった言葉そのもの。
-- この工程では表だけ作り、中身は 3D で docs/tags-master.md の案を
-- 目視確認していただいてから投入する。

create table public.tags (
  -- generated always as identity: 番号を自動で振る。
  -- always なので、値を手で指定して割り込むことはできない。
  id bigint generated always as identity primary key,

  pool_key text not null
    references public.tag_pools (pool_key) on delete restrict on update restrict,

  label text not null
    constraint tags_label_length check (char_length(label) between 1 and 40),

  -- 出やすさ。既定100で、小さいほどレア。
  -- 【非公開】この値が見えると「重みが小さいから正解ではなさそう」という
  -- 推測ができてしまうため、一般利用者には読ませない（下の権限設定を参照）。
  weight int not null default 100
    constraint tags_weight_range check (weight between 1 and 1000),

  -- false にすると一般利用者からは存在しないものとして扱われる。
  -- 誤って登録したタグを、行を消さずに使用停止にするための列。
  is_active boolean not null default true,

  -- 運用メモ。「固有名詞に近いので要検討」などを書く
  note text
    constraint tags_note_length check (note is null or char_length(note) <= 200),

  created_at timestamptz not null default now(),

  -- 同じ分類に同じ言葉を二重登録できない
  constraint tags_pool_label_unique unique (pool_key, label)
);

comment on table public.tags is
  'タグ本体（マスタ）。分類に属する。3B-1 の時点では 0 行。';
comment on column public.tags.weight is
  '出やすさ。既定100。運営用・非公開（一般利用者には列権限を与えない）。';

-- 抽選のたびに「この分類の有効なタグ」を引くため、そこに索引を張る。
-- where is_active を付けた部分索引にすることで、停止中のタグを含めず軽くする。
create index tags_pool_key_active_idx
  on public.tags (pool_key) where is_active;


-- ----------------------------------------------------------------------------
-- 6. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- 5表とも SELECT ポリシーだけを作る。
-- INSERT / UPDATE / DELETE のポリシーを作らない ＝ 誰もできない。
--
-- card_slots と draft_mode_slots を using (true) にしたのは、
--   ・将来用の8分類は tag_pools 側ですでに公開されるため、
--     枠だけ隠しても構想の秘匿にはならない
--   ・通常画面は draft_mode_slots から使用枠を取得するので、
--     全件公開しても未使用の枠は画面に出ない
--   ・判定用の関数を増やすほどの必要性がない
-- という判断による。
--
-- draft_modes と tags の is_active による絞り込みは、同じ表の中の列を
-- 見るだけなので追加の関数は要らない。
-- なお、ポリシーの中で is_active を参照することと、利用者がその列を
-- 読めることは別。利用者に列権限を与えなくてもポリシーは正しく働く
-- （実行後の確認クエリ ③ でこれを検証する）。

alter table public.tag_pools        enable row level security;
alter table public.card_slots       enable row level security;
alter table public.draft_modes      enable row level security;
alter table public.draft_mode_slots enable row level security;
alter table public.tags             enable row level security;

drop policy if exists tag_pools_select_all on public.tag_pools;
create policy tag_pools_select_all
  on public.tag_pools for select to anon, authenticated
  using (true);

drop policy if exists card_slots_select_all on public.card_slots;
create policy card_slots_select_all
  on public.card_slots for select to anon, authenticated
  using (true);

drop policy if exists draft_modes_select_active on public.draft_modes;
create policy draft_modes_select_active
  on public.draft_modes for select to anon, authenticated
  using (is_active = true);

drop policy if exists draft_mode_slots_select_all on public.draft_mode_slots;
create policy draft_mode_slots_select_all
  on public.draft_mode_slots for select to anon, authenticated
  using (true);

drop policy if exists tags_select_active on public.tags;
create policy tags_select_active
  on public.tags for select to anon, authenticated
  using (is_active = true);


-- ----------------------------------------------------------------------------
-- 7. 列単位の権限（どの列を読めるか）
-- ----------------------------------------------------------------------------
--
-- RLS は「どの行か」しか見ない。「どの列を読めるか」は grant で決める。
-- tags.weight を隠せるのはこちらの仕組み。
--
-- revoke all を先に流すのは、以前の実行や Supabase の既定設定で
-- 広い権限が付いている場合に、それを確実に落とすため。
-- 対象は anon（未サインイン）と authenticated（サインイン済み）だけで、
-- 管理用の service_role とテーブルの所有者には触らない。

revoke all on public.tag_pools        from anon, authenticated;
revoke all on public.card_slots       from anon, authenticated;
revoke all on public.draft_modes      from anon, authenticated;
revoke all on public.draft_mode_slots from anon, authenticated;
revoke all on public.tags             from anon, authenticated;

-- tag_pools: 全列を公開してよい
grant select (pool_key, label, sort_order)
  on public.tag_pools to anon, authenticated;

-- card_slots: 画面の描画に必要な3列のみ。
--   pool_key      … どの分類から引くかは推測材料になり得るので渡さない
--   quiz_priority … どの枠が優先して出題されるかも同様
grant select (card_slot_key, label, is_quiz_eligible)
  on public.card_slots to anon, authenticated;

-- draft_modes: モード選択画面に出す6列のみ。
--   is_active は RLS の条件で使うが、利用者には渡さない
--   （返るのは常に有効な行だけなので、渡す意味がない）
grant select (mode_key, label, candidate_count, max_rerolls,
              quiz_question_count, sort_order)
  on public.draft_modes to anon, authenticated;

-- draft_mode_slots: 全列を公開してよい
grant select (mode_key, card_slot_key, sort_order)
  on public.draft_mode_slots to anon, authenticated;

-- tags: 3列のみ。weight / is_active / note / created_at は読めない
grant select (id, pool_key, label)
  on public.tags to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 8. 初期データ（28行）
-- ----------------------------------------------------------------------------
--
-- on conflict ... do update（upsert）で書いてある。既にある行は上書き更新され、
-- 無い行は追加される。
--
-- ただし、このファイル全体は再実行できない（表の作成で止まるため）。
-- upsert にしているのは、将来この投入部分だけを取り出して実行したり、
-- マスタの値を変更して流し直したりする場面に備えたもの。
--
-- 【行の削除は一切しない】
--   このファイルに載っていない行が既にあっても、消さない。
--   意図しないデータ消失を避けるため。想定外の行が無いかは
--   末尾の確認クエリ ④ で検出する。

-- --- 8-a. tag_pools（8行）---------------------------------------------------
--
-- MVP で使うのは motif / color / species / genre の4分類。
-- 残り4分類は将来用に定義だけ置く（タグは 3D でも投入しない）。

insert into public.tag_pools (pool_key, label, sort_order) values
  ('motif',      'モチーフ',       1),
  ('color',      '色',             2),
  ('species',    '種族',           3),
  ('genre',      'ジャンル類型',   4),
  ('role',       '職業・役割',     5),
  ('era',        '時代・環境',     6),
  ('gender',     '性別・性表現',   7),
  ('constraint', '制約',           8)
on conflict (pool_key) do update
  set label      = excluded.label,
      sort_order = excluded.sort_order;


-- --- 8-b. card_slots（10行）-------------------------------------------------
--
-- MVP使用 = easy / standard のどちらかで使う枠（下の draft_mode_slots を参照）。
-- constraint 枠だけが is_quiz_eligible = false（制約はクイズに出さない）。

insert into public.card_slots
  (card_slot_key, label,           pool_key,     quiz_priority, is_quiz_eligible) values
  ('motif_a',     'モチーフA',     'motif',       1,            true),   -- MVP使用
  ('motif_b',     'モチーフB',     'motif',       2,            true),   -- MVP使用
  ('main_color',  'メインカラー',  'color',       3,            true),   -- MVP使用
  ('species',     '種族',          'species',     4,            true),   -- MVP使用
  ('genre_type',  'ジャンル類型',  'genre',       5,            true),   -- MVP使用
  ('sub_color',   '補助カラー',    'color',       6,            true),
  ('role',        '職業・役割',    'role',        7,            true),
  ('era_env',     '時代・環境',    'era',         8,            true),
  ('gender_expr', '性別・性表現',  'gender',      9,            true),
  ('constraint',  '制約',          'constraint',  null,         false)
on conflict (card_slot_key) do update
  set label            = excluded.label,
      pool_key         = excluded.pool_key,
      quiz_priority    = excluded.quiz_priority,
      is_quiz_eligible = excluded.is_quiz_eligible;


-- --- 8-c. draft_modes（2行のみ）---------------------------------------------
--
-- advanced / full は candidate_count 等が未確定のため、行を作らない。
-- 実装するときにここへ行を足すだけで有効になる。

insert into public.draft_modes
  (mode_key,   label,      candidate_count, max_rerolls, quiz_question_count, sort_order, is_active) values
  ('easy',     'お手軽',   3,               1,           3,                   1,          true),
  ('standard', '標準',     5,               1,           3,                   2,          true)
on conflict (mode_key) do update
  set label               = excluded.label,
      candidate_count     = excluded.candidate_count,
      max_rerolls         = excluded.max_rerolls,
      quiz_question_count = excluded.quiz_question_count,
      sort_order          = excluded.sort_order,
      is_active           = excluded.is_active;


-- --- 8-d. draft_mode_slots（8行）--------------------------------------------
--
-- easy     … 3枠（モチーフA / メインカラー / ジャンル類型）
-- standard … 5枠（モチーフA / モチーフB / メインカラー / 種族 / ジャンル類型）
--
-- easy が motif_b を使わないため、easy では motif 分類から3件しか引かない。
-- 必要なタグ数の下限を決めるのは standard 側（motif を 2枠 × 5候補 = 10件）。

insert into public.draft_mode_slots (mode_key, card_slot_key, sort_order) values
  ('easy',     'motif_a',    1),
  ('easy',     'main_color', 2),
  ('easy',     'genre_type', 3),
  ('standard', 'motif_a',    1),
  ('standard', 'motif_b',    2),
  ('standard', 'main_color', 3),
  ('standard', 'species',    4),
  ('standard', 'genre_type', 5)
on conflict (mode_key, card_slot_key) do update
  set sort_order = excluded.sort_order;


-- --- 8-e. tags ---------------------------------------------------------------
--
-- 意図的に 0 行のまま。タグ本体は Step 3D で投入する。
-- 先に docs/tags-master.md へ案を作り、固有名詞が混ざっていないかを
-- 目視確認していただいてから入れる（リスク R14）。


commit;


-- ============================================================================
-- 確認用クエリ（実行は任意。SQL Editor に貼って結果を見る）
-- ============================================================================
--
-- ① 行数が想定どおりか
--    tag_pools 8 / card_slots 10 / draft_modes 2 / draft_mode_slots 8 / tags 0
-- select 'tag_pools' as t, count(*) from public.tag_pools
-- union all select 'card_slots',       count(*) from public.card_slots
-- union all select 'draft_modes',      count(*) from public.draft_modes
-- union all select 'draft_mode_slots', count(*) from public.draft_mode_slots
-- union all select 'tags',             count(*) from public.tags;
--
--
-- ② ポリシーが5件（すべて SELECT）で、INSERT / UPDATE / DELETE が無いこと
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public'
--    and tablename in ('tag_pools','card_slots','draft_modes',
--                      'draft_mode_slots','tags')
--  order by tablename;
--
--
-- ③ 【重要】一般利用者になりきった動作確認。
--    次の3つがすべて成立するのが正しい。
--      ・列を指定した SELECT は成功する
--      ・tags.weight を読もうとすると権限エラーになる
--      ・draft_modes は is_active を渡していなくてもポリシーが働く
-- begin;
--   set local role anon;
--   select mode_key, label, candidate_count from public.draft_modes order by sort_order;
--   -- → easy と standard の2行が返れば、列権限を与えずにポリシーが
--   --    正しく働いていることの確認になる
-- rollback;
--
-- begin;
--   set local role anon;
--   select weight from public.tags;   -- → permission denied for table tags が正しい
-- rollback;
--
-- begin;
--   set local role anon;
--   select * from public.tags;        -- → これも permission denied が正しい
-- rollback;                           --    （* は weight を含むため）
--
--
-- ④ このファイルに載っていない想定外の行が無いか
--    3件とも 0 行なら想定どおり
-- select 'unexpected mode' as kind, mode_key as key from public.draft_modes
--  where mode_key not in ('easy','standard')
-- union all
-- select 'unexpected pool', pool_key from public.tag_pools
--  where pool_key not in ('motif','color','species','genre',
--                         'role','era','gender','constraint')
-- union all
-- select 'unexpected slot', card_slot_key from public.card_slots
--  where card_slot_key not in ('motif_a','motif_b','main_color','species',
--                              'genre_type','sub_color','role','era_env',
--                              'gender_expr','constraint');
--
--
-- ⑤ 一般利用者に与えた列権限の一覧（上の【権限のまとめ】と一致すること）。
--    anon と authenticated を別々に表示し、両者の権限が同じであることを確認する。
--    片方にだけ余分な権限が付いていないかを見るのが目的。
-- select
--   grantee,
--   table_name,
--   privilege_type,
--   string_agg(column_name, ', ' order by column_name) as columns
-- from information_schema.column_privileges
-- where table_schema = 'public'
--   and table_name in (
--     'tag_pools',
--     'card_slots',
--     'draft_modes',
--     'draft_mode_slots',
--     'tags'
--   )
--   and grantee in ('anon', 'authenticated')
-- group by grantee, table_name, privilege_type
-- order by grantee, table_name, privilege_type;
--
--    期待される結果（privilege_type はすべて SELECT。10行）:
--      anon / authenticated それぞれについて
--        card_slots        card_slot_key, is_quiz_eligible, label
--        draft_mode_slots  card_slot_key, mode_key, sort_order
--        draft_modes       candidate_count, label, max_rerolls, mode_key,
--                          quiz_question_count, sort_order
--        tag_pools         label, pool_key, sort_order
--        tags              id, label, pool_key
--    INSERT / UPDATE / DELETE の行が1件でも出たら設定ミス。
--
--
-- ⑥ モードの構成が正しいか（easy 3行 / standard 5行）
-- select m.mode_key, m.candidate_count, s.sort_order, s.card_slot_key, c.label
--   from public.draft_modes m
--   join public.draft_mode_slots s on s.mode_key = m.mode_key
--   join public.card_slots c on c.card_slot_key = s.card_slot_key
--  order by m.sort_order, s.sort_order;
--
--
-- ⑦ is_active = false の行が一般利用者から隠れることの実地確認。
--
--    テスト用のモードを一時的に作り、anon から見えないことを確かめてから
--    rollback で消す。**必ず rollback で終える**こと（commit すると
--    テスト用の行が残ってしまう）。
--
--    途中でエラーが出た場合も、rollback を実行すれば何も残らない。
--
-- begin;
--   -- 管理者権限で、無効なモードを1行だけ作る
--   insert into public.draft_modes
--     (mode_key, label, candidate_count, max_rerolls,
--      quiz_question_count, sort_order, is_active)
--   values
--     ('test_hidden', 'テスト用（非表示）', 3, 1, 3, 99, false);
--
--   -- 管理者からは見える（行が確かに存在することの確認）
--   select count(*) as admin_sees from public.draft_modes
--    where mode_key = 'test_hidden';
--   -- → 1 が正しい
--
--   -- 一般利用者になりきる
--   set local role anon;
--   select count(*) as anon_sees from public.draft_modes
--    where mode_key = 'test_hidden';
--   -- → 0 が正しい（is_active = false なのでポリシーが除外する）
--
--   select count(*) as anon_total from public.draft_modes;
--   -- → 2 が正しい（easy と standard だけ。テスト用は数にも入らない）
-- rollback;
--
--   -- rollback 後、テスト用の行が残っていないことの確認（0 が正しい）
-- select count(*) from public.draft_modes where mode_key = 'test_hidden';
--
--
-- ⑧ 一般利用者が書き込めないことの実地確認。
--
--    3つとも「permission denied for table ...」というエラーになるのが正しい。
--    エラーが出たらその取引は中断された状態になるので、rollback で終える。
--    成功してしまった場合は設定ミス。
--
-- begin;
--   set local role anon;
--   insert into public.tag_pools (pool_key, label, sort_order)
--     values ('test_pool', 'テスト分類', 99);
--   -- → permission denied for table tag_pools が正しい
-- rollback;
--
-- begin;
--   set local role anon;
--   update public.draft_modes set candidate_count = 99 where mode_key = 'easy';
--   -- → permission denied for table draft_modes が正しい
-- rollback;
--
-- begin;
--   set local role anon;
--   delete from public.card_slots where card_slot_key = 'constraint';
--   -- → permission denied for table card_slots が正しい
-- rollback;
--
--    authenticated（サインイン済みの利用者）でも同じ結果になることを、
--    上の3つの set local role anon を set local role authenticated に
--    置き換えて確認しておくとよい。
