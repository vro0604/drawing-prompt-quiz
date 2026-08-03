-- ============================================================================
-- baseline_applied_schema ／ 001〜007 を1本にまとめた基準マイグレーション
-- ============================================================================
--
-- 【これは何か】
--   001〜007 は Supabase の SQL Editor から手で適用した。CLI 運用へ移す際、
--   「いまのリモートDBはこの内容と同じ」という基準を1本のファイルとして残す。
--
-- 【重要：このファイルはリモートでは実行されない】
--   supabase migration repair --status applied で
--   「適用済み」として履歴に登録するだけ。
--   既存の表・データ・権限には一切触れない。
--
--   実際に実行されるのは、新しい環境を1から作り直すときだけ。
--
-- 【中身の作りかた】
--   supabase/applied/ の **本体SQLのみ** を適用順に結合した。
--   ・*_rollback.sql は含めない（表を削除するSQLのため）
--   ・*_verify.sql   は含めない（確認用で、スキーマを作らないため）
--   ・各ファイルの先頭 begin; と末尾 commit; は取り除いた
--     （CLI が全体を1つのトランザクションで実行するため、
--       入れ子にすると途中で確定してしまう）
--   ・それ以外の中身は1文字も変えていない
--
-- 【結合順】
--   001_profiles.sql                 Step 2   profiles ＋ auth.users トリガー
--   002_masters.sql                  Step 3B-1 マスタ5表＋28行
--   003_draft.sql                    Step 3B-2a draft_sessions / draft_candidates
--   004_prompts_quiz.sql             Step 3B-2b prompts / prompt_cards / quiz_questions / quiz_choices
--   005_works_answers.sql            Step 3B-3a works / answers / answer_items / 集計3表
--   006_likes_saves_reports.sql      Step 3B-3b likes / saves / reports
--   007_read_rpcs.sql                Step 3C   取得系RPC 13本
--
-- ============================================================================



-- ############################################################################
-- ### 001_profiles.sql  ／  Step 2   profiles ＋ auth.users トリガー
-- ############################################################################

-- ============================================================================
-- 001_profiles.sql  ／ Step 2: 匿名サインイン＋profiles自動生成
-- ============================================================================
--
-- 【このファイルがやること】
--   1. profiles テーブルを作る（spec 8-5）
--   2. RLS を有効にしてポリシーを張る（spec 9-3 / decisions D12）
--   3. UPDATE できる列を限定する
--   4. auth.users の変化を profiles に反映するトリガーを2つ付ける
--        ・ユーザーが作られたら profiles を1行作る
--        ・匿名 → 登録済みに変わったら is_anonymous を同期する
--
-- 【このファイルがやらないこと】
--   既存のデータを消したり書き換えたりしない。
--   drop を使っているのは「同じ名前のポリシー／トリガー／関数を張り直す」
--   ためだけで、テーブルやその中身に対しては使っていない。
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--   上から順に実行されるので、途中だけ抜き出して流さないこと。
--
--   何度実行しても同じ状態になるように書いてあるので、
--   途中で失敗しても、直してからもう一度まるごと実行してよい。
--
-- 【取り消し】
--   001_profiles_rollback.sql を実行する。
--
-- 【なぜ profiles を Step 3 ではなく今作るのか】
--   匿名サインインの完了条件が「ゲストIDが発行され、profiles が1行できること」
--   だから。ここで作るのは profiles だけで、残りのテーブルは Step 3 で入れる。
--   そのため連番は 001 = profiles、Step 3 以降が 002... となる。
--
--
-- 【権限のまとめ（ここだけ読めば全体が分かる）】
--
--   誰が          何を                                    できる/できない
--   ------------  --------------------------------------  ----------------
--   未サインイン  handle 確定済みユーザーのプロフィール閲覧  できる
--   未サインイン  匿名ユーザーのプロフィール閲覧            できない（0件）
--   未サインイン  handle 未設定のプロフィール閲覧           できない（0件）
--   本人          自分のプロフィール閲覧                    できる
--   本人          自分の profiles を UPDATE                 下の6列だけできる
--   本人          handle / id / created_at の変更           できない
--   本人          is_anonymous の変更                       できない
--   誰でも        profiles への INSERT                      できない（トリガーのみ）
--   誰でも        profiles の DELETE                        できない
--
--   本人が UPDATE できる列（これ以外は権限エラーになる）:
--     display_name, bio, links,
--     show_answer_stats, show_answer_history, show_saved_works
--
--   profiles の行を作れるのは auth.users のトリガーだけ。
--   is_anonymous を書き換えられるのも auth.users のトリガーだけ。
--   どちらもクライアントからの経路を用意していない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. profiles テーブル
-- ----------------------------------------------------------------------------
--
-- auth.users は Supabase が管理する認証専用のテーブルで、直接列を足せない。
-- そこで「アプリが持ちたい情報」は public.profiles に置き、id で 1:1 に結ぶ。
--
-- on delete cascade: auth.users の行が消えたら profiles も消える。
--   匿名ユーザーは30日で自動削除する予定（spec 11-4）なので、この設定が要る。

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,

  -- 登録時に確定する一意なID。匿名のうちは null。
  -- 本人からは変更できない（第3節の列単位の権限を参照）。
  -- 確定は Step 6 の promote_anonymous 関数がサーバー側で行う。
  handle text unique,

  display_name text not null default 'ゲスト',
  bio text,

  -- X / pixiv などの外部リンク。{"x": "https://...", "pixiv": "..."} の形
  links jsonb not null default '{}'::jsonb,

  -- 匿名かどうか。プロフィールを公開するかの判定に使う（第2節の RLS を参照）。
  -- 値を入れるのは auth.users のトリガーだけで、本人は書き換えられない。
  -- 「投稿できる／いいねできる」といった権限の判定にはこの列を使わず、
  -- そちらは偽造できない JWT の値で行う（spec 9-1）。
  is_anonymous boolean not null default true,

  -- 公開設定（spec 8-5 / decisions D10・D11）
  -- 3つとも既定は非公開。本人が設定画面で明示的にオンにしたものだけ公開する。
  --
  -- show_answer_stats は「その人がクイズの回答者としてどれだけ当てられたか」で、
  -- 投稿した作品がどれだけ伝わったかとは別物。作品側の正答率は作品の統計として
  -- 公開されるので、回答者個人の成績まで既定で見せる必要はない。
  show_answer_stats   boolean not null default false,
  show_answer_history boolean not null default false,
  show_saved_works    boolean not null default false,

  created_at timestamptz not null default now(),

  -- handle は 3〜20字。小文字の英数字とハイフンのみで、
  -- 先頭と末尾にハイフンは置けない。
  --   ok : abc / my-handle / a1-b2-c3
  --   ng : AB（大文字）／-abc（先頭）／abc-（末尾）／ab（短い）
  -- 先頭と末尾を別に指定しているのは、URL の見た目を安定させるため
  -- （/u/-abc- のような形を許さない）。
  constraint profiles_handle_format check (
    handle is null or handle ~ '^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$'
  ),

  constraint profiles_display_name_length check (
    char_length(display_name) between 1 and 30
  ),

  -- 自己紹介は500文字まで
  constraint profiles_bio_length check (
    bio is null or char_length(bio) <= 500
  ),

  -- links は「配列」でも「数値」でもなく、必ず {キー: 値} の形であること。
  -- jsonb は配列や文字列も入れられてしまうので、形を固定しておく。
  constraint profiles_links_is_object check (
    jsonb_typeof(links) = 'object'
  ),

  -- links の大きさの上限。文字数ではなくバイト数で測る。
  -- 日本語は1文字3バイト前後なので、文字数制限だと実際の容量が読めないため。
  constraint profiles_links_size check (
    octet_length(links::text) <= 4096
  )
);

comment on table public.profiles is
  'ユーザープロフィール。匿名ユーザーも1行持つ。auth.users と 1:1。'
  '行の作成と is_anonymous の更新は auth.users のトリガーのみが行う。';
comment on column public.profiles.is_anonymous is
  'プロフィールを公開するかの判定に使う（true なら本人だけが見られる）。'
  'auth.users.is_anonymous とトリガーで同期。投稿・いいね等の権限判定には'
  '使わず、JWT の is_anonymous を使う（spec 9-1）。';
comment on column public.profiles.handle is
  '登録時に確定。本人からは変更できず、Step 6 のサーバー関数だけが設定する。'
  'null の間はプロフィールを他人に公開しない。';


-- ----------------------------------------------------------------------------
-- 2. RLS（Row Level Security）
-- ----------------------------------------------------------------------------
--
-- publishable key はブラウザに公開される鍵なので、データを守るのは鍵ではなく
-- このポリシー。RLS を有効にすると、ポリシーで許可した行以外は
-- 「存在しない」ものとして扱われる（エラーではなく 0 件が返る）。
--
-- auth.uid() … いまアクセスしている人のユーザーID。未サインインなら null。
--
-- (select ...) で包むのは Supabase 推奨の書き方。
-- 1行ごとに再評価せず、クエリ開始時に1回だけ評価されるので速い。

alter table public.profiles enable row level security;


-- --- 2-a. 以前の版を実行していた場合の後片付け -------------------------------
--
-- 開発中に作って、その後やめた要素をここで確実に落とす。
-- 一度も実行していなければ何も起きない（if exists のため）。
--
-- 順番が重要。ポリシー → 関数 の順に消す。
-- ポリシーから使われている関数は、先に関数を消そうとしても拒否されるため。
--
-- テーブルを作ったあとに置いているのも同じ理由で、
-- ポリシーを消す命令は対象のテーブルが存在していないと実行できない。
--
-- is_falsely_public: クライアントが is_anonymous を書き換えられる前提の
--   検査用関数だった。その経路自体を塞いだ（INSERT 不可・UPDATE 対象外）ため不要。

drop policy if exists profiles_select_all on public.profiles;
drop policy if exists profiles_select_public_or_self on public.profiles;
drop policy if exists profiles_insert_self on public.profiles;
drop policy if exists profiles_update_self on public.profiles;

drop function if exists public.is_falsely_public(boolean);


-- --- 2-b. SELECT: 公開してよい行だけを見せる（decisions D12） ----------------
--
-- 他人に見せる条件は2つとも満たすこと。
--   is_anonymous = false … 正式に登録したユーザーであること
--   handle is not null   … プロフィールの体裁が整っていること
--
-- handle を条件に入れているのは、登録直後の handle 未設定の状態で
-- 中身の無いプロフィールが他人の目に触れるのを避けるため。
--
-- ポリシーは「条件に合う行だけが存在する」ように働くので、
-- 他人が select * from profiles で一覧を取っても、対象外の行は
-- エラーではなく単に結果に含まれない（count にも出ない）。

create policy profiles_select_public_or_self
  on public.profiles
  for select
  to anon, authenticated
  using (
    (is_anonymous = false and handle is not null)  -- 公開してよいプロフィール
    or (select auth.uid()) = id                    -- 自分のものは常に見られる
  );


-- --- 2-c. INSERT: ポリシーを作らない ----------------------------------------
--
-- profiles の行を作れるのは、第4節のトリガーだけ。
-- RLS が有効なテーブルに INSERT ポリシーが無いと、
-- クライアントからの追加はすべて拒否される。
--
-- 「アプリ側でも念のため作る」経路を残すと、そこを通ったときに
-- is_anonymous の値を自己申告できてしまうため、経路自体を用意しない。


-- --- 2-d. UPDATE: 本人の行のみ ----------------------------------------------
--
-- using      … どの行を対象にできるか（変更前の行で判定）
-- with check … 変更後の行が満たすべき条件
--
-- どの「列」を変えられるかは、RLS ではなく第3節の grant で決まる。
-- is_anonymous と handle はその対象外なので、ここでは行の持ち主だけを見る。

create policy profiles_update_self
  on public.profiles
  for update
  to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);


-- --- 2-e. DELETE: ポリシーを作らない ----------------------------------------
--
-- 誰も削除できない。退会は auth.users 側の削除（cascade）で行う。


-- ----------------------------------------------------------------------------
-- 3. 列単位の権限（UPDATE できる列をここで限定する）
-- ----------------------------------------------------------------------------
--
-- RLS は「どの行か」しか見ない。「どの列を書き換えてよいか」は
-- Postgres の grant で決める。両方そろって初めて意図どおりになる。
--
-- ここで handle を外しているのが要点。
-- handle を許すと、ゲストのうちに好きな handle を先取りできてしまう。
-- id と created_at も外して、後から書き換えられないようにする。
-- is_anonymous も外す（この列が公開範囲を決めるため、自己申告させない）。
--
-- INSERT の権限はどの列にも与えない。行を作るのはトリガーだけ。
--
-- revoke all を先に流すのは、以前の実行で広い権限が付いていた場合に
-- それを確実に落とすため。直後に必要なぶんだけ付け直す。
-- 対象は anon（未サインイン）と authenticated（サインイン済み）だけで、
-- 管理用の service_role とテーブルの所有者には触らない。

revoke all on public.profiles from anon, authenticated;

grant select on public.profiles to anon, authenticated;

grant update (
  display_name,
  bio,
  links,
  show_answer_stats,
  show_answer_history,
  show_saved_works
) on public.profiles to authenticated;


-- ----------------------------------------------------------------------------
-- 4. auth.users と profiles をつなぐトリガー
-- ----------------------------------------------------------------------------
--
-- profiles の「行の作成」と「is_anonymous の更新」は、どちらもここに集約する。
-- アプリ側に同じ処理を書くと、書き忘れた経路から不整合が生まれるため。
--
-- 【security definer とは】
--   関数を「呼んだ人」ではなく「作った人（postgres）」の権限で実行する指定。
--   サインイン直後はまだ RLS 上の本人ではないので、これが無いと INSERT できない。
--   強い権限で動くぶん、中でやることは最小限にする。
--
-- 【set search_path = '' とは】
--   テーブルを探す場所を空にして、必ず public.xxx と完全修飾で書かせる指定。
--   これをしないと、同名の偽テーブルを検索パスに差し込まれて
--   そちらに書かされる攻撃（search_path 乗っ取り）が成立しうる。
--   security definer の関数では特に重要。
--
-- 【revoke all on function ... from public】
--   ここでの public は「公開スキーマ」ではなく「全員」を指すロール名。
--   強い権限で動く関数を、トリガー以外から呼べないようにする。


-- --- 4-a. ユーザーが作られたら profiles を1行作る ----------------------------
--
-- new.is_anonymous … これから作られる auth.users の行の値。
--   匿名サインインなら true、メール登録なら false が入る。
--   ここが「匿名／登録済み」の最初の判定で、以降はこの列が引き継ぐ。

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, is_anonymous)
  values (new.id, coalesce(new.is_anonymous, false))
  on conflict (id) do nothing;   -- 二重実行されても壊れないようにする
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'auth.users の INSERT に反応して profiles を1行作る（Step 2）。';

revoke all on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();


-- --- 4-b. 匿名 → 正式登録に変わったら is_anonymous を同期する ----------------
--
-- ゲストがメールアドレスを紐づけて正式登録すると、Supabase が
-- auth.users.is_anonymous を true から false に変える。
-- そのとき profiles 側も追随させないと、
-- 「登録したのにプロフィールが公開されないまま」になる。
--
-- 逆向き（false → true）も同じ仕組みで反映される。
-- 起点は常に auth.users で、profiles はその写しという関係にする。
--
-- update of is_anonymous … その列が更新対象に含まれるときだけ発火する指定。
-- when (...)             … 実際に値が変わったときだけ本体を実行する条件。
--   ログイン日時の更新など、関係のない UPDATE で毎回動かさないため。
-- is distinct from       … null があっても正しく「違う」を判定する比較。

create or replace function public.sync_profile_anonymous_flag()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
     set is_anonymous = coalesce(new.is_anonymous, false)
   where id = new.id
     and is_anonymous is distinct from coalesce(new.is_anonymous, false);
  return new;
end;
$$;

comment on function public.sync_profile_anonymous_flag() is
  'auth.users.is_anonymous の変化を profiles.is_anonymous へ反映する（Step 2）。';

revoke all on function public.sync_profile_anonymous_flag() from public, anon, authenticated;

drop trigger if exists on_auth_user_anonymous_changed on auth.users;
create trigger on_auth_user_anonymous_changed
  after update of is_anonymous on auth.users
  for each row
  when (old.is_anonymous is distinct from new.is_anonymous)
  execute function public.sync_profile_anonymous_flag();


-- ============================================================================
-- 確認用クエリ（実行は任意。SQL Editor に貼って結果を見る）
-- ============================================================================
--
-- -- ポリシーが2件（SELECT / UPDATE）だけであること。
-- -- INSERT と DELETE が出てきたら設定ミス。
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename = 'profiles'
--  order by cmd;
--
-- -- RLS が有効であること（rowsecurity = true）
-- select relname, relrowsecurity from pg_class where relname = 'profiles';
--
-- -- 一般ユーザーに与えた権限の一覧。
-- -- SELECT が1件と、UPDATE が下の6列だけ並ぶのが正しい。
-- -- INSERT・DELETE、または handle / id / created_at / is_anonymous への
-- -- UPDATE が出てきたら設定ミス。
-- select privilege_type, column_name
--   from information_schema.column_privileges
--  where table_schema = 'public' and table_name = 'profiles'
--    and grantee in ('anon', 'authenticated')
--  order by privilege_type, column_name;
--
-- -- トリガーが2件付いていること
-- -- （on_auth_user_created と on_auth_user_anonymous_changed）
-- select tgname from pg_trigger where tgrelid = 'auth.users'::regclass
--    and not tgisinternal;
--
-- -- 関数に search_path が設定されていること（両方に search_path= が出る）
-- select proname, proconfig from pg_proc
--  where proname in ('handle_new_user', 'sync_profile_anonymous_flag');
--
-- -- ユーザーと profiles の対応（匿名サインインを試したあとに実行）
-- -- ※ SQL Editor は管理者権限で動くので RLS を通らず、全部見える
-- select u.id, u.is_anonymous, p.is_anonymous, p.handle, p.display_name
--   from auth.users u left join public.profiles p on p.id = u.id
--  order by u.created_at desc limit 10;
--
-- -- 「他人からは匿名プロフィールが見えない」ことの確認。
-- -- 未サインインの訪問者（anon ロール）になりきって数えるので、
-- -- 匿名ユーザーしか居ない段階では 0 件になるのが正しい。
-- begin;
--   set local role anon;
--   select count(*) as visible_rows from public.profiles;
-- rollback;


-- ############################################################################
-- ### 002_masters.sql  ／  Step 3B-1 マスタ5表＋28行
-- ############################################################################

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


-- ############################################################################
-- ### 003_draft.sql  ／  Step 3B-2a draft_sessions / draft_candidates
-- ############################################################################

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


-- ############################################################################
-- ### 004_prompts_quiz.sql  ／  Step 3B-2b prompts / prompt_cards / quiz_questions / quiz_choices
-- ############################################################################

-- ============================================================================
-- 004_prompts_quiz.sql  ／ Step 3B-2b: 確定お題・クイズ4表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. prompts（確定したお題）を作る
--   2. prompt_cards（お題を構成する確定カード＝答え）【機密】を作る
--   3. quiz_questions（出題される問）【機密】を作る
--   4. quiz_choices（各問の4択と正解の印）【機密】を作る
--   5. RLS と権限を設定する
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（4表とも 0 行のまま）
--   ・お題を確定する処理（complete_draft RPC）を作らない。それは Step 5
--   ・クイズを返す処理（get_work_quiz RPC）を作らない。それは Step 10
--   ・既存8表（profiles / マスタ5表 / ドラフト2表）に一切触れない
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。
--
-- 【重要：正常終了した番号付きマイグレーションは再実行しない】
--   create table に if not exists を付けていない。すでに表がある状態で
--   実行すると「already exists」で止まる。これは意図した動作。
--   やり直すときは 004_prompts_quiz_rollback.sql で消してから流し直す。
--
-- 【前提】
--   003_draft.sql まで実行済みであること。
--   prompts が draft_sessions / profiles / draft_modes を、
--   prompt_cards と quiz_choices が tags を参照する。
--
-- 【取り消し】
--   004_prompts_quiz_rollback.sql を実行する。
--
--
-- 【この工程でいちばん大事なこと】
--
--   3B-2a の draft_candidates は「まだ見ていないカード」だった。
--   今回扱うのは **確定した答え** と **正解の印そのもの**。
--
--   prompt_cards   … 選ばれたタグ。お題の答えそのもの
--   quiz_questions … どのお題のどの枠が出題されているか
--   quiz_choices   … 4択と、そのうちどれが正解かの印
--
--   この3表は anon にも authenticated にも
--   **テーブル権限を一切与えず、RLS ポリシーも1つも作らない**。
--   読めるのは Step 5 以降の security definer 関数だけ。
--
--   クイズの表示は必ず get_work_quiz(work_id) を通す。
--   「同じ表から is_correct だけ隠して返す」という設計にしないのは、
--   列を1つ足したときに黙って漏れる形だから（D22）。
--
--
-- 【権限のまとめ】
--
--   表               anon        authenticated
--   ---------------  ----------  ------------------------------
--   prompts          権限なし    SELECT（8列のみ・本人の行だけ）
--   prompt_cards     権限なし    権限なし
--   quiz_questions   権限なし    権限なし
--   quiz_choices     権限なし    権限なし
--
--   INSERT / UPDATE / DELETE はどのロールにも与えない（すべて RPC 経由）。
--
--   prompts で読める8列:
--     id, mode_key, time_limit_seconds, was_rerolled,
--     reroll_count, status, candidates_revealed_at, created_at
--
--   読めない5列:
--     draft_session_id, created_by, reveal_reason, submitted_at, abandoned_at
--
--
-- 【DB では防げないこと（Step 5 の complete_draft が保証する）】
--
--   quiz_choices の部分UNIQUE が保証するのは「正解が **最大** 1件」であり、
--   「正解が **必ず** 1件存在する」ことではない。次の状態は DB を通る。
--
--     ・正解が 0 件の問題
--     ・選択肢が 4 件でない問題
--     ・正解のタグが prompt_cards の答えと一致しない問題
--     ・prompt_cards の件数がモードの枠数と一致しないお題
--
--   これらは complete_draft RPC が保証し、テストで確認する。
--   さらに Step 3E の診断で「壊れていたら必ず見つかる」状態にする
--   （検出クエリはこのファイルの末尾に用意した）。
--
-- ============================================================================




-- ----------------------------------------------------------------------------
-- 1. prompts ／ 確定したお題
-- ----------------------------------------------------------------------------
--
-- ドラフトを引き終えると1行できる。
-- この表自体にタグは入っていない（答えは prompt_cards 側）ため、
-- 本人が直接読んでも正解は漏れない。

create table public.prompts (
  id uuid primary key default gen_random_uuid(),

  -- どのドラフトから生まれたお題か。
  --
  -- 【非公開列】
  --
  -- unique かつ null 許容にしている理由:
  --   PostgreSQL の unique は null を重複とみなさない。そのため
  --     ・値が入っている限り「1つのドラフトから作れるお題は最大1件」
  --     ・null になった行は何件あってもよい
  --   の両方が同時に成り立つ。
  --
  -- on delete set null:
  --   ゲストが30日で削除されると draft_sessions が cascade で消えるが、
  --   そのお題で作られた作品が残っている可能性があるため、お題は残す。
  --
  -- 【確定した副作用】
  --   ドラフトが消えると draft_candidates（未選択カード）も一緒に消える。
  --   その結果、そのお題の未選択カードは永久に辿れなくなる。
  --   答え（prompt_cards）は残るのでクイズは成立し続ける。
  --   これは意図した制限として受容する。
  draft_session_id uuid unique
    references public.draft_sessions (id) on delete set null on update restrict,

  -- 誰が引いたお題か。ゲストも含む。
  -- 【非公開列】RLS の条件に使うが値は渡さない。
  --
  -- on delete set null: 作成者が消えてもお題は残す（spec 11-4）。
  --   null になると RLS の条件（auth.uid() = created_by）が真にならないため、
  --   そのお題は誰からも見えなくなる。エラーではなく 0 件。
  --   作品ページの表示に必要な情報は security definer の RPC が取得するので、
  --   表示は壊れない。
  created_by uuid
    references public.profiles (id) on delete set null on update restrict,

  mode_key text not null
    references public.draft_modes (mode_key) on delete restrict on update restrict,

  -- 制作時間。確定時に draft_sessions からコピーする。null = 無制限。
  time_limit_seconds int
    constraint prompts_time_limit_range check (
      time_limit_seconds is null or time_limit_seconds between 60 and 600000
    ),

  was_rerolled boolean not null default false,

  reroll_count int not null default 0
    constraint prompts_reroll_count_range check (reroll_count between 0 and 5),

  -- active    … お題は確定したが、まだ作品が投稿されていない
  -- submitted … この お題で作品が投稿された
  -- abandoned … 描かないと本人が宣言した
  --
  -- 【位置づけ】表示・進行管理用の派生状態（D35）。
  -- 「1つのお題から最大1作品」の強制保証は works.prompt_id の UNIQUE だけが担う。
  -- status を根拠に作品作成を拒否する二重管理は行わない。
  status text not null default 'active',

  -- 未選択カードを開示した日時と理由。開示は不可逆。
  candidates_revealed_at timestamptz,
  reveal_reason text,   -- 【非公開列】

  created_at   timestamptz not null default now(),
  submitted_at timestamptz,   -- 【非公開列】
  abandoned_at timestamptz,   -- 【非公開列】

  -- --- 整合条件 -------------------------------------------------------------

  constraint prompts_status_valid check (
    status in ('active', 'submitted', 'abandoned')
  ),

  constraint prompts_reveal_reason_valid check (
    reveal_reason is null
    or reveal_reason in ('work_submitted', 'abandoned', 'manual')
  ),

  -- 開示日時と理由はセット。「開示したのに理由が無い」を防ぐ
  constraint prompts_reveal_pair check (
    (candidates_revealed_at is null     and reveal_reason is null)
    or
    (candidates_revealed_at is not null and reveal_reason is not null)
  ),

  -- 引き直しフラグと回数の整合。片方だけ更新するバグを止める
  constraint prompts_rerolled_matches_count check (
    was_rerolled = (reroll_count > 0)
  ),

  -- status と日時の整合
  constraint prompts_status_timestamps check (
    (status = 'active'    and submitted_at is null     and abandoned_at is null)
    or
    (status = 'submitted' and submitted_at is not null and abandoned_at is null)
    or
    (status = 'abandoned' and abandoned_at is not null and submitted_at is null)
  ),

  -- 日時の前後関係
  constraint prompts_revealed_after_created check (
    candidates_revealed_at is null or candidates_revealed_at >= created_at
  ),
  constraint prompts_submitted_after_created check (
    submitted_at is null or submitted_at >= created_at
  ),
  constraint prompts_abandoned_after_created check (
    abandoned_at is null or abandoned_at >= created_at
  )
);

comment on table public.prompts is
  '確定したお題。答えは prompt_cards 側にあるため、この表は本人が読んでも安全。';
comment on column public.prompts.draft_session_id is
  'null 許容かつ UNIQUE。1ドラフト1お題を保証しつつ、ドラフト削除後の null を許す。';
comment on column public.prompts.status is
  '表示・進行管理用の派生状態。1お題1作品の保証は works.prompt_id の UNIQUE が担う。';

-- 「自分が発行したお題の一覧」を引くため
create index prompts_created_by_idx
  on public.prompts (created_by);

-- Step 16 の掃除（公開前必須課題 P4）で孤児のお題を抽出するため。
-- created_by が null の行だけを対象にした部分インデックス。
create index prompts_orphan_cleanup_idx
  on public.prompts (status)
  where created_by is null;


-- ----------------------------------------------------------------------------
-- 2. prompt_cards ／ お題を構成する確定カード【機密】
-- ----------------------------------------------------------------------------
--
-- 選ばれたタグ。**これがクイズの答えそのもの**。
-- 権限もポリシーも与えない。

create table public.prompt_cards (
  id bigint generated always as identity primary key,

  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 確定時点の枠の提示順の写し。
  -- draft_mode_slots の並び順は将来変更され得るため、写しが無いと
  -- 後からお題カードを表示したときに当時と違う順番になる。
  slot_order int not null
    constraint prompt_cards_slot_order_positive check (slot_order >= 1),

  -- 【機密】答えそのもの。
  -- 一度でも使われたタグは削除できない（restrict）。
  -- やめたいタグは行を消さず tags.is_active = false にする。
  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  created_at timestamptz not null default now(),

  -- 1つの枠に答えは1つだけ
  constraint prompt_cards_slot_unique unique (prompt_id, card_slot_key),

  -- 枠の順番が重複しない
  constraint prompt_cards_order_unique unique (prompt_id, slot_order),

  -- 同じお題に同じタグが2回出ない。
  -- draft_candidates の「同一世代でタグ重複なし」の確定版。
  -- モチーフAとモチーフBが両方「傘」になる事故を、確定後の表でも防ぐ。
  constraint prompt_cards_tag_unique unique (prompt_id, tag_id)
);

comment on table public.prompt_cards is
  'お題の確定カード【機密】。クイズの答えそのもの。RPC 経由でのみ読む。';
comment on column public.prompt_cards.tag_id is
  '【機密】クイズの正解に直結する。クライアントへ直接渡らない。';


-- ----------------------------------------------------------------------------
-- 3. quiz_questions ／ 出題される問【機密】
-- ----------------------------------------------------------------------------
--
-- 「このお題の1問目はモチーフAを問う」という情報。
--
-- 機密にしている理由（D20）:
--   ・prompt_id を含むため、公開すると作品からお題へ辿る経路になり得る
--   ・「どのお題のどの枠が出題されているか」自体が推測材料になる
--   ・クライアントは get_work_quiz(work_id) だけを使うので直接読む必要がない
--
-- 注: position は PostgreSQL のキーワードだが、列名としては問題なく使える
--     （関数形 position(a in b) と混同されるのは括弧が続く場合のみ）。

create table public.quiz_questions (
  id bigint generated always as identity primary key,

  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  -- 出題順。0 始まり。上限はモードの quiz_question_count（MVPは3問）だが、
  -- 別表を見ないと判定できないため、ここでは形式的な範囲だけを見る。
  position int not null
    constraint quiz_questions_position_range check (position between 0 and 9),

  created_at timestamptz not null default now(),

  -- 出題順が重複しない
  constraint quiz_questions_position_unique unique (prompt_id, position),

  -- 同じ枠から2問出さない
  constraint quiz_questions_slot_unique unique (prompt_id, card_slot_key)
);

comment on table public.quiz_questions is
  '出題される問【機密】。prompt_id を含むため公開しない。';


-- ----------------------------------------------------------------------------
-- 4. quiz_choices ／ 各問の4択と正解の印【機密】
-- ----------------------------------------------------------------------------
--
-- 1問につき4行。そのうち1行の is_correct が true。
-- 選択肢の文字（tags.label）を返すのは get_work_quiz RPC の仕事で、
-- そのとき is_correct は返り値に含めない。

create table public.quiz_choices (
  id bigint generated always as identity primary key,

  question_id bigint not null
    references public.quiz_questions (id) on delete cascade on update restrict,

  -- 選択肢のタグ。誤答に使われたタグも削除できなくなる（restrict）。
  -- 過去のクイズが成立しなくなるのを防ぐため。
  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- 選択肢の並び順。4択固定なので 0〜3（A2 / D15）。
  position int not null
    constraint quiz_choices_position_range check (position between 0 and 3),

  -- 【機密】正解の印。
  is_correct boolean not null default false,

  created_at timestamptz not null default now(),

  -- 並び順が重複しない
  constraint quiz_choices_position_unique unique (question_id, position),

  -- 同じ選択肢が2回出ない
  constraint quiz_choices_tag_unique unique (question_id, tag_id)
);

comment on table public.quiz_choices is
  '各問の4択と正解の印【機密】。is_correct は RPC の返り値にも含めない。';
comment on column public.quiz_choices.is_correct is
  '【機密】部分UNIQUE で保証できるのは「最大1件」まで。'
  '「必ず1件」は complete_draft RPC が保証する。';

-- 正解は **最大** 1件。
--
-- 【重要】この索引は「正解が2件以上」は防ぐが、
--         「正解が0件」は防げない。0件の問題は DB を通ってしまう。
--         正解がちょうど1件存在することは Step 5 の complete_draft が保証し、
--         Step 3E の診断（末尾の検出クエリ）で壊れていないかを継続確認する。
create unique index quiz_choices_one_correct_idx
  on public.quiz_choices (question_id)
  where is_correct;


-- ----------------------------------------------------------------------------
-- 5. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- prompts        … 本人の行だけ SELECT できる
-- 機密3表        … ポリシーを1つも作らない（完全遮断）
--
-- 機密3表は権限も与えていないため、実際には RLS が働く前に権限エラーで止まる。
-- それでも RLS を有効にしておくのは、将来うっかり grant を足したときの保険。

alter table public.prompts        enable row level security;
alter table public.prompt_cards   enable row level security;
alter table public.quiz_questions enable row level security;
alter table public.quiz_choices   enable row level security;

-- 本人のお題だけ読める。
-- created_by が null（作成者が削除された）の行は、この条件が真にならないため
-- 誰からも見えなくなる。エラーではなく 0 件。
create policy prompts_select_own
  on public.prompts
  for select
  to authenticated
  using ((select auth.uid()) = created_by);

-- prompts の INSERT / UPDATE / DELETE ポリシーは作らない。
-- prompt_cards / quiz_questions / quiz_choices のポリシーは1つも作らない。


-- ----------------------------------------------------------------------------
-- 6. 列単位の権限
-- ----------------------------------------------------------------------------

revoke all on public.prompts        from anon, authenticated;
revoke all on public.prompt_cards   from anon, authenticated;
revoke all on public.quiz_questions from anon, authenticated;
revoke all on public.quiz_choices   from anon, authenticated;

-- prompts: サインイン済みの利用者に、答えに関係しない8列だけ。
--   draft_session_id … ドラフトとの紐付けは内部情報
--   created_by       … RLS の条件に使うが値は見せない
--   reveal_reason    … 開示の理由は内部情報
--   submitted_at     … 掃除と診断の基準
--   abandoned_at     … 同上
grant select (
  id,
  mode_key,
  time_limit_seconds,
  was_rerolled,
  reroll_count,
  status,
  candidates_revealed_at,
  created_at
) on public.prompts to authenticated;

-- anon には何も与えない（grant 文を書かない）。
-- prompt_cards / quiz_questions / quiz_choices には誰にも何も与えない。




-- ============================================================================
-- Step 3E の必須診断（新規論点A）
-- ============================================================================
--
-- DB の制約では防げない壊れ方を検出する。
-- Step 3E の横断診断ページ、および運用中の定期確認に組み込む。
-- **4つとも 0 行であることが正常**。
--
-- ① 正解がちょうど1件でない問題（0件 または 2件以上）
--    → 0件の問題は回答者が必ず不正解になり、正答率の統計が汚染される
-- select q.id as question_id, q.prompt_id, count(c.id) filter (where c.is_correct) as correct_count
--   from public.quiz_questions q
--   left join public.quiz_choices c on c.question_id = q.id
--  group by q.id, q.prompt_id
-- having count(c.id) filter (where c.is_correct) <> 1;
--
-- ② 選択肢が4件でない問題
-- select q.id as question_id, q.prompt_id, count(c.id) as choice_count
--   from public.quiz_questions q
--   left join public.quiz_choices c on c.question_id = q.id
--  group by q.id, q.prompt_id
-- having count(c.id) <> 4;
--
-- ③ 正解タグが prompt_cards の答えと一致しない問題
--    → 「その枠の答え」と「正解の印が付いた選択肢」がずれている
-- select q.id as question_id, q.prompt_id, q.card_slot_key,
--        pc.tag_id as answer_tag, c.tag_id as marked_correct_tag
--   from public.quiz_questions q
--   join public.quiz_choices c
--     on c.question_id = q.id and c.is_correct
--   left join public.prompt_cards pc
--     on pc.prompt_id = q.prompt_id and pc.card_slot_key = q.card_slot_key
--  where pc.tag_id is distinct from c.tag_id;
--
-- ④ prompt_cards の件数がモードの枠数と一致しないお題
-- select p.id as prompt_id, p.mode_key,
--        count(pc.id) as card_count,
--        (select count(*) from public.draft_mode_slots s
--          where s.mode_key = p.mode_key) as expected_count
--   from public.prompts p
--   left join public.prompt_cards pc on pc.prompt_id = p.id
--  group by p.id, p.mode_key
-- having count(pc.id) <> (select count(*) from public.draft_mode_slots s
--                          where s.mode_key = p.mode_key);
--
-- ⑤ status = 'submitted' なのに作品が存在しないお題（3B-3a 実行後に有効）
--    → 通常の掃除では消さず、この診断で検出する（P4）
-- select id, mode_key, submitted_at from public.prompts
--  where status = 'submitted'
--    and not exists (select 1 from public.works w where w.prompt_id = prompts.id);


-- ============================================================================
-- 確認用クエリ（実行は任意。SQL Editor に貼って結果を見る）
-- ============================================================================
--
-- ① 4表ができていて、すべて 0 行であること
-- select 'prompts' as t, count(*) from public.prompts
-- union all select 'prompt_cards',   count(*) from public.prompt_cards
-- union all select 'quiz_questions', count(*) from public.quiz_questions
-- union all select 'quiz_choices',   count(*) from public.quiz_choices;
--
--
-- ② ポリシーが1件（prompts の SELECT）だけであること。
--    機密3表の行が出てきたら設定ミス。
-- select tablename, policyname, cmd, roles from pg_policies
--  where schemaname = 'public'
--    and tablename in ('prompts','prompt_cards','quiz_questions','quiz_choices')
--  order by tablename;
--
--
-- ③ 4表とも RLS が有効であること（rowsecurity = true が4件）
-- select relname, relrowsecurity from pg_class
--  where relname in ('prompts','prompt_cards','quiz_questions','quiz_choices');
--
--
-- ④ 【最重要】機密3表が誰からも読めないこと。
--    6つとも permission denied が正しい。0 件が返ったら設定ミス。
-- begin;
--   set local role anon;
--   select * from public.prompt_cards;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.prompt_cards;
-- rollback;
--
-- begin;
--   set local role anon;
--   select * from public.quiz_questions;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.quiz_questions;
-- rollback;
--
-- begin;
--   set local role anon;
--   select * from public.quiz_choices;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.quiz_choices;
-- rollback;
--
--
-- ⑤ anon は prompts も読めないこと（permission denied が正しい）
-- begin;
--   set local role anon;
--   select id, status from public.prompts;
-- rollback;
--
--
-- ⑥ authenticated は列を指定すれば読めること（0 件が返る。エラーにならない）
-- begin;
--   set local role authenticated;
--   select id, mode_key, status from public.prompts;   -- → 0 件
-- rollback;
--
--
-- ⑦ authenticated でも非公開列は読めないこと（3つとも permission denied）
-- begin;
--   set local role authenticated;
--   select created_by from public.prompts;
-- rollback;
-- begin;
--   set local role authenticated;
--   select draft_session_id from public.prompts;
-- rollback;
-- begin;
--   set local role authenticated;
--   select * from public.prompts;   -- * は非公開列を含むので拒否される
-- rollback;
--
--
-- ⑧ 【重要】本人だけが自分のお題を読めること（D34 の方式）。
--    (a) が 1、(b) が 0 なら RLS が正しく働いている。
-- begin;
--   insert into public.prompts (id, created_by, mode_key, time_limit_seconds)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy', 3600
--     from public.profiles order by created_at limit 1;
--
--   -- (a) 本人になりきる
--   select set_config(
--     'request.jwt.claim.sub',
--     (select created_by::text from public.prompts
--       where id = '33333333-3333-3333-3333-333333333333'),
--     true
--   );
--   set local role authenticated;
--   select count(id) as own_rows from public.prompts;      -- → 1 が正しい
--   reset role;
--
--   -- (b) 別人になりきる
--   select set_config(
--     'request.jwt.claim.sub',
--     '99999999-9999-9999-9999-999999999999',
--     true
--   );
--   set local role authenticated;
--   select count(id) as other_rows from public.prompts;    -- → 0 が正しい
-- rollback;
--
--
-- ⑨ 作成者が消えたお題が誰からも見えなくなること。
--    created_by を null にすると、本人でも 0 件になる。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   select set_config(
--     'request.jwt.claim.sub',
--     (select created_by::text from public.prompts
--       where id = '33333333-3333-3333-3333-333333333333'),
--     true
--   );
--
--   update public.prompts set created_by = null
--    where id = '33333333-3333-3333-3333-333333333333';
--
--   set local role authenticated;
--   select count(id) as visible from public.prompts;       -- → 0 が正しい
-- rollback;
--
--
-- ⑩ 1つのドラフトから2つのお題を作れないこと。
--    2件目で unique 違反が出るのが正しい。
--    （draft_sessions に行が無い環境では ⑩ は飛ばしてよい）
-- begin;
--   insert into public.draft_sessions
--     (id, user_id, mode_key, candidate_count, max_rerolls, quiz_question_count)
--   select '44444444-4444-4444-4444-444444444444', id, 'easy', 3, 1, 3
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333',
--          '44444444-4444-4444-4444-444444444444', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '55555555-5555-5555-5555-555555555555',
--          '44444444-4444-4444-4444-444444444444', id, 'easy'
--     from public.profiles order by created_at limit 1;
--   -- → ERROR: duplicate key value violates unique constraint
--   --           "prompts_draft_session_id_key"
-- rollback;
--
--
-- ⑪ draft_session_id が null のお題は何件でも作れること（⑩の裏返し）。
--    2件とも成功するのが正しい。
-- begin;
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', null, id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.prompts (id, draft_session_id, created_by, mode_key)
--   select '55555555-5555-5555-5555-555555555555', null, id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   select count(*) as both_inserted from public.prompts
--    where id in ('33333333-3333-3333-3333-333333333333',
--                 '55555555-5555-5555-5555-555555555555');
--   -- → 2 が正しい
-- rollback;
--
--
-- ⑫ 状態と日時の整合が守られること。
--    「submitted にしたのに submitted_at を入れない」更新が拒否される。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   update public.prompts set status = 'submitted'
--    where id = '33333333-3333-3333-3333-333333333333';
--   -- → ERROR: violates check constraint "prompts_status_timestamps"
-- rollback;
--
--
-- ⑬ 開示日時と理由がセットであること。
--    片方だけ入れる更新が拒否される。
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   update public.prompts set candidates_revealed_at = now()
--    where id = '33333333-3333-3333-3333-333333333333';
--   -- → ERROR: violates check constraint "prompts_reveal_pair"
-- rollback;
--
--
-- ⑭ 1問に正解を2件付けられないこと。
--    2件目の insert で unique 違反が出るのが正しい。
--    （tags が 0 行の間は実行できないので、3D 実行後に試す）
-- begin;
--   insert into public.prompts (id, created_by, mode_key)
--   select '33333333-3333-3333-3333-333333333333', id, 'easy'
--     from public.profiles order by created_at limit 1;
--
--   insert into public.quiz_questions (id, prompt_id, card_slot_key, position)
--   overriding system value
--   values (999999, '33333333-3333-3333-3333-333333333333', 'motif_a', 0);
--
--   insert into public.quiz_choices (question_id, tag_id, position, is_correct)
--   select 999999, id, 0, true from public.tags limit 1;
--
--   insert into public.quiz_choices (question_id, tag_id, position, is_correct)
--   select 999999, id, 1, true from public.tags offset 1 limit 1;
--   -- → ERROR: duplicate key value violates unique constraint
--   --           "quiz_choices_one_correct_idx"
-- rollback;
--
--
-- ⑮ 列権限の一覧（anon の行が1件も出ないこと）
-- select
--   grantee,
--   table_name,
--   privilege_type,
--   string_agg(column_name, ', ' order by column_name) as columns
-- from information_schema.column_privileges
-- where table_schema = 'public'
--   and table_name in ('prompts','prompt_cards','quiz_questions','quiz_choices')
--   and grantee in ('anon', 'authenticated')
-- group by grantee, table_name, privilege_type
-- order by grantee, table_name, privilege_type;
--
--    期待される結果は1行だけ:
--      authenticated | prompts | SELECT | candidates_revealed_at, created_at,
--                      id, mode_key, reroll_count, status,
--                      time_limit_seconds, was_rerolled
--    anon の行、機密3表の行、INSERT/UPDATE/DELETE の行が
--    1件でも出たら設定ミス。


-- ############################################################################
-- ### 005_works_answers.sql  ／  Step 3B-3a works / answers / answer_items / 集計3表
-- ############################################################################

-- ============================================================================
-- 005_works_answers.sql  ／ Step 3B-3a: 作品・回答・集計6表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. works（投稿作品）を作る
--   2. answers（回答1件）を作る
--   3. answer_items（回答の内訳）【機密】を作る
--   4. work_slot_stats（作品×枠の集計）を作る
--   5. user_stats（回答者の通算成績）を作る
--   6. user_slot_stats（回答者×枠の成績）を作る
--   7. RLS と権限を設定する
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（6表とも 0 行のまま）
--   ・集計を更新するトリガーを作らない。それは Step 9 の回答RPCと同時
--     （論点4-A。3B-3a 完了時点で集計3表が空なのは **意図した状態**）
--   ・作品の投稿・取得・回答の処理（RPC）を作らない。Step 6 以降
--   ・既存12表（profiles / マスタ5表 / ドラフト2表 / お題クイズ4表）に
--     一切触れない
--   ・Storage のバケットを作らない。それは Step 8
--
-- 【実行方法】
--   Supabase ダッシュボード → 左メニュー SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。
--
-- 【重要：正常終了した番号付きマイグレーションは再実行しない】
--   create table に if not exists を付けていない。すでに表がある状態で
--   実行すると「already exists」で止まる。これは意図した動作。
--   やり直すときは 005_works_answers_rollback.sql で消してから流し直す。
--
-- 【前提】
--   004_prompts_quiz.sql まで実行済みであること。
--   works が prompts / profiles を、
--   answer_items が quiz_questions / card_slots / tags を参照する。
--
-- 【取り消し】
--   005_works_answers_rollback.sql を実行する。
--
--
-- 【この工程でいちばん大事なこと】
--
--   answer_items は「誰が・どの問で・どのタグを選び・それが正解だったか」を
--   1行に持つ。**他人のこの行が1件でも読めると、is_correct = true の行から
--   正解タグがそのまま判明する**。クイズが成立しなくなる。
--
--   そこで6表のうち4表は、3B-2a の draft_candidates、
--   3B-2b の機密3表と同じ扱いにする。
--
--     ・テーブル権限を一切与えない（grant を書かない）
--     ・RLS を有効にし、ポリシーを1つも作らない
--
--   直接読もうとすると 0 件ではなく **permission denied** になる（D31）。
--   データを返すのは Step 6 以降の security definer 関数だけ。
--
--
-- 【権限のまとめ】
--
--   表                anon                    authenticated
--   ----------------  ----------------------  --------------------------
--   works             権限なし                権限なし
--   answers           権限なし                権限なし
--   answer_items      権限なし                権限なし
--   work_slot_stats   権限なし                権限なし
--   user_stats        SELECT（公開者の行）    SELECT（本人＋公開者の行）
--   user_slot_stats   SELECT（公開者の行）    SELECT（本人＋公開者の行）
--
--   INSERT / UPDATE / DELETE はどのロールにも与えない。
--   集計3表へ書き込むのは Step 9 のトリガーだけ。
--
--   works の取得経路（論点1-B。D23 のまま変更しない）:
--     get_public_works / get_work_detail / get_my_works / get_my_work
--
--   回答履歴の取得経路（本人のみ。他人へ公開しない）:
--     get_my_answers / get_my_answer
--     → get_public_answer_history は **作らない**。
--        回答履歴は show_answer_stats で公開する集計値とは別の
--        個人の行動履歴であり、MVP では他人へ公開しない。
--        他人へ見せてよいのは user_stats / user_slot_stats の集計値だけ。
--
--   伝達率・枠別正答率（work_slot_stats）の取得経路:
--     get_work_detail / get_my_work の返り値に含める
--     → 直接公開すると、作品IDを総当たりすることで
--        非公開・削除済み作品の存在と回答件数が外から分かってしまう。
--
--
-- 【DB では防げないこと（Step 9 の submit_answer が保証する）】
--
--   次の状態は制約では表現できない（別の表を見る必要があるため）。
--
--     ・answers.correct_count が answer_items の正解数と一致しない
--     ・answer_items の件数が、その作品の問題数と一致しない
--     ・works.answers_count が answers の実件数と一致しない
--     ・answer_items.card_slot_key が、その問の枠と一致しない
--     ・作者が自分の作品に回答してしまう（D28）
--
--   これらは submit_answer RPC が保証し、
--   Step 3E の診断 A6〜A9（このファイル末尾）で継続的に確認する。
--
-- ============================================================================




-- ----------------------------------------------------------------------------
-- 1. works ／ 投稿作品
-- ----------------------------------------------------------------------------
--
-- お題を引いて絵を描き終えた人が投稿すると1行できる。
-- 画像そのものはここに入らない。Storage に置き、その場所を image_path に持つ。
--
-- prompt_id に UNIQUE を張ることで「1つのお題から作れる作品は最大1件」に
-- なる（A11 / D17）。同じお題で2作品目を作ろうとすると DB が拒否する。

create table public.works (

  id uuid primary key default gen_random_uuid(),

  -- どのお題から生まれた作品か。
  --
  -- 【最重要】この列はどの取得経路でもクライアントへ返さない（D23）。
  --   返してしまうと prompt_cards（答え）へ辿る足がかりになる。
  --   works 自体に権限を与えないので、そもそも直接は読めない。
  --
  -- ON DELETE RESTRICT:
  --   お題を消そうとしても、作品が付いていれば拒否される。
  --   P4 の掃除（作品のないお題だけが対象）と衝突しない安全弁。
  prompt_id uuid not null unique
    references public.prompts (id) on delete restrict on update restrict,

  -- 投稿者。**正式登録ユーザーのみ**（匿名ゲストは投稿できない）。
  --
  -- ON DELETE RESTRICT:
  --   作品を持つ人は消せない。退会手段は P1 で別途決める。
  --   匿名ゲストの30日削除は、そもそも作品を持てないので衝突しない。
  user_id uuid not null
    references public.profiles (id) on delete restrict on update restrict,

  title text not null
    constraint works_title_length check (char_length(title) between 1 and 60),

  -- Storage 内のパス。画像バイナリではない。
  image_path text not null
    constraint works_image_path_length check (char_length(image_path) between 1 and 512),

  image_width int not null
    constraint works_image_width_range check (image_width between 1 and 20000),
  image_height int not null
    constraint works_image_height_range check (image_height between 1 and 20000),

  -- 部門。**投稿後は変更できない**（下のファンアート整合条件を保つため）。
  -- 間違えた場合は投稿し直す。
  division text not null,

  -- ファンアート専用の3列。division = 'fanart' 以外では必ず null。
  source_title text
    constraint works_source_title_length check (
      source_title is null or char_length(source_title) between 1 and 100
    ),
  source_character text
    constraint works_source_character_length check (
      source_character is null or char_length(source_character) between 1 and 100
    ),
  fanart_note text
    constraint works_fanart_note_length check (
      fanart_note is null or char_length(fanart_note) between 1 and 500
    ),

  -- 実績時間の自己申告（秒）。null = 未申告。
  -- 時間別ランキングの分類には使わない（分類は prompts.time_limit_seconds）。
  -- 公開後は変更できない（D25。これは RPC 側で保証する）。
  actual_time_seconds int
    constraint works_actual_time_range check (
      actual_time_seconds is null or actual_time_seconds between 1 and 600000
    ),

  is_published boolean not null default true,

  -- 運営のみが変更する。クライアントからは触れない。
  review_status text not null default 'ok',

  -- 論理削除。物理削除しないのは、回答や集計を巻き添えにしないため。
  deleted_at timestamptz,

  -- --- カウンタ（トリガーで同期するキャッシュ。D24）---------------------
  -- 正本は likes / saves / answers の行数。
  -- ずれたら数え直せば復旧できる。更新するのは Step 9 以降のトリガーだけ。
  likes_count int not null default 0
    constraint works_likes_count_positive check (likes_count >= 0),
  saves_count int not null default 0
    constraint works_saves_count_positive check (saves_count >= 0),
  answers_count int not null default 0
    constraint works_answers_count_positive check (answers_count >= 0),

  created_at timestamptz not null default now(),

  -- --- 表全体にかかる検査 -------------------------------------------------

  constraint works_division_valid check (
    division in ('original', 'fanart', 'ai')
  ),

  constraint works_review_status_valid check (
    review_status in ('ok', 'flagged', 'hidden')
  ),

  -- 条件1: ファンアートなら元作品名が必須
  constraint works_fanart_requires_source check (
    division <> 'fanart' or source_title is not null
  ),

  -- 条件2: ファンアート以外にファンアート情報が紛れ込まない
  --        （部門を後から変えられない設計は、この整合性を保つため）
  constraint works_non_fanart_has_no_source check (
    division = 'fanart'
    or (source_title is null and source_character is null and fanart_note is null)
  ),

  constraint works_deleted_after_created check (
    deleted_at is null or deleted_at >= created_at
  )
);

comment on table public.works is
  '投稿作品。anon / authenticated ともテーブル権限を与えない。'
  '取得は get_public_works / get_work_detail / get_my_works / get_my_work のみ（D23）。';
comment on column public.works.prompt_id is
  '【非公開列】どの取得経路でもクライアントへ返さない（D23）。';
comment on column public.works.actual_time_seconds is
  '実績時間の自己申告。時間別ランキングの分類には使わない（分類は prompts.time_limit_seconds）。';


-- マイページの作品一覧用。
create index works_user_created_idx
  on public.works (user_id, created_at desc);

-- 公開一覧用の部分索引。条件に合う行だけを持つので小さく速い。
create index works_public_idx
  on public.works (created_at desc)
  where is_published and review_status = 'ok' and deleted_at is null;

-- 部門別一覧用。
create index works_division_public_idx
  on public.works (division, created_at desc)
  where is_published and review_status = 'ok' and deleted_at is null;


-- ----------------------------------------------------------------------------
-- 2. answers ／ 回答1件
-- ----------------------------------------------------------------------------
--
-- 「誰がどの作品に答えて、何問正解したか」の1行。
-- 選んだタグそのものは持たない（それは answer_items 側）。

create table public.answers (

  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- 回答者。**匿名ゲストも回答できる**ので null 許容ではない…のではなく、
  -- ゲストが30日で掃除されたときに null になるため null 許容にする。
  --
  -- ON DELETE SET NULL:
  --   ゲストが消えても回答行は残す。作品側の集計を過去に遡って
  --   減らさないため（論点3-A）。
  user_id uuid
    references public.profiles (id) on delete set null on update restrict,

  -- 正解数。quiz_questions.position が 0〜9 なので最大10問。
  -- 「その作品の問題数以下であること」は別の表を見る必要があり
  -- 制約では書けない。submit_answer RPC が保証し、診断 A6/A7 で確認する。
  correct_count int not null
    constraint answers_correct_count_range check (correct_count between 0 and 10),

  created_at timestamptz not null default now(),

  -- 1作品につき1ユーザー1回。
  --
  -- 【注意】Postgres の UNIQUE は NULL 同士を重複と見なさない。
  --   ゲスト掃除で user_id が null になった行は、同じ作品に何行あっても
  --   この制約に引っかからない。これは許容する（論点3-A）。
  --   現役ユーザーの重複回答防止としては正しく働く。
  constraint answers_one_per_user_per_work unique (work_id, user_id)
);

comment on table public.answers is
  '回答1件。anon / authenticated ともテーブル権限を与えない。'
  '取得は get_my_answers / get_my_answer のみ（本人限定）。他人へは公開しない。';
comment on column public.answers.user_id is
  'ゲスト掃除で null になる。null 行も works.answers_count と '
  'work_slot_stats には含めるが、user_stats / user_slot_stats には含めない（論点3-A）。';


create index answers_work_idx
  on public.answers (work_id);

create index answers_user_created_idx
  on public.answers (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. answer_items ／ 回答の内訳【機密】
-- ----------------------------------------------------------------------------
--
-- 【この表がこの工程でいちばん危険】
--   selected_tag_id と is_correct を同じ行に持つため、
--   他人の行が1件でも読めると is_correct = true の行から
--   正解タグがそのまま判明する。
--
--   → 権限を与えず、ポリシーも作らない。本人の分も RPC 経由で返す。

create table public.answer_items (

  id bigint generated always as identity primary key,

  answer_id bigint not null
    references public.answers (id) on delete cascade on update restrict,

  -- どの問への回答か。
  --
  -- ON DELETE RESTRICT:
  --   quiz_questions はお題が消えると cascade で消える。
  --   ここを cascade にすると、お題の削除が回答の内訳まで
  --   静かに巻き込む。restrict なら削除が拒否されて気づける。
  --   作品のあるお題は works.prompt_id の restrict で既に守られているため、
  --   P4 の掃除（作品のないお題だけが対象）と衝突しない。
  question_id bigint not null
    references public.quiz_questions (id) on delete restrict on update restrict,

  -- どの枠の問だったか。spec の slot_key から改名し、他表と名前を統一した。
  -- 「その問の枠と一致していること」は診断 A9 で確認する。
  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  selected_tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- 【機密】正解だったか。
  is_correct boolean not null,

  created_at timestamptz not null default now(),

  -- 1つの問に2回答えられない
  constraint answer_items_one_per_question unique (answer_id, question_id)
);

comment on table public.answer_items is
  '回答の内訳【機密】。selected_tag_id と is_correct を併せ持つため、'
  '他人の行が読めると正解が判明する。権限もポリシーも与えない。';
comment on column public.answer_items.is_correct is
  '【機密】RPC の返り値に含めてよいのは本人の分だけ。';


create index answer_items_answer_idx
  on public.answer_items (answer_id);

create index answer_items_question_idx
  on public.answer_items (question_id);


-- ----------------------------------------------------------------------------
-- 4. work_slot_stats ／ 作品×枠の集計
-- ----------------------------------------------------------------------------
--
-- 「この作品のどの枠が伝わりにくかったか」を出すための集計。
-- 項目別正答率 = corrects / attempts。
-- 枠はモードによって変わるので works の列にはできず、別表に置く。
--
-- ゲスト掃除で user_id が null になった回答も **この表には含める**
-- （その作品に実際に挑戦された回数として正しいため。論点3-A）。

create table public.work_slot_stats (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  attempts int not null default 0
    constraint work_slot_stats_attempts_positive check (attempts >= 0),

  -- 正解数は挑戦数を超えない。
  corrects int not null default 0
    constraint work_slot_stats_corrects_range check (corrects between 0 and attempts),

  updated_at timestamptz not null default now(),

  constraint work_slot_stats_pkey primary key (work_id, card_slot_key)
);

comment on table public.work_slot_stats is
  '作品×枠の正答集計。直接公開すると作品IDの総当たりで'
  '非公開・削除済み作品の存在と回答件数が漏れるため、権限を与えない。'
  '取得は get_work_detail / get_my_work の返り値に含める。';


-- ----------------------------------------------------------------------------
-- 5. user_stats ／ 回答者の通算成績
-- ----------------------------------------------------------------------------
--
-- 「この人は何問答えて、どれくらい当てているか」。
-- profiles.show_answer_stats = true の人だけ、他人にも見える（D11）。
--
-- ゲスト掃除で user_id が null になった回答は **この表に反映しない**
-- （持ち主がいないので加算先がない。論点3-A）。
--
-- ON DELETE CASCADE:
--   成績は本人に付随する派生データ。本人が消えれば一緒に消える。
--   works の restrict とは扱いが違う（作品は他人が見るコンテンツ）。

create table public.user_stats (

  user_id uuid primary key
    references public.profiles (id) on delete cascade on update restrict,

  -- 回答した作品数
  total_answers int not null default 0
    constraint user_stats_total_answers_positive check (total_answers >= 0),

  -- 答えた問の総数
  total_items int not null default 0
    constraint user_stats_total_items_positive check (total_items >= 0),

  -- そのうち当たった数。総数を超えない。
  total_correct_items int not null default 0
    constraint user_stats_correct_range check (
      total_correct_items between 0 and total_items
    ),

  updated_at timestamptz not null default now()
);

comment on table public.user_stats is
  '回答者の通算成績。show_answer_stats = true の登録ユーザーの行は'
  'anon（未ログインの訪問者）からも読める。統計閲覧に匿名サインインは不要。';


-- ----------------------------------------------------------------------------
-- 6. user_slot_stats ／ 回答者×枠の成績
-- ----------------------------------------------------------------------------
--
-- 「自分はどの枠の推測が苦手か」。user_stats と同じ公開条件。

create table public.user_slot_stats (

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  card_slot_key text not null
    references public.card_slots (card_slot_key) on delete restrict on update restrict,

  attempts int not null default 0
    constraint user_slot_stats_attempts_positive check (attempts >= 0),

  corrects int not null default 0
    constraint user_slot_stats_corrects_range check (corrects between 0 and attempts),

  updated_at timestamptz not null default now(),

  constraint user_slot_stats_pkey primary key (user_id, card_slot_key)
);

comment on table public.user_slot_stats is
  '回答者×枠の成績。公開条件は user_stats と同じ。';


-- ----------------------------------------------------------------------------
-- 7. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- works / answers / answer_items / work_slot_stats
--   … RLS を有効にし、ポリシーを1つも作らない（完全遮断）
--
-- user_stats / user_slot_stats
--   … anon           : show_answer_stats = true の登録ユーザーの行だけ
--     authenticated  : 本人の行、または上記の行
--
-- 【RLS と権限は別物】
--   RLS が通っても権限が無ければ permission denied。
--   権限があっても RLS で外れれば 0 件（エラーにならない）。D31。

alter table public.works           enable row level security;
alter table public.answers         enable row level security;
alter table public.answer_items    enable row level security;
alter table public.work_slot_stats enable row level security;
alter table public.user_stats      enable row level security;
alter table public.user_slot_stats enable row level security;


-- --- 7-a. works / answers / answer_items / work_slot_stats ------------------
--
-- ポリシーを作らない。RLS が有効でポリシーが無い表は、
-- 所有者（postgres）以外から見ると常に「対象行なし」になる。
-- さらに権限も与えないため、実際には permission denied で止まる。


-- --- 7-b. user_stats --------------------------------------------------------
--
-- 【profiles を参照することについて】
--   ポリシーの中の select は「呼び出した人の権限」で実行される。
--   profiles には anon / authenticated 両方に SELECT 権限があり、
--   「登録済みかつ handle あり」の行は anon からも見えるため、
--   この参照は成立する（001_profiles.sql の profiles_select_public_or_self）。
--
--   is_anonymous = false を明示的に書いているのは、profiles 側の
--   ポリシーが将来変わっても、ここの意図が変わらないようにするため。
--
--   【既知の限界】handle が未設定の登録ユーザーは profiles 側の
--   ポリシーで見えないため、show_answer_stats = true でも
--   成績が公開されない。handle は登録時に必ず設定するので通常は起きない。

create policy user_stats_select_public
  on public.user_stats
  for select
  to anon
  using (
    exists (
      select 1
        from public.profiles p
       where p.id = user_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );

create policy user_stats_select_self_or_public
  on public.user_stats
  for select
  to authenticated
  using (
    (select auth.uid()) = user_stats.user_id
    or exists (
      select 1
        from public.profiles p
       where p.id = user_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );


-- --- 7-c. user_slot_stats ---------------------------------------------------

create policy user_slot_stats_select_public
  on public.user_slot_stats
  for select
  to anon
  using (
    exists (
      select 1
        from public.profiles p
       where p.id = user_slot_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );

create policy user_slot_stats_select_self_or_public
  on public.user_slot_stats
  for select
  to authenticated
  using (
    (select auth.uid()) = user_slot_stats.user_id
    or exists (
      select 1
        from public.profiles p
       where p.id = user_slot_stats.user_id
         and p.is_anonymous = false
         and p.show_answer_stats
    )
  );


-- ----------------------------------------------------------------------------
-- 8. 権限（どのロールが何をできるか）
-- ----------------------------------------------------------------------------
--
-- revoke all を先に流すのは、以前の実行で広い権限が付いていた場合に
-- 確実に消すため。新規作成なら何も起きない。

revoke all on public.works           from anon, authenticated;
revoke all on public.answers         from anon, authenticated;
revoke all on public.answer_items    from anon, authenticated;
revoke all on public.work_slot_stats from anon, authenticated;
revoke all on public.user_stats      from anon, authenticated;
revoke all on public.user_slot_stats from anon, authenticated;


-- works / answers / answer_items / work_slot_stats へは
-- **何も grant しない**。直接触ると permission denied になる。


-- user_stats / user_slot_stats は列を明示して SELECT を与える。
--
-- 【なぜ全列なのに列名を並べるか】
--   列名を書いておくと、将来 alter table で列を足したときに
--   その列は **自動では公開されない**。書き忘れによる漏洩を防げる。
--   その代わり select * は列が増えた時点で権限エラーになる（D30）。

grant select (
  user_id,
  total_answers,
  total_items,
  total_correct_items,
  updated_at
) on public.user_stats to anon, authenticated;

grant select (
  user_id,
  card_slot_key,
  attempts,
  corrects,
  updated_at
) on public.user_slot_stats to anon, authenticated;


-- INSERT / UPDATE / DELETE はどのロールにも与えない。
-- 集計3表へ書き込むのは Step 9 のトリガーだけ。




-- ============================================================================
-- Step 3E の必須診断（追加分 A6〜A9）
-- ============================================================================
--
-- DB の制約では表現できない不整合を検出する。
-- **すべて 0 行が返れば正常。1行でも返れば壊れたデータ。**
--
--
-- A6. correct_count が内訳の正解数と一致しない回答
-- select a.id, a.work_id, a.correct_count,
--        count(*) filter (where ai.is_correct) as actual_correct
--   from public.answers a
--   join public.answer_items ai on ai.answer_id = a.id
--  group by a.id, a.work_id, a.correct_count
-- having a.correct_count <> count(*) filter (where ai.is_correct);
--
--
-- A7. 内訳の件数が、その作品の問題数と一致しない回答
-- select a.id, a.work_id,
--        count(ai.id) as item_count,
--        (select count(*) from public.quiz_questions q
--          where q.prompt_id = w.prompt_id) as question_count
--   from public.answers a
--   join public.works w on w.id = a.work_id
--   left join public.answer_items ai on ai.answer_id = a.id
--  group by a.id, a.work_id, w.prompt_id
-- having count(ai.id) <> (select count(*) from public.quiz_questions q
--                          where q.prompt_id = w.prompt_id);
--
--
-- A8. works.answers_count が実件数と一致しない作品
-- select w.id, w.answers_count,
--        (select count(*) from public.answers a where a.work_id = w.id) as actual
--   from public.works w
--  where w.answers_count
--        <> (select count(*) from public.answers a where a.work_id = w.id);
--
--
-- A9. answer_items.card_slot_key が、その問の枠と一致しない
-- select ai.id, ai.card_slot_key as recorded, q.card_slot_key as expected
--   from public.answer_items ai
--   join public.quiz_questions q on q.id = ai.question_id
--  where ai.card_slot_key <> q.card_slot_key;
--
--
-- 【参考】3B-2b で用意した A5（status = 'submitted' なのに作品が無いお題）は
--         この工程で works ができたことにより実行可能になった。
-- select id, mode_key, submitted_at from public.prompts
--  where status = 'submitted'
--    and not exists (select 1 from public.works w where w.prompt_id = prompts.id);


-- ============================================================================
-- 確認用クエリ
-- ============================================================================
--
-- 別ファイルにまとめてある。SQL Editor へ一括で貼って実行する。
--   → supabase/migrations/005_works_answers_verify.sql
--
-- ============================================================================


-- ############################################################################
-- ### 006_likes_saves_reports.sql  ／  Step 3B-3b likes / saves / reports
-- ############################################################################

-- ============================================================================
-- 006_likes_saves_reports.sql  ／ Step 3B-3b: 反応・通報3表
-- ============================================================================
--
-- 【このファイルがやること】
--   1. likes（いいね）を作る
--   2. saves（保存）を作る
--   3. reports（通報）【機密】を作る
--   4. RLS と権限を設定する
--
--   これで **全21表がそろう**（12 + 6 + 3）。
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない（3表とも 0 行のまま）
--   ・likes_count / saves_count を同期するトリガーを作らない。
--     Step 11 の toggle_like / toggle_save と同時に作る（D38 と同じ方針）
--   ・いいね・保存・通報の処理（RPC）を作らない
--   ・既存18表に一切触れない
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query
--   → このファイルの中身を全部貼り付けて Run（⌘+Enter）
--
--   全体が begin / commit で囲まれているため、途中で1つでも失敗すると
--   **何も変更されずに巻き戻る**。
--
-- 【前提】
--   005_works_answers.sql まで実行済みであること（3表とも works を参照する）。
--
-- 【取り消し】
--   006_likes_saves_reports_rollback.sql を実行する。
--
--
-- 【権限の方針：3表とも完全遮断】
--
--   表        anon      authenticated
--   --------  --------  -------------
--   likes     権限なし  権限なし
--   saves     権限なし  権限なし
--   reports   権限なし  権限なし
--
--   RLS を有効にし、ポリシーは1つも作らない。直接触ると permission denied。
--
--   【なぜ本人にも直接読ませないか】
--     likes / saves は work_id しか持たない。作品名や画像を出すには
--     works が要るが、works には権限が無い（D23 / D35）。
--     結局 RPC を通すことになるため、経路を1本に統一する。
--
--     saves の公開（show_saved_works = true）も同じ理由で RPC 側で判定する。
--     ポリシーで公開条件を書くと、work_slot_stats と同じ問題
--     （非公開・削除済み作品の存在が漏れる）が起きる（D36）。
--
--   【取得経路】
--     toggle_like(work_id) / toggle_save(work_id)   … 押す・外す
--     get_my_likes() / get_my_saves()               … 本人の一覧
--     get_public_saves(user_id)                     … show_saved_works = true のみ
--     get_work_detail / get_my_work                 … liked_by_me / saved_by_me を含む
--     create_report(work_id, reason, detail)        … 匿名も可
--
--   公開するいいね数は works.likes_count（キャッシュ。D24）だけ。
--   「誰がいいねしたか」は見せない（D26）。
--
--
-- 【DB では防げないこと（RPC が保証する）】
--
--   ・いいね・保存は **正式登録ユーザーのみ**（D7）。
--     匿名かどうかは profiles を見ないと分からず、CHECK では書けない。
--     toggle_like / toggle_save が JWT の is_anonymous を検査する。
--     壊れていないかは Step 3E の診断 A10 で確認する。
--   ・works.likes_count / saves_count とこの表の実件数の一致（診断 A11）。
--
-- ============================================================================




-- ----------------------------------------------------------------------------
-- 1. likes ／ いいね
-- ----------------------------------------------------------------------------
--
-- 正本はこの表の行。works.likes_count はトリガーで同期するキャッシュ（D24）。
-- ずれた場合はこの表を数え直せば復旧できる。
--
-- **正式登録ユーザーのみ**（D7）。匿名はブラウザデータを消せば作り直せるため、
-- いいねの水増しが容易で人気ランキングの信頼性が落ちる。

create table public.likes (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- ON DELETE CASCADE:
  --   いいねは本人の行動記録。本人が消えれば一緒に消える。
  --   （作品は他人が見るコンテンツなので works.user_id は RESTRICT。扱いが違う）
  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  -- 同じ作品に2回いいねできない
  constraint likes_pkey primary key (work_id, user_id)
);

comment on table public.likes is
  'いいね。正式登録ユーザーのみ（D7）。anon / authenticated とも権限なし。'
  '公開するのは works.likes_count だけで、誰が押したかは見せない（D26）。';


-- 「いいねした作品一覧」用
create index likes_user_created_idx
  on public.likes (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 2. saves ／ 保存（ブックマーク）
-- ----------------------------------------------------------------------------
--
-- likes とほぼ同じ形。違いは公開設定を持つこと
-- （profiles.show_saved_works = true なら他人にも見せられる）。
-- ただし公開判定は RPC 側で行い、この表自体は誰にも読ませない。

create table public.saves (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  constraint saves_pkey primary key (work_id, user_id)
);

comment on table public.saves is
  '保存。正式登録ユーザーのみ。公開判定（show_saved_works）は RPC 側で行う。';


create index saves_user_created_idx
  on public.saves (user_id, created_at desc);


-- ----------------------------------------------------------------------------
-- 3. reports ／ 通報【機密】
-- ----------------------------------------------------------------------------
--
-- 誰が何を通報したかは、通報者にも被通報者にも見せない。
-- 見るのは運営だけ（管理経路は Step 15）。
--
-- **匿名ユーザーも通報できる**（D7 では投稿系だけを登録必須にした。
-- 通報は権利侵害の申告経路なので、登録を必須にすると通報されにくくなる）。

create table public.reports (

  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- ON DELETE SET NULL:
  --   ゲストが30日で掃除されても通報自体は残す。
  --   通報内容は運営の判断材料であり、通報者が消えても価値が残る。
  reporter_id uuid
    references public.profiles (id) on delete set null on update restrict,

  reason text not null,

  -- 補足。reason = 'other' のときは必須（下の CHECK）。
  detail text
    constraint reports_detail_length check (
      detail is null or char_length(detail) between 1 and 1000
    ),

  status text not null default 'open',

  created_at timestamptz not null default now(),

  -- 処理し終えた日時。status と対で埋まる。
  resolved_at timestamptz,

  -- --- 表全体にかかる検査 -------------------------------------------------

  constraint reports_reason_valid check (
    reason in ('copyright', 'inappropriate', 'spam', 'ai_undeclared', 'other')
  ),

  constraint reports_status_valid check (
    status in ('open', 'reviewing', 'resolved', 'rejected')
  ),

  -- 「その他」を選んだなら、何が問題なのかを書いてもらう
  constraint reports_other_requires_detail check (
    reason <> 'other' or detail is not null
  ),

  -- 処理済みなら日時が入り、未処理なら入っていない
  constraint reports_resolved_pair check (
    (status in ('open', 'reviewing') and resolved_at is null)
    or
    (status in ('resolved', 'rejected') and resolved_at is not null)
  ),

  constraint reports_resolved_after_created check (
    resolved_at is null or resolved_at >= created_at
  ),

  -- 同じ人が同じ作品を何度も通報できない。
  --
  -- 【注意】answers と同じく、reporter_id が null になった行には効かない。
  --   ゲスト掃除後に同一作品への null 通報が複数残ることは許容する。
  constraint reports_one_per_reporter_per_work unique (work_id, reporter_id)
);

comment on table public.reports is
  '通報【機密】。誰が何を通報したかは当事者にも見せない。運営のみが RPC で扱う。';


-- 運営が未処理を拾うため
create index reports_status_created_idx
  on public.reports (status, created_at);

-- 作品単位の通報件数を見るため
create index reports_work_idx
  on public.reports (work_id);


-- ----------------------------------------------------------------------------
-- 4. RLS（行の絞り込み）
-- ----------------------------------------------------------------------------
--
-- 3表ともポリシーを1つも作らない。
-- RLS が有効でポリシーが無い表は、所有者以外から見ると常に「対象行なし」。
-- さらに権限も与えないため、実際には permission denied で止まる（D31）。

alter table public.likes   enable row level security;
alter table public.saves   enable row level security;
alter table public.reports enable row level security;


-- ----------------------------------------------------------------------------
-- 5. 権限
-- ----------------------------------------------------------------------------
--
-- revoke all を先に流すのは、以前の実行で広い権限が付いていた場合に
-- 確実に消すため。新規作成なら何も起きない。

revoke all on public.likes   from anon, authenticated;
revoke all on public.saves   from anon, authenticated;
revoke all on public.reports from anon, authenticated;

-- grant は1つも書かない。すべて RPC 経由。




-- ============================================================================
-- Step 3E の必須診断（追加分 A10・A11）
-- ============================================================================
--
-- **すべて 0 行が返れば正常。1行でも返れば壊れたデータ。**
--
--
-- A10. いいね・保存の持ち主が匿名ユーザー（登録必須のはず。D7）
-- select 'likes' as t, l.work_id, l.user_id
--   from public.likes l
--   join public.profiles p on p.id = l.user_id
--  where p.is_anonymous
-- union all
-- select 'saves', s.work_id, s.user_id
--   from public.saves s
--   join public.profiles p on p.id = s.user_id
--  where p.is_anonymous;
--
--
-- A11. works のカウンタが実件数と一致しない作品
-- select w.id,
--        w.likes_count,
--        (select count(*) from public.likes l where l.work_id = w.id) as actual_likes,
--        w.saves_count,
--        (select count(*) from public.saves s where s.work_id = w.id) as actual_saves
--   from public.works w
--  where w.likes_count <> (select count(*) from public.likes l where l.work_id = w.id)
--     or w.saves_count <> (select count(*) from public.saves s where s.work_id = w.id);


-- ============================================================================
-- 確認用クエリ
-- ============================================================================
--
-- supabase/migrations/006_likes_saves_reports_verify.sql を使う。
--
-- ============================================================================


-- ############################################################################
-- ### 007_read_rpcs.sql  ／  Step 3C   取得系RPC 13本
-- ############################################################################

-- ============================================================================
-- 007_read_rpcs.sql  ／ Step 3C: 取得系RPC（公開取得経路の実装）
-- ============================================================================
--
-- 【このファイルがやること】
--   遮断11表からデータを取り出す **唯一の入口** を13本の関数として作る。
--   これで「テーブルは誰も読めないが、必要な情報は取れる」状態が完成する。
--
-- 【このファイルがやらないこと】
--   ・データを1行も入れない・消さない・変更しない
--   ・書き込み系RPC（start_draft / complete_draft / create_work /
--     submit_answer / toggle_like など）を作らない。
--     それぞれの機能Stepで実装する（spec §9-2 の方針）
--   ・テーブル・列・制約・権限を一切変更しない
--
-- 【実行方法】
--   Supabase ダッシュボード → SQL Editor → New query → 全部貼って Run
--   全体が begin / commit で囲まれているため、途中で失敗すれば何も残らない。
--
-- 【前提】
--   006_likes_saves_reports.sql まで実行済み（全21表）。
--   tags は0行のままでよい（3D で投入）。関数の作成には影響しない。
--
-- 【取り消し】
--   007_read_rpcs_rollback.sql を実行する。
--
--
-- 【security definer とは何か・なぜ必要か】
--
--   通常、関数は「呼び出した人の権限」で動く。それだと works に権限が無い以上、
--   関数の中からも works を読めない。
--
--   security definer を付けると「関数を作った人（postgres）の権限」で動く。
--   だから遮断表を読める。**その代わり、誰に何を返すかの判断は
--   すべて関数の中に書く必要がある。** RLS は効かないため。
--
--   このファイルの13本は次の3つを必ず守る。
--
--     1. set search_path = ''
--        検索パスを空にし、すべての表を public.xxx と完全に書く。
--        これをしないと、悪意ある利用者が自分のスキーマに同名の偽テーブルを
--        作って関数に読ませることができてしまう。
--
--     2. 返す列を1つずつ書く（select * を使わない）
--        後から列を足したときに、勝手に外へ出ないようにする。
--
--     3. revoke all ... from public のあと、必要なロールにだけ grant execute
--        Postgres は新しい関数の実行権限を自動的に PUBLIC へ与えるため、
--        明示的に取り消さないと誰でも呼べる。
--
--
-- 【絶対に外へ出さないもの】
--
--   works.prompt_id      … 作品からお題へ辿る足がかり（D23）
--   quiz_choices.is_correct … クイズの正解そのもの
--   prompt_cards の中身  … お題の答え。本人の get_my_prompt でだけ返す
--   tags.weight          … 出やすさ。正解の推測材料になる（D21）
--   answer_items の他人分 … selected_tag_id と is_correct の組から正解が判明する
--
--
-- 【13本の一覧】
--
--   ■ 誰でも（anon + authenticated）
--     get_public_works(division, sort, limit, offset)  作品一覧
--     get_work_detail(work_id)                         作品1件の詳細
--     get_work_quiz(work_id)                           クイズの問題文と選択肢
--     get_public_saves(user_id, limit, offset)         公開設定ONの人の保存一覧
--
--   ■ 本人のみ（authenticated）※ 他人のIDを渡しても0件／null が返る
--     get_my_works(limit, offset)        自分の作品一覧（非公開・削除済みも）
--     get_my_work(work_id)               自分の作品1件（編集画面用）
--     get_my_prompts(limit, offset)      自分が引いたお題の一覧
--     get_my_prompt(prompt_id)           お題1件。答えのカード＋開示済みなら未選択も
--     get_my_answers(limit, offset)      自分の回答履歴
--     get_my_answer(work_id)             自分の回答1件。選択・正誤・正解を含む
--     get_my_likes(limit, offset)        いいねした作品
--     get_my_saves(limit, offset)        保存した作品
--     get_my_reaction(work_id)           その作品にいいね／保存したか、回答済みか
--
--
-- 【本人確認のやりかた：エラーにせず空を返す】
--
--   他人のお題IDを get_my_prompt に渡した場合、エラーではなく **null** を返す。
--   「権限がありません」と返すと、そのIDが存在することを教えてしまうため。
--   存在しないIDと他人のIDの区別がつかない状態にする。
--
-- ============================================================================




-- ----------------------------------------------------------------------------
-- 1. get_public_works ／ 公開作品の一覧
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる。返すのは次を **すべて** 満たす作品だけ。
--   is_published = true / review_status = 'ok' / deleted_at is null
--
-- p_sort: 'new'（新着）/ 'likes'（いいね順）/ 'answers'（回答数順）
-- p_division: null なら全部門、'original' / 'fanart' / 'ai' で絞り込み
-- p_limit: 1〜50 に丸める（大量取得によるDB負荷と、全件収集を防ぐ）

create function public.get_public_works(
  p_division text default null,
  p_sort     text default 'new',
  p_limit    int  default 24,
  p_offset   int  default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,   -- お題の制限時間。時間別ランキングの分類基準（D25）
    p.mode_key,
    p.was_rerolled,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and (p_division is null or w.division = p_division)
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int) is
  '公開作品の一覧。prompt_id は返さない（D23）。';


-- ----------------------------------------------------------------------------
-- 2. get_work_detail ／ 作品1件の詳細
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる。公開条件を満たさない作品には null を返す
-- （「非公開です」と返すと、その作品の存在を教えてしまうため）。
--
-- 伝達率（枠別の正答率）もここに含める。work_slot_stats を直接公開すると
-- 作品IDの総当たりで非公開作品の存在が漏れるため（D36）。

create function public.get_work_detail(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'was_rerolled',        p.was_rerolled,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'author', jsonb_build_object(
      'id',           pr.id,
      'handle',       pr.handle,
      'display_name', pr.display_name,
      'bio',          pr.bio,
      'links',        pr.links
    ),
    -- 呼び出した人自身の状態。ゲスト（auth.uid() が null）は全部 false。
    'is_author',   (select auth.uid()) = w.user_id,
    'liked_by_me', exists (
      select 1 from public.likes l
       where l.work_id = w.id and l.user_id = (select auth.uid())
    ),
    'saved_by_me', exists (
      select 1 from public.saves s
       where s.work_id = w.id and s.user_id = (select auth.uid())
    ),
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    -- 枠別の伝達率。回答が無ければ空配列。
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_detail(uuid) is
  '公開作品1件の詳細。prompt_id は返さない。非公開・削除済みには null を返す。';


-- ----------------------------------------------------------------------------
-- 3. get_work_quiz ／ クイズの問題と選択肢
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べる（ゲストも回答できるため）。
--
-- 【この関数がいちばん危険】
--   quiz_choices から取り出すのは tag_id / label / position の3つだけ。
--   **is_correct は1文字も触れない。**
--   選択肢は保存されている position の順に返す。並びをここで変えないのは、
--   毎回シャッフルすると「毎回位置が変わる選択肢が正解」といった
--   別の手がかりを与えかねないため。position の混ぜ方は
--   complete_draft（Step 5）が確定時に1度だけ行う。

create function public.get_work_quiz(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id',       w.id,
    'mode_key',      p.mode_key,
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    -- 作者本人は自作に回答できない（D28）。画面側で入力を出さないための印。
    'is_author', (select auth.uid()) = w.user_id,
    'questions', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',     q.id,
                 'position',        q.position,
                 'card_slot_key',   q.card_slot_key,
                 'card_slot_label', cs.label,
                 'choices', coalesce((
                   select jsonb_agg(
                            jsonb_build_object(
                              'tag_id',   ch.tag_id,
                              'label',    tg.label,
                              'position', ch.position
                            )
                            order by ch.position
                          )
                     from public.quiz_choices ch
                     join public.tags tg on tg.id = ch.tag_id
                    where ch.question_id = q.id
                 ), '[]'::jsonb)
               )
               order by q.position
             )
        from public.quiz_questions q
        join public.card_slots cs on cs.card_slot_key = q.card_slot_key
       where q.prompt_id = w.prompt_id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_quiz(uuid) is
  'クイズの問題と選択肢。is_correct を一切参照しない。正解は submit_answer が返す。';


-- ----------------------------------------------------------------------------
-- 4. get_public_saves ／ 公開設定がONの人の保存一覧
-- ----------------------------------------------------------------------------
--
-- 誰でも呼べるが、profiles.show_saved_works = true の登録ユーザーの分だけ返す。
-- 保存された作品自体も公開条件を満たすものだけに絞る。

create function public.get_public_saves(
  p_user_id uuid,
  p_limit   int default 24,
  p_offset  int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  saved_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    sv.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.saves sv
  join public.works    w  on w.id  = sv.work_id
  join public.profiles pr on pr.id = w.user_id
  where sv.user_id = p_user_id
    -- 保存した本人が公開を許可していること
    and exists (
      select 1 from public.profiles sv_owner
       where sv_owner.id = p_user_id
         and sv_owner.is_anonymous = false
         and sv_owner.show_saved_works
    )
    -- 保存された作品自体が公開されていること
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by sv.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_saves(uuid, int, int) is
  '公開設定がONの人の保存一覧。設定がOFFなら0件（エラーにしない）。';


-- ----------------------------------------------------------------------------
-- 5. get_my_works ／ 自分の作品一覧
-- ----------------------------------------------------------------------------
--
-- 非公開・審査中・論理削除済みも含めて全部返す。
-- ゲスト（auth.uid() が null）が呼ぶと0件。

create function public.get_my_works(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  is_published        boolean,
  review_status       text,
  deleted_at          timestamptz,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,
    p.mode_key,
    w.is_published,
    w.review_status,
    w.deleted_at,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.user_id = (select auth.uid())
  order by w.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_works(int, int) is
  '自分の作品一覧。非公開・審査中・削除済みも含む。prompt_id は返さない。';


-- ----------------------------------------------------------------------------
-- 6. get_my_work ／ 自分の作品1件（編集画面用）
-- ----------------------------------------------------------------------------
--
-- 他人の作品IDを渡すと null。存在しないIDと区別がつかない。

create function public.get_my_work(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'is_published',        w.is_published,
    'review_status',       w.review_status,
    'deleted_at',          w.deleted_at,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    -- actual_time_seconds を変更できるのは公開前だけ（D25）。
    -- 画面で入力欄を出すかどうかの判断に使う。
    'can_edit_actual_time', (w.is_published = false),
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.user_id = (select auth.uid());
$$;

comment on function public.get_my_work(uuid) is
  '自分の作品1件。他人のIDには null を返す（存在の有無を漏らさない）。';


-- ----------------------------------------------------------------------------
-- 7. get_my_prompts ／ 自分が引いたお題の一覧
-- ----------------------------------------------------------------------------
--
-- 一覧では答えのカードを返さない（画面に並べる必要が無いため）。
-- 中身は get_my_prompt で1件ずつ取る。

create function public.get_my_prompts(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  id                     uuid,
  mode_key               text,
  mode_label             text,
  time_limit_seconds     int,
  was_rerolled           boolean,
  reroll_count           int,
  status                 text,
  candidates_revealed_at timestamptz,
  created_at             timestamptz,
  work_id                uuid,
  work_title             text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.mode_key,
    dm.label,
    p.time_limit_seconds,
    p.was_rerolled,
    p.reroll_count,
    p.status,
    p.candidates_revealed_at,
    p.created_at,
    w.id,
    w.title
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  left join public.works w   on w.prompt_id = p.id
  where p.created_by = (select auth.uid())
  order by p.created_at desc, p.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_prompts(int, int) is
  '自分が引いたお題の一覧。答えのカードは含めない。';


-- ----------------------------------------------------------------------------
-- 8. get_my_prompt ／ お題1件（答えのカードを含む）
-- ----------------------------------------------------------------------------
--
-- **prompt_cards の中身を外へ出す唯一の場所。** 作成者本人にのみ返す。
--
-- 未選択カード（draft_candidates）は
-- candidates_revealed_at が入っているときだけ返す（§9-4 の開示制御）。
-- まだ開示していない場合は空配列を返す。

create function public.get_my_prompt(p_prompt_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                     p.id,
    'mode_key',               p.mode_key,
    'mode_label',             dm.label,
    'time_limit_seconds',     p.time_limit_seconds,
    'was_rerolled',           p.was_rerolled,
    'reroll_count',           p.reroll_count,
    'status',                 p.status,
    'candidates_revealed_at', p.candidates_revealed_at,
    'reveal_reason',          p.reveal_reason,
    'created_at',             p.created_at,
    'work_id', (select w.id from public.works w where w.prompt_id = p.id),

    -- 確定カード＝お題の答え
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'pool_key',        tg.pool_key
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
       where pc.prompt_id = p.id
    ), '[]'::jsonb),

    -- 引かなかったカード。開示済みのときだけ。
    'unchosen', case
      when p.candidates_revealed_at is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'card_slot_key',   dc.card_slot_key,
                   'card_slot_label', cs.label,
                   'slot_order',      dc.slot_order,
                   'candidate_index', dc.candidate_index,
                   'tag_id',          dc.tag_id,
                   'tag_label',       tg.label
                 )
                 order by dc.slot_order, dc.candidate_index
               )
          from public.draft_candidates dc
          join public.draft_sessions ds on ds.id = dc.session_id
          join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
          join public.tags       tg on tg.id            = dc.tag_id
         where ds.id = p.draft_session_id
           and dc.generation = ds.current_generation   -- 最終世代だけ
           and dc.is_chosen = false
      ), '[]'::jsonb)
    end
  )
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  where p.id = p_prompt_id
    and p.created_by = (select auth.uid());
$$;

comment on function public.get_my_prompt(uuid) is
  'お題1件。prompt_cards を外へ出す唯一の経路。作成者本人にのみ返す。'
  '未選択カードは candidates_revealed_at が入っているときだけ返す。';


-- ----------------------------------------------------------------------------
-- 9. get_my_answers ／ 自分の回答履歴
-- ----------------------------------------------------------------------------
--
-- 他人へは公開しない（D35）。選んだタグは含めず、正答数までにする
-- （一覧に選択内容を並べる必要が無いため。中身は get_my_answer で取る）。

create function public.get_my_answers(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  work_title          text,
  image_path          text,
  correct_count       int,
  item_count          bigint,
  answered_at         timestamptz,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    a.correct_count,
    (select count(*) from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.handle,
    pr.display_name
  from public.answers a
  join public.works    w  on w.id  = a.work_id
  join public.profiles pr on pr.id = w.user_id
  where a.user_id = (select auth.uid())
  order by a.created_at desc, a.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_answers(int, int) is
  '自分の回答履歴。他人へは公開しない（D35）。選んだタグは含めない。';


-- ----------------------------------------------------------------------------
-- 10. get_my_answer ／ 自分の回答1件（結果画面用）
-- ----------------------------------------------------------------------------
--
-- **正解タグを返す唯一の場所（回答者向け）。**
-- 自分が回答済みの作品についてのみ返す。未回答なら null。
--
-- 「正解を見るには回答が必要」という前提が、ここで強制される。
-- answers に自分の行が無ければ結合が成立せず、何も返らない。

create function public.get_my_answer(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id',       w.id,
    'work_title',    w.title,
    'correct_count', a.correct_count,
    'answered_at',   a.created_at,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',       ai.question_id,
                 'card_slot_key',     ai.card_slot_key,
                 'card_slot_label',   cs.label,
                 'selected_tag_id',   ai.selected_tag_id,
                 'selected_label',    sel.label,
                 'is_correct',        ai.is_correct,
                 -- 正解のタグ。回答済みなので見せてよい。
                 'correct_tag_id',    pc.tag_id,
                 'correct_label',     cor.label
               )
               order by q.position
             )
        from public.answer_items ai
        join public.quiz_questions q  on q.id = ai.question_id
        join public.card_slots    cs  on cs.card_slot_key = ai.card_slot_key
        join public.tags          sel on sel.id = ai.selected_tag_id
        join public.prompt_cards  pc  on pc.prompt_id = q.prompt_id
                                     and pc.card_slot_key = q.card_slot_key
        join public.tags          cor on cor.id = pc.tag_id
       where ai.answer_id = a.id
    ), '[]'::jsonb)
  )
  from public.answers a
  join public.works w on w.id = a.work_id
  where a.work_id = p_work_id
    and a.user_id = (select auth.uid());
$$;

comment on function public.get_my_answer(uuid) is
  '自分の回答1件。回答済みの作品にだけ正解タグを返す。未回答なら null。';


-- ----------------------------------------------------------------------------
-- 11. get_my_likes ／ いいねした作品
-- ----------------------------------------------------------------------------
--
-- 相手の作品が後から非公開・削除になった場合も一覧から外す。

create function public.get_my_likes(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  liked_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    l.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.likes l
  join public.works    w  on w.id  = l.work_id
  join public.profiles pr on pr.id = w.user_id
  where l.user_id = (select auth.uid())
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by l.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_likes(int, int) is
  'いいねした作品。非公開・削除済みになった作品は除く。';


-- ----------------------------------------------------------------------------
-- 12. get_my_saves ／ 保存した作品
-- ----------------------------------------------------------------------------

create function public.get_my_saves(
  p_limit  int default 24,
  p_offset int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  likes_count         int,
  saved_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.likes_count,
    s.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.saves s
  join public.works    w  on w.id  = s.work_id
  join public.profiles pr on pr.id = w.user_id
  where s.user_id = (select auth.uid())
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by s.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_my_saves(int, int) is
  '保存した作品。非公開・削除済みになった作品は除く。';


-- ----------------------------------------------------------------------------
-- 13. get_my_reaction ／ その作品への自分の状態
-- ----------------------------------------------------------------------------
--
-- いいね／保存ボタンの見た目を決めるための軽い問い合わせ。
-- get_work_detail にも同じ情報は入っているが、ボタンを押した直後の
-- 再取得で作品全体を取り直さずに済むように分けてある。
-- 作品の公開状態は見ない（自分の状態を返すだけなので漏れる情報が無い）。

create function public.get_my_reaction(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'work_id', p_work_id,
    'liked',   exists (select 1 from public.likes l
                        where l.work_id = p_work_id
                          and l.user_id = (select auth.uid())),
    'saved',   exists (select 1 from public.saves s
                        where s.work_id = p_work_id
                          and s.user_id = (select auth.uid())),
    'answered', exists (select 1 from public.answers a
                        where a.work_id = p_work_id
                          and a.user_id = (select auth.uid()))
  )
  where (select auth.uid()) is not null;
$$;

comment on function public.get_my_reaction(uuid) is
  'その作品に対する自分のいいね／保存／回答済みの状態。ゲストには null。';


-- ----------------------------------------------------------------------------
-- 14. 実行権限
-- ----------------------------------------------------------------------------
--
-- 【重要】Postgres は新しい関数の EXECUTE を自動的に PUBLIC へ与える。
--   revoke しないと、意図しないロール（将来増えるロールも含む）から呼べる。
--   まず全員から取り消し、必要なロールにだけ与え直す。

-- --- 誰でも呼べる4本 -------------------------------------------------------

revoke all on function public.get_public_works(text, text, int, int)
  from public, anon, authenticated;
revoke all on function public.get_work_detail(uuid)
  from public, anon, authenticated;
revoke all on function public.get_work_quiz(uuid)
  from public, anon, authenticated;
revoke all on function public.get_public_saves(uuid, int, int)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int)
  to anon, authenticated;
grant execute on function public.get_work_detail(uuid)
  to anon, authenticated;
grant execute on function public.get_work_quiz(uuid)
  to anon, authenticated;
grant execute on function public.get_public_saves(uuid, int, int)
  to anon, authenticated;


-- --- 本人だけの9本 ---------------------------------------------------------
--
-- anon（未ログイン）には与えない。呼ぶ意味が無く、
-- 与えないほうが「誰が呼べるか」を読み違えにくいため。

revoke all on function public.get_my_works(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_work(uuid)          from public, anon, authenticated;
revoke all on function public.get_my_prompts(int, int)   from public, anon, authenticated;
revoke all on function public.get_my_prompt(uuid)        from public, anon, authenticated;
revoke all on function public.get_my_answers(int, int)   from public, anon, authenticated;
revoke all on function public.get_my_answer(uuid)        from public, anon, authenticated;
revoke all on function public.get_my_likes(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_saves(int, int)     from public, anon, authenticated;
revoke all on function public.get_my_reaction(uuid)      from public, anon, authenticated;

grant execute on function public.get_my_works(int, int)   to authenticated;
grant execute on function public.get_my_work(uuid)        to authenticated;
grant execute on function public.get_my_prompts(int, int) to authenticated;
grant execute on function public.get_my_prompt(uuid)      to authenticated;
grant execute on function public.get_my_answers(int, int) to authenticated;
grant execute on function public.get_my_answer(uuid)      to authenticated;
grant execute on function public.get_my_likes(int, int)   to authenticated;
grant execute on function public.get_my_saves(int, int)   to authenticated;
grant execute on function public.get_my_reaction(uuid)    to authenticated;




-- ============================================================================
-- Step 3E の必須診断（追加分 A12）
-- ============================================================================
--
-- A12. security definer なのに search_path が固定されていない関数
--      → 0 行が返れば正常。1行でも返れば、その関数は偽テーブルを
--        読まされる危険がある。
--
-- select p.proname
--   from pg_proc p
--   join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.prosecdef
--    and not exists (
--      select 1 from unnest(coalesce(p.proconfig, '{}')) c
--       where c like 'search_path=%'
--    );
