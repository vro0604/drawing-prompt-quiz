-- ============================================================================
-- account_deletion_and_terms ／ 退会・匿名化・規約同意（P1 / P2 / P3）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. profiles に退会の状態を持たせる
--   2. works の持ち主を外せるようにする（nullable ＋ on delete set null）
--   3. 表を7つ足す（鍵・handle予約・掃除待ち・退会待ち・規約2種・同意）
--   4. 退会処理中の利用者の書き込みを、RPC を問わず止める
--   5. 規約に未同意なら作品を作れなくする
--   6. RPC を4本足す
--
-- 【このファイルがやらないこと】
--   ・**auth.users を削除しない。**それはサーバー側の Admin API が行う（指定10）
--   ・作品の行・他人の回答・通報記録を物理削除しない
--   ・既存の作品・回答・お題を1行も書き換えない
--   ・既存の RPC を書き換えない（守りはトリガーで足す。理由は下記）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/020_account_deletion_and_terms_rollback.sql
--
--
-- ============================================================================
-- なぜ守りを RPC ではなくトリガーに置くか
-- ============================================================================
--
--   「退会処理中は全部の書き込みを止める」を RPC 側で実現するには、
--   利用者が呼べる35本すべてに1行ずつ足すことになる。35本を書き写せば
--   写し間違いが混ざり、**混ざったことに気づけない**。
--
--   書き込みは必ずどれかの表に着地する。**着地点に置けば8か所で済む。**
--   しかも、あとで RPC を足したときにも自動で効く。
--   守りは「通り道」ではなく「行き先」に置く。
--
--   読み取りを止めていないのは、**止める対象が残っていない**から。
--   退会の第1段階で本人のデータは消えるか持ち主が外れるので、
--   get_my_* は同じ取引の中で空を返すようになる。
--
--
-- ============================================================================
-- なぜ profiles を消して works を残せるようにするか
-- ============================================================================
--
--   いまの works.user_id は not null ＋ on delete restrict なので、
--   作品を持つ人は auth.users を消せない。
--
--   ここで作品を物理削除すると、**その作品に答えた他人の回答と集計まで
--   cascade で消える**（answers.work_id は on delete cascade）。
--   退会した人の都合で、他人の記録を壊すことになる。
--
--   そこで持ち主だけを外せるようにする。作品の行は残り、他人の回答も
--   work_slot_stats も無傷のまま、作者に戻る線だけが切れる。
--
--   持ち主が外れた作品が公開され続けないよう、
--   **「持ち主がいない作品は必ず削除済み」**を制約で固定する。
--
-- ============================================================================




-- ============================================================================
-- 1. profiles ／ 退会の状態
-- ============================================================================

alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists deletion_requested_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_account_status_valid;

alter table public.profiles
  add constraint profiles_account_status_valid
    check (account_status in ('active', 'deletion_pending'));

comment on column public.profiles.account_status is
  'active / deletion_pending。deletion_pending の間は書き込みを一切通さない。'
  '本人は直接更新できない（列権限を与えない。経路は start_account_deletion だけ）。';

-- 本人に書き換えられると、退会処理中でも投稿できてしまう。
revoke update (account_status)        on public.profiles from public, anon, authenticated;
revoke update (deletion_requested_at) on public.profiles from public, anon, authenticated;




-- ============================================================================
-- 2. works ／ 持ち主を外せるようにする
-- ============================================================================

alter table public.works alter column user_id      drop not null;
alter table public.works alter column title        drop not null;
alter table public.works alter column image_path   drop not null;
alter table public.works alter column image_width  drop not null;
alter table public.works alter column image_height drop not null;

-- 外部キーの名前は付けずに作ったので既定名になっているはずだが、
-- 名前を決め打ちにすると環境差で落ちる。列と参照先から探して張り替える。
do $$
declare v_name text;
begin
  select con.conname into v_name
    from pg_constraint con
    join pg_class     c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'works'
     and con.contype = 'f'
     and con.conkey = array[(select attnum from pg_attribute
                              where attrelid = c.oid and attname = 'user_id')];

  if v_name is not null then
    execute format('alter table public.works drop constraint %I', v_name);
  end if;
end $$;

alter table public.works
  add constraint works_user_id_fkey
    foreign key (user_id) references public.profiles (id)
    on delete set null on update restrict;

-- 持ち主がいない作品が公開されていない、を構造で固定する。
-- 退会で user_id を外すときは必ず deleted_at も立てるので、これで両立する。
alter table public.works drop constraint if exists works_owner_or_deleted;
alter table public.works
  add constraint works_owner_or_deleted
    check (user_id is not null or deleted_at is not null);

-- ファンアートは作品名が必須だったが、退会時に消せなくなる。
-- 削除済みのときだけ緩める（公開中の作品では今までどおり必須）。
alter table public.works drop constraint if exists works_fanart_requires_source;
alter table public.works
  add constraint works_fanart_requires_source
    check (deleted_at is not null or division <> 'fanart' or source_title is not null);

comment on column public.works.user_id is
  '作者。退会すると null になる（作品の行と他人の回答は残す）。'
  'null の行は必ず deleted_at が入っている（works_owner_or_deleted）。';




-- ============================================================================
-- 3. 新しい表（7つ。すべて遮断する）
-- ============================================================================
--
-- 遮断＝権限もポリシーも与えない。読み書きは security definer の RPC と
-- service_role だけ。新しい表には Supabase が既定で権限を配るので、
-- 1表ごとに revoke を書く（D65）。


-- --- 3-a. app_secrets ／ 鍵置き場 ---------------------------------------------
--
-- handle のハッシュに使う鍵。**migration の本文に鍵を書かない。**
-- 書けば Git に残り、鍵付きハッシュにする意味が無くなる。
-- ここで乱数から作り、DB の中だけに置く。

create table if not exists public.app_secrets (
  key_name   text primary key,
  secret     bytea not null,
  created_at timestamptz not null default now()
);

alter table public.app_secrets enable row level security;
revoke all on public.app_secrets from public, anon, authenticated;

comment on table public.app_secrets is
  '鍵置き場。遮断表。値は migration に書かず、DB の中で作る。';

-- gen_random_uuid を2つ繋いで32バイト。pgcrypto に依存しない。
insert into public.app_secrets (key_name, secret)
select 'handle_hash_key',
       decode(replace(gen_random_uuid()::text, '-', '')
           || replace(gen_random_uuid()::text, '-', ''), 'hex')
 where not exists (select 1 from public.app_secrets s where s.key_name = 'handle_hash_key');


-- --- 3-b. handle_reservations ／ 退会した人の ID を押さえておく ----------------
--
-- **平文では持たない**（指定9）。正規化した handle の鍵付きハッシュだけを置く。
-- 利用者の行と結び付けないので、この表からは誰のものかが分からない。
--
-- handle_history（P5）は平文＋user_id で、退会時に消す。
-- あちらは「旧URLを現在のURLへ転送する」ために平文が要るが、
-- 退会後は転送先が無いので平文を持つ理由が無くなる。

create table if not exists public.handle_reservations (
  handle_hash bytea primary key,
  reserved_at timestamptz not null default now()
);

alter table public.handle_reservations enable row level security;
revoke all on public.handle_reservations from public, anon, authenticated;

comment on table public.handle_reservations is
  '退会した人が使っていた ID の予約。正規化 handle の鍵付きハッシュのみ。'
  '利用者の行と結び付けない（誰のものかが分からない）。';


-- --- 3-c. storage_cleanup_queue ／ 消し損ねた画像 ------------------------------
--
-- 退会では works.image_path も消す（指定5）。消してしまうと
-- **どのファイルを消すべきかが分からなくなる**ので、消す前にここへ移す。
-- 利用者の行とは結び付けない。

create table if not exists public.storage_cleanup_queue (
  id         bigint generated always as identity primary key,
  bucket     text not null,
  path       text not null,
  enqueued_at timestamptz not null default now(),
  deleted_at timestamptz,
  attempts   int not null default 0,
  last_error text,
  constraint storage_cleanup_queue_path_unique unique (bucket, path)
);

create index if not exists storage_cleanup_queue_pending_idx
  on public.storage_cleanup_queue (enqueued_at) where deleted_at is null;

alter table public.storage_cleanup_queue enable row level security;
revoke all on public.storage_cleanup_queue from public, anon, authenticated;

comment on table public.storage_cleanup_queue is
  '消す予定の Storage ファイル。消せたら deleted_at が入る。'
  '残っている行は Step 16 の掃除が再試行する。';


-- --- 3-d. account_deletions ／ 退会の進み具合 ---------------------------------
--
-- **profiles への外部キーを張らない。**
-- auth.users を消すと profiles も消えるので、外部キーを張ると
-- 「消し終わった記録」だけが道連れで消える。再試行の手がかりが要る。

create table if not exists public.account_deletions (
  user_id         uuid primary key,
  requested_at    timestamptz not null default now(),
  storage_done_at timestamptz,
  auth_done_at    timestamptz,
  attempts        int not null default 0,
  last_error      text
);

alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from public, anon, authenticated;

comment on table public.account_deletions is
  '退会の進み具合。auth.users を消せたら行ごと消す。'
  '残っている行は Step 16 の掃除が再試行する。profiles への外部キーは張らない。';


-- --- 3-e. terms_versions / privacy_versions ／ 規約の版 ------------------------
--
-- 2つを別の表にするのは、**改定の周期が違う**から。
-- 片方だけ直したときに、もう片方の同意まで取り直すことになるのを避ける。

create table if not exists public.terms_versions (
  version      text primary key,
  body_md      text not null,
  published_at timestamptz not null default now(),
  is_current   boolean not null default false
);

create table if not exists public.privacy_versions (
  version      text primary key,
  body_md      text not null,
  published_at timestamptz not null default now(),
  is_current   boolean not null default false
);

-- 「いま有効な版」は1つだけ。部分ユニークで固定する。
create unique index if not exists terms_versions_current_idx
  on public.terms_versions (is_current) where is_current;
create unique index if not exists privacy_versions_current_idx
  on public.privacy_versions (is_current) where is_current;

alter table public.terms_versions   enable row level security;
alter table public.privacy_versions enable row level security;
revoke all on public.terms_versions   from public, anon, authenticated;
revoke all on public.privacy_versions from public, anon, authenticated;

comment on table public.terms_versions is
  '利用規約の版。本文の取得は get_current_documents だけ。';
comment on table public.privacy_versions is
  'プライバシーポリシーの版。利用規約とは別に改定する。';


-- --- 3-f. terms_agreements ／ 同意の記録 --------------------------------------
--
-- 残すのは**誰が・どの文書の・どの版に・いつ**の4つだけ（指定：必要最小限）。
-- 端末やIPは記録しない。
--
-- retain_until を必ず入れる（指定：無期限保存にしない）。
-- 過ぎた行は Step 16 の掃除が消す。
--
-- user_id は on delete set null。退会後は
-- **メール・handle・表示名のどれとも結び付かない**行だけが残る。

create table if not exists public.terms_agreements (
  id           bigint generated always as identity primary key,
  user_id      uuid
    references public.profiles (id) on delete set null on update restrict,
  doc_kind     text not null,
  version      text not null,
  agreed_at    timestamptz not null default now(),
  retain_until timestamptz not null,
  constraint terms_agreements_doc_kind_valid check (doc_kind in ('terms', 'privacy'))
);

create unique index if not exists terms_agreements_user_doc_idx
  on public.terms_agreements (user_id, doc_kind, version) where user_id is not null;

create index if not exists terms_agreements_retain_idx
  on public.terms_agreements (retain_until);

alter table public.terms_agreements enable row level security;
revoke all on public.terms_agreements from public, anon, authenticated;

comment on table public.terms_agreements is
  '同意の記録。誰が・どの文書の・どの版に・いつ、の4つだけ。'
  '退会すると user_id が null になり、個人との結び付きが切れる。'
  'retain_until を過ぎた行は掃除の対象（無期限には持たない）。';




-- ============================================================================
-- 4. handle のハッシュ
-- ============================================================================
--
-- sha256(bytea) は PostgreSQL 本体の関数なので、拡張に依存しない。
-- 鍵を前に付けるので、handle の総当たりからは復元できない。

create or replace function public.app_handle_hash(p_handle text)
returns bytea
language sql
stable
security definer
set search_path = ''
as $$
  select sha256(
           (select s.secret from public.app_secrets s where s.key_name = 'handle_hash_key')
           || convert_to(lower(btrim(p_handle)), 'utf8')
         )
$$;

comment on function public.app_handle_hash(text) is
  '正規化した handle の鍵付きハッシュ。内部用。';

revoke all on function public.app_handle_hash(text) from public, anon, authenticated;




-- ============================================================================
-- 5. 書き込みの門番
-- ============================================================================


-- --- 5-a. 共通の判定 -----------------------------------------------------------
--
-- 退会処理そのものは自分で書き込むので、素通しできる合図を用意する。
-- set_config の第3引数 true は「この取引の中だけ」の意味なので、
-- 取引が終われば自動で消える。**消し忘れが起きない。**

create or replace function public.app_guard_account_active()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid;
  v_status text;
begin
  -- 退会処理の中からの書き込みは通す
  if coalesce(current_setting('app.account_deletion', true), '') = 'on' then
    return coalesce(new, old);
  end if;

  v_uid := (select auth.uid());

  -- 掃除の Cron や運営の作業（service_role）は auth.uid() が null
  if v_uid is null then
    return coalesce(new, old);
  end if;

  select p.account_status into v_status
    from public.profiles p where p.id = v_uid;

  -- 行が無い＝auth.users が消えたのに古い JWT で来ている
  if v_status is null or v_status <> 'active' then
    raise exception 'ACCOUNT_DELETION_PENDING' using errcode = '42501';
  end if;

  return coalesce(new, old);
end $$;

comment on function public.app_guard_account_active() is
  '退会処理中の利用者の書き込みを止める。RPC ではなく着地点に置く門番。';


-- --- 5-b. works 用（規約の同意も見る）-----------------------------------------

create or replace function public.app_guard_works()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid;
  v_status text;
begin
  if coalesce(current_setting('app.account_deletion', true), '') = 'on' then
    return coalesce(new, old);
  end if;

  v_uid := (select auth.uid());
  if v_uid is null then
    return coalesce(new, old);
  end if;

  select p.account_status into v_status
    from public.profiles p where p.id = v_uid;

  if v_status is null or v_status <> 'active' then
    raise exception 'ACCOUNT_DELETION_PENDING' using errcode = '42501';
  end if;

  -- 投稿のときだけ、いま有効な版への同意を求める（指定：未同意なら拒否）。
  -- 既存の利用者もここで初めて同意を求められる。
  if tg_op = 'INSERT' then
    if exists (
      select 1 from public.terms_versions tv
       where tv.is_current
         and not exists (
           select 1 from public.terms_agreements ta
            where ta.user_id = v_uid and ta.doc_kind = 'terms'
              and ta.version = tv.version)
    ) then
      raise exception 'TERMS_NOT_AGREED' using errcode = '42501';
    end if;

    if exists (
      select 1 from public.privacy_versions pv
       where pv.is_current
         and not exists (
           select 1 from public.terms_agreements ta
            where ta.user_id = v_uid and ta.doc_kind = 'privacy'
              and ta.version = pv.version)
    ) then
      raise exception 'TERMS_NOT_AGREED' using errcode = '42501';
    end if;
  end if;

  return coalesce(new, old);
end $$;

comment on function public.app_guard_works() is
  '作品への書き込みの門番。退会処理中を止め、投稿時は規約への同意を求める。';


-- --- 5-c. profiles 用（退会した人の ID を渡さない）-----------------------------

create or replace function public.app_guard_profiles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid;
begin
  if coalesce(current_setting('app.account_deletion', true), '') = 'on' then
    return new;
  end if;

  v_uid := (select auth.uid());

  if v_uid is not null and old.account_status <> 'active' then
    raise exception 'ACCOUNT_DELETION_PENDING' using errcode = '42501';
  end if;

  -- 退会した人が使っていた ID は他人に渡さない（指定9）。
  -- P5 の handle_history（平文）とは別に、ハッシュ側も見る。
  if new.handle is not null and new.handle is distinct from old.handle then
    if exists (
      select 1 from public.handle_reservations r
       where r.handle_hash = public.app_handle_hash(new.handle)
    ) then
      raise exception 'HANDLE_RETIRED' using errcode = '42501';
    end if;
  end if;

  return new;
end $$;

comment on function public.app_guard_profiles() is
  'プロフィール更新の門番。退会処理中を止め、退会者の ID の再取得も止める。';


-- --- 5-d. 取り付け -------------------------------------------------------------
--
-- **書き込みが着地する8つの表**に付ける。
-- answer_items / prompt_cards / quiz_* は、親（answers / prompts）を
-- 通らずには書けないので付けない。

drop trigger if exists guard_account_active on public.answers;
create trigger guard_account_active
  before insert or update or delete on public.answers
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_account_active on public.likes;
create trigger guard_account_active
  before insert or update or delete on public.likes
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_account_active on public.saves;
create trigger guard_account_active
  before insert or update or delete on public.saves
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_account_active on public.reports;
create trigger guard_account_active
  before insert or update or delete on public.reports
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_account_active on public.draft_sessions;
create trigger guard_account_active
  before insert or update or delete on public.draft_sessions
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_account_active on public.prompts;
create trigger guard_account_active
  before insert or update or delete on public.prompts
  for each row execute function public.app_guard_account_active();

drop trigger if exists guard_works on public.works;
create trigger guard_works
  before insert or update or delete on public.works
  for each row execute function public.app_guard_works();

-- profiles は UPDATE だけ。INSERT は auth.users のトリガーが行う。
drop trigger if exists guard_profiles on public.profiles;
create trigger guard_profiles
  before update on public.profiles
  for each row execute function public.app_guard_profiles();




-- ============================================================================
-- 6. Storage ／ 退会処理中はアップロードも差し替えも削除もさせない
-- ============================================================================
--
-- 既存の3本に条件を1つ足すだけ。読み取り（公開）は変えない。
-- profiles は anon / authenticated が SELECT できるので、ここから引ける。

drop policy if exists works_objects_insert_own on storage.objects;
create policy works_objects_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.account_status = 'active')
  );

drop policy if exists works_objects_update_own on storage.objects;
create policy works_objects_update_own
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
    and exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.account_status = 'active')
  )
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );

drop policy if exists works_objects_delete_own on storage.objects;
create policy works_objects_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.account_status = 'active')
  );




-- ============================================================================
-- 7. RPC
-- ============================================================================


-- --- 7-a. get_current_documents ／ いま有効な規約を読む ------------------------
--
-- 登録前にも読めるようにする（同意する前に本文が見られないのはおかしい）。

create or replace function public.get_current_documents()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'terms', (select jsonb_build_object(
                'version', tv.version, 'body_md', tv.body_md,
                'published_at', tv.published_at)
                from public.terms_versions tv where tv.is_current),
    'privacy', (select jsonb_build_object(
                'version', pv.version, 'body_md', pv.body_md,
                'published_at', pv.published_at)
                from public.privacy_versions pv where pv.is_current)
  )
$$;

comment on function public.get_current_documents() is
  'いま有効な利用規約とプライバシーポリシー。未ログインでも読める。';

revoke all on function public.get_current_documents() from public;
grant execute on function public.get_current_documents() to anon, authenticated;


-- --- 7-b. get_account_state ／ 自分の状態 --------------------------------------

create or replace function public.get_account_state()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'account_status', p.account_status,
    'is_anonymous',   coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true),
    'handle',         p.handle,
    'display_name',   p.display_name,
    'confirm_word',   coalesce(p.handle, p.display_name),
    'terms_agreed', exists (
      select 1 from public.terms_versions tv
       join public.terms_agreements ta
         on ta.doc_kind = 'terms' and ta.version = tv.version and ta.user_id = p.id
       where tv.is_current),
    'privacy_agreed', exists (
      select 1 from public.privacy_versions pv
       join public.terms_agreements ta
         on ta.doc_kind = 'privacy' and ta.version = pv.version and ta.user_id = p.id
       where pv.is_current),
    'works_count', (select count(*)::int from public.works w
                     where w.user_id = p.id and w.deleted_at is null)
  )
    from public.profiles p
   where p.id = (select auth.uid())
$$;

comment on function public.get_account_state() is
  '自分のアカウントの状態と同意の有無。他人の状態は返さない。';

revoke all on function public.get_account_state() from public, anon;
grant execute on function public.get_account_state() to authenticated;


-- --- 7-c. agree_to_documents ／ 同意を記録する --------------------------------
--
-- 版を引数で受け取り、**いま有効な版と一致するときだけ**記録する。
-- 古い版に同意させられる経路を作らないため。

create or replace function public.agree_to_documents(
  p_terms_version   text,
  p_privacy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_terms   text;
  v_privacy text;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles p
                  where p.id = v_uid and p.account_status = 'active') then
    raise exception 'ACCOUNT_DELETION_PENDING' using errcode = '42501';
  end if;

  select tv.version into v_terms   from public.terms_versions   tv where tv.is_current;
  select pv.version into v_privacy from public.privacy_versions pv where pv.is_current;

  if v_terms is distinct from p_terms_version
     or v_privacy is distinct from p_privacy_version then
    raise exception 'VERSION_MISMATCH' using errcode = '22023';
  end if;

  -- 保存期間は5年。過ぎたら掃除が消す（無期限にはしない）。
  insert into public.terms_agreements (user_id, doc_kind, version, retain_until)
  values (v_uid, 'terms',   v_terms,   now() + interval '5 years'),
         (v_uid, 'privacy', v_privacy, now() + interval '5 years')
  on conflict (user_id, doc_kind, version) where user_id is not null
  do nothing;

  return jsonb_build_object('terms', v_terms, 'privacy', v_privacy);
end $$;

comment on function public.agree_to_documents(text, text) is
  '規約への同意を記録する。いま有効な版と一致するときだけ通す。';

revoke all on function public.agree_to_documents(text, text) from public, anon;
grant execute on function public.agree_to_documents(text, text) to authenticated;


-- --- 7-d. start_account_deletion ／ 退会の第1段階 ------------------------------
--
-- **引数で利用者を受け取らない。**auth.uid() の行しか触れないので、
-- 他人のアカウントを消す経路が構造として存在しない。
--
-- ここで DB 側は全部終わる。残るのは Storage と auth.users で、
-- どちらもこの取引の外（サーバー側）で行う。

create or replace function public.start_account_deletion(p_confirm text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid     uuid := (select auth.uid());
  v_status  text;
  v_expected text;
  v_objects jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- ゲストは退会の対象にしない。メールもプロフィールも持たず、
  -- 30日で掃除される（Step 16）。
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  select p.account_status, coalesce(p.handle, p.display_name)
    into v_status, v_expected
    from public.profiles p where p.id = v_uid;

  if v_status is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'ALREADY_PENDING' using errcode = '42501';
  end if;

  -- 誤操作の防止。画面でも見るが、DB 側でも確かめる。
  if btrim(coalesce(p_confirm, '')) <> v_expected then
    raise exception 'CONFIRM_MISMATCH' using errcode = '22023';
  end if;

  -- ここから先は自分で書き込むので、門番を通す合図を立てる
  perform set_config('app.account_deletion', 'on', true);

  -- (1) 画像の場所を控える。**works.image_path を消す前に行う。**
  --     先に消すと、どのファイルを消せばよいか分からなくなる。
  insert into public.storage_cleanup_queue (bucket, path)
  select 'works', w.image_path
    from public.works w
   where w.user_id = v_uid and w.image_path is not null
  on conflict (bucket, path) do nothing;

  -- (2) 作品：即座に公開から外し、削除済みにし、持ち主と作者由来の情報を消す。
  --     **行は消さない。**消すと他人の回答と集計が道連れになる。
  update public.works w
     set is_published     = false,
         deleted_at       = coalesce(w.deleted_at, now()),
         user_id          = null,
         title            = null,
         image_path       = null,
         image_width      = null,
         image_height     = null,
         source_title     = null,
         source_character = null,
         fanart_note      = null
   where w.user_id = v_uid;

  -- (3) 他人の記録は残し、本人への線だけを切る
  update public.answers a set user_id     = null where a.user_id     = v_uid;
  update public.reports r set reporter_id = null where r.reporter_id = v_uid;
  update public.prompts p set created_by  = null where p.created_by  = v_uid;

  -- (4) 本人だけのものは消す
  delete from public.likes            where user_id = v_uid;
  delete from public.saves            where user_id = v_uid;
  delete from public.user_stats       where user_id = v_uid;
  delete from public.user_slot_stats  where user_id = v_uid;
  delete from public.draft_sessions   where user_id = v_uid;

  -- (5) ID を押さえる。平文は残さず、鍵付きハッシュだけにする。
  insert into public.handle_reservations (handle_hash)
  select public.app_handle_hash(h.handle)
    from (
      select p.handle from public.profiles p
       where p.id = v_uid and p.handle is not null
      union
      select hh.handle from public.handle_history hh where hh.user_id = v_uid
    ) h
  on conflict (handle_hash) do nothing;

  delete from public.handle_history where user_id = v_uid;

  -- (6) 同意の記録は残すが、個人との結び付きを切る
  update public.terms_agreements t set user_id = null where t.user_id = v_uid;

  -- (7) プロフィールを空にし、退会処理中にする
  update public.profiles p
     set handle                = null,
         display_name          = '退会したユーザー',
         bio                   = null,
         links                 = '{}'::jsonb,
         show_answer_stats     = false,
         show_answer_history   = false,
         show_saved_works      = false,
         account_status        = 'deletion_pending',
         deletion_requested_at = now()
   where p.id = v_uid;

  -- (8) 続きを行うための記録。auth.users を消せたら行ごと消す。
  insert into public.account_deletions (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'bucket', q.bucket, 'path', q.path)), '[]'::jsonb)
    into v_objects
    from public.storage_cleanup_queue q
   where q.deleted_at is null
     and q.bucket = 'works'
     and q.path like v_uid::text || '/%';

  return jsonb_build_object('user_id', v_uid, 'objects', v_objects);
end $$;

comment on function public.start_account_deletion(text) is
  '退会の第1段階。DB 側を全部片づけ、消すべき画像の一覧を返す。'
  '引数で利用者を受け取らないので、他人のアカウントは消せない。';

revoke all on function public.start_account_deletion(text) from public, anon;
grant execute on function public.start_account_deletion(text) to authenticated;




-- ============================================================================
-- 8. 規約の初版
-- ============================================================================
--
-- 本文は雛形。**公開前に法務の確認を受けて差し替える**（P3 の残り）。
-- 版を上げるときは is_current を付け替えるだけでよい。

insert into public.terms_versions (version, body_md, is_current)
select '2026-08-04', $doc$# 利用規約（雛形）

## 1. 投稿できるもの

- 自分で描いた絵だけを投稿してください。
- 他人の作品、他人が権利を持つ画像をそのまま投稿しないでください。
- AI で生成した絵は **AI 部門**として投稿してください。通常部門には投稿できません。
- 二次創作は**ファンアート部門**として、作品名を添えて投稿してください。

## 2. 投稿できないもの

- 法令に反するもの
- 他人を傷つけるもの、差別を含むもの
- 性的・暴力的で、閲覧者が不意に目にすると困るもの

## 3. 投稿した作品の扱い

- 作品の権利は投稿した方に残ります。
- このサービスは、作品を**サービス内で表示するためにのみ**利用します。
- 通報を受けた作品は、運営が非公開にすることがあります。

## 4. 退会したときの扱い

退会すると、次のようになります。

- 作品は**すべて非公開**になり、削除済みとして扱われます。画像は消えます。
- 作品の行そのものは残りますが、**作者との結び付きは切れます**。
  これは、その作品に答えた他の方の記録を壊さないためです。
- あなたが押したいいね・お気に入りは消えます。
- あなたが答えた記録は残りますが、誰の回答かは分からなくなります。
- **退会は取り消せません。**

## 5. 変更

この規約は変更されることがあります。変更したときは、
次に作品を投稿する前に、新しい版への同意をお願いします。
$doc$, true
 where not exists (select 1 from public.terms_versions t where t.version = '2026-08-04');

insert into public.privacy_versions (version, body_md, is_current)
select '2026-08-04', $doc$# プライバシーポリシー（雛形）

## 1. 集めるもの

| 種類 | 目的 |
|---|---|
| メールアドレス | ログインのため |
| 表示名・ID・自己紹介・外部リンク | プロフィールの表示のため |
| 作品・お題・回答 | サービスの提供のため |
| いいね・お気に入り | サービスの提供のため |
| 規約への同意の記録 | **同意を受けたことを示すため** |

端末の情報、位置情報、閲覧履歴の広告利用は行いません。

## 2. 同意の記録について（保存の目的と期間）

規約とこのポリシーへの同意について、次の4つだけを記録します。

- どなたが（利用者の識別子）
- どの文書の
- どの版に
- いつ

**保存の目的**は、同意を受けたことを後から示せるようにするためです。
**保存の期間は同意した日から5年**です。期間を過ぎた記録は自動で消えます。
**無期限には保存しません。**

**退会されたあとは、この記録から利用者の識別子を外します。**
そのため、メールアドレス・ID・表示名のいずれとも結び付かなくなります。

## 3. 退会したときに消えるもの

- メールアドレスとパスワード
- 表示名・ID・自己紹介・外部リンク
- 作品の画像、作品名、二次創作の記載
- いいね・お気に入り・あなたの成績

## 4. 退会しても残るもの

次のものは残りますが、**あなたと結び付かない形**になります。

- 作品の行（他の方の回答と正答率を壊さないため）
- あなたが他の方の作品に答えた記録（作者の伝達率は他の方の記録のため）
- 通報の記録（運営が対応するため。誰が通報したかは消えます）

## 5. 使っていた ID について

退会後、使っていた ID をすぐに他の方へ渡すことはしません。
このとき ID は**そのままの形では保存せず、鍵を使ったハッシュに変換して**
保存します。保存された値から ID を読み取ることはできません。

## 6. 問い合わせ

（公開前に連絡先を記載します）
$doc$, true
 where not exists (select 1 from public.privacy_versions p where p.version = '2026-08-04');




-- ============================================================================
-- 9. 検算（外れたら全部巻き戻す）
-- ============================================================================

do $$
declare
  v_works_null int;
  v_fk         text;
  v_triggers   int;
  v_sealed     int;
  v_current_t  int;
  v_current_p  int;
begin
  -- (1) works の持ち主を外せるようになっているか
  select case when a.attnotnull then 1 else 0 end into v_works_null
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'works' and a.attname = 'user_id';

  if v_works_null <> 0 then
    raise exception 'works.user_id がまだ not null です';
  end if;

  select con.confdeltype into v_fk
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'works' and con.conname = 'works_user_id_fkey';

  if v_fk <> 'n' then
    raise exception 'works.user_id の外部キーが set null になっていません（%）', v_fk;
  end if;

  -- (2) 既存の作品が制約に引っかかっていないか
  if exists (select 1 from public.works where user_id is null and deleted_at is null) then
    raise exception '持ち主のいない作品が公開対象に残っています';
  end if;

  -- (3) 門番が8つ付いているか
  select count(*)::int into v_triggers
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and t.tgname in ('guard_account_active', 'guard_works', 'guard_profiles');

  if v_triggers <> 8 then
    raise exception '門番の数が8ではありません（実際 %）', v_triggers;
  end if;

  -- (4) 新しい7表が遮断されているか
  select count(*)::int into v_sealed
    from (select unnest(array['app_secrets', 'handle_reservations',
                              'storage_cleanup_queue', 'account_deletions',
                              'terms_versions', 'privacy_versions',
                              'terms_agreements']) as t) x
   where exists (
     select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = x.t
        and c.relrowsecurity
        and c.relacl is not null
        and exists (select 1 from aclexplode(c.relacl) a
                     where a.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid)));

  if v_sealed <> 0 then
    raise exception '新しい表のうち % 個に利用者向けの権限が残っています', v_sealed;
  end if;

  -- (5) 有効な版がそれぞれ1つ
  select count(*)::int into v_current_t from public.terms_versions   where is_current;
  select count(*)::int into v_current_p from public.privacy_versions where is_current;

  if v_current_t <> 1 or v_current_p <> 1 then
    raise exception '有効な版が1つではありません（規約 % / ポリシー %）',
                    v_current_t, v_current_p;
  end if;

  raise notice '── 退会・規約 検算5項目 OK ──';
end $$;
