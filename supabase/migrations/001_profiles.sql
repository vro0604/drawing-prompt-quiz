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
