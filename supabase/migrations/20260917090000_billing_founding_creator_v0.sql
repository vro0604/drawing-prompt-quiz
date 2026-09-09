-- ============================================================================
-- billing_founding_creator_v0 ／ 最初の商品「Founding Creator」を安全に売る
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 課金の表を5つ足す（商品・顧客・購入・権限・受信済みの合図）
--   2. 5表とも遮断する（RLS を有効にし、権限もポリシーも与えない）
--   3. 販売枠を予約し、決済の確定で Founder 番号を出す RPC を足す
--   4. 一覧・残り枠・公開設定の3本だけを、利用者から呼べる形で出す
--
-- 【このファイルがやらないこと】
--   ・既存の表・列・制約を1つも変えない
--   ・既存の RPC を1本も書き換えない（get_public_profile も触らない）
--   ・定期購入（サブスクリプション）の表を作らない
--   ・Creator Pro の90日権を発行しない
--   ・規約の本文を変えない（「本サービスの利用は無料です」は
--     20260808200000_legal_v1.sql:218 にある。販売開始前に別途改定が要る）
--
-- 【言葉の対応】
--   Founder      … Founding Creator を買った人
--   Founder 番号  … 決済の確定順に出す通し番号（#001 から）
--   枠（slot）    … 同時に有効でいられる Founder の数の上限。30
--   entitlement  … 「何ができるか」。商品名とは分けて持つ
--
-- 【なぜ商品名と権限を分けるか】
--   商品はこの先も増える。名前で判定を書くと、商品が増えるたびに
--   判定の場所が増える。**権限の鍵（entitlement_key）だけを見る形にすれば、
--   どの商品から来た権限でも判定は1か所で済む。**
--   Founder を買うと founding_creator と beta_access の2つが付く。
--   プロフィールの表示は「権限 ＋ 本人の公開設定」から作るので、
--   表示のための権限（バッジ）を別に作らない。
--
-- 【実行方法】
--   npm run db:deploy
--
-- ============================================================================




-- ============================================================================
-- 0. 共通 ／ updated_at を書き換えの都度そろえる
-- ============================================================================
--
-- 既存の draft_sessions_set_updated_at と同じ役目。課金の3表で使い回す。

create or replace function public.app_billing_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end;
$fn$;

comment on function public.app_billing_touch_updated_at() is
  '課金の表の updated_at を書き換えの都度そろえる【内部用】。誰も直接呼べない。';

revoke all on function public.app_billing_touch_updated_at()
  from public, anon, authenticated;




-- ============================================================================
-- 1. billing_offers ／ 何を、いくらで、何人まで売るか
-- ============================================================================
--
-- 【ブラウザから値段を受け取らない】
--   買う要求にはお題も金額も乗せない。**金額はこの表からしか読まない。**
--   Stripe から戻ってきた金額も、この表の値と突き合わせてから権限を付ける。
--
-- 【なぜ id が bigint か】
--   この表は運営しか触らない台帳で、外へ ID を出す機会が無い。
--   外へ出るのは code（founding_creator_v0）のほうなので、
--   推測されて困る値ではない。既存のマスタ表と同じ形にする。
--
-- 【sales_cap が null のとき】
--   上限なし。Founder は 30 を入れるので、今回 null は使わない。

create table if not exists public.billing_offers (

  id bigint generated always as identity primary key,

  -- 外から指す名前。**この文字列が商品の同一性。**
  code text not null unique
    constraint billing_offers_code_format
      check (code ~ '^[a-z0-9_]{3,64}$'),

  name text not null
    constraint billing_offers_name_length
      check (char_length(btrim(name)) between 1 and 100),

  -- 売り方。今回は買い切りだけ。定期購入は別の表を足すときに増やす
  kind text not null
    constraint billing_offers_kind_valid
      check (kind in ('one_time')),

  -- 通貨。円は小数を持たないので、amount はそのまま「円」
  currency text not null
    constraint billing_offers_currency_valid
      check (currency in ('jpy')),

  amount integer not null
    constraint billing_offers_amount_range
      check (amount between 1 and 1000000),

  -- 同時に有効でいられる人数の上限。null なら上限なし
  sales_cap integer
    constraint billing_offers_sales_cap_positive
      check (sales_cap is null or sales_cap > 0),

  starts_at timestamptz,
  ends_at   timestamptz,

  constraint billing_offers_period_order
    check (starts_at is null or ends_at is null or starts_at < ends_at),

  -- **既定は false。**足しただけでは売れない
  is_active boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.billing_offers is
  '売り物の定義。金額と上限と期間はここだけが持つ。'
  'ブラウザから送られた金額は一切信用せず、この行と突き合わせる。';
comment on column public.billing_offers.sales_cap is
  '同時に有効でいられる人数の上限。返金で1枠戻るので、通し番号の最大値は上限を超えうる。';
comment on column public.billing_offers.is_active is
  '既定は false。行を足しただけでは売れない。';

create trigger billing_offers_touch_updated_at
  before update on public.billing_offers
  for each row
  execute function public.app_billing_touch_updated_at();

alter table public.billing_offers enable row level security;
revoke all on table public.billing_offers from public, anon, authenticated;


-- Founding Creator（D187）。3,000円・買い切り・有効30名。
-- **is_active は false のまま入れる。**販売開始は運営が別途 true にする。
-- starts_at / ends_at も空にしておく（一般公開の日が決まってから入れる）。
insert into public.billing_offers (code, name, kind, currency, amount, sales_cap, is_active)
values ('founding_creator_v0', 'Founding Creator', 'one_time', 'jpy', 3000, 30, false)
on conflict (code) do nothing;




-- ============================================================================
-- 2. billing_customers ／ この人と、Stripe の顧客の対応
-- ============================================================================
--
-- 【なぜ profile_id を切れるようにするか】
--   退会しても、**お金のやり取りの記録は消せない。**
--   帳簿は残したまま、誰のものだったかの結び付きだけを外す。
--   だから profile_id は null を許し、profiles が消えたら null になる。
--
-- 【1人につき1つ】
--   profile_id に unique を張る。同じ人の Stripe 顧客が2つできると、
--   支払い方法の使い回しも領収も両方の側に散らばる。

create table if not exists public.billing_customers (

  id uuid primary key default gen_random_uuid(),

  profile_id uuid unique
    references public.profiles (id) on delete set null,

  stripe_customer_id text not null unique
    constraint billing_customers_stripe_id_format
      check (stripe_customer_id ~ '^cus_[A-Za-z0-9]{1,80}$'),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.billing_customers is
  'アプリの利用者と Stripe の顧客の対応。退会しても記録を残せるよう profile_id は切れる。';

create trigger billing_customers_touch_updated_at
  before update on public.billing_customers
  for each row
  execute function public.app_billing_touch_updated_at();

alter table public.billing_customers enable row level security;
revoke all on table public.billing_customers from public, anon, authenticated;




-- ============================================================================
-- 3. billing_purchases ／ 買い切りの購入1件と、Founder 番号
-- ============================================================================
--
-- 【状態は8つ】
--   reserved       枠を押さえた。まだ払われていない
--   paid           決済が確定した。Founder 番号がある
--   refund_pending 返金の手続きに入った。**権利はまだ残す**
--   refunded       返金が成立した。権利は取り消し、番号は欠番
--   expired        Checkout が失効した。枠は戻る。番号は無い
--   void           運営が取り消した。枠は戻る。番号は無い
--   disputed       不審請求の申し立て中。**枠は押さえたまま**
--   reversed       申し立てが利用者側の勝ちで終わった。権利は取り消し
--
-- 【枠を数える状態】
--   reserved / paid / refund_pending / disputed の4つ。
--   残り4つは数えない。**返金と失効で枠が戻る、が全部この一行に集約される。**
--
-- 【なぜ id が uuid か】
--   この ID は Stripe の client_reference_id と metadata に載って外へ出る。
--   連番だと「何番まで売れたか」が決済画面から読めてしまう。
--
-- 【なぜ founder_number を uuid ではなく整数にするか】
--   #001 と人に見せる番号なので、順序と見た目が要る。
--
-- 【二重購入をどう止めるか】
--   下の部分一意索引が「同じ人・同じ商品で、生きている購入は1つだけ」を
--   物理的に保証する。事前の判定（RPC の中）は分かりやすい日本語を返すため。
--   **判定だけでは、すき間に入られたときに2行入る。**両方を置く。

create table if not exists public.billing_purchases (

  id uuid primary key default gen_random_uuid(),

  offer_id bigint not null
    references public.billing_offers (id) on delete restrict,

  -- 退会しても記録は残す。誰のものだったかだけが外れる
  profile_id uuid
    references public.profiles (id) on delete set null,

  -- 予約の時点ではまだ無い。Checkout を作るときに入る
  billing_customer_id uuid
    references public.billing_customers (id) on delete set null,

  status text not null default 'reserved'
    constraint billing_purchases_status_valid
      check (status in (
        'reserved', 'paid', 'refund_pending', 'refunded',
        'expired', 'void', 'disputed', 'reversed'
      )),

  -- 予約した時点の商品の値。**あとで値上げしても、この行の値は動かない**
  amount integer not null
    constraint billing_purchases_amount_range
      check (amount between 1 and 1000000),
  currency text not null
    constraint billing_purchases_currency_valid
      check (currency in ('jpy')),

  stripe_checkout_session_id text unique
    constraint billing_purchases_session_format
      check (stripe_checkout_session_id is null
             or stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,240}$'),

  stripe_payment_intent_id text unique
    constraint billing_purchases_intent_format
      check (stripe_payment_intent_id is null
             or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$'),

  stripe_refund_id text
    constraint billing_purchases_refund_format
      check (stripe_refund_id is null
             or stripe_refund_id ~ '^re_[A-Za-z0-9_]{1,240}$'),

  -- **払われて初めて付く。**返金しても消さない（欠番として残す）
  --
  -- 一意なのは「商品ごと」。商品が増えたとき、それぞれが #001 から始まる。
  -- 全体で一意にすると、2つ目の商品を出した瞬間に番号がぶつかる。
  founder_number integer
    constraint billing_purchases_founder_number_positive
      check (founder_number is null or founder_number > 0),

  -- 買った直後は非公開。本人が選ぶまで名前は出さない
  founder_public boolean not null default false,

  reserved_at         timestamptz not null default now(),
  checkout_expires_at timestamptz,
  paid_at             timestamptz,
  refund_requested_at timestamptz,
  refunded_at         timestamptz,
  pro_trial_redeemed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 番号は「一度でも払われた」ものだけが持つ。
  -- 予約中・失効・取り消しの行が番号を持っていたら、それは事故
  constraint billing_purchases_number_only_after_paid check (
    (founder_number is null and status in ('reserved', 'expired', 'void'))
    or
    (founder_number is not null and status in
       ('paid', 'refund_pending', 'refunded', 'disputed', 'reversed'))
  ),

  -- 払われたのに時刻が無い行を作らせない
  constraint billing_purchases_paid_at_present check (
    (status in ('reserved', 'expired', 'void') and paid_at is null)
    or
    (status in ('paid', 'refund_pending', 'refunded', 'disputed', 'reversed')
     and paid_at is not null)
  ),

  -- 同じ商品の中で番号が重複しない。**錠をすり抜けてもここで弾かれる**
  constraint billing_purchases_founder_number_unique
    unique (offer_id, founder_number),

  -- 返金が成立したのに時刻が無い行を作らせない
  constraint billing_purchases_refunded_at_present check (
    (status = 'refunded' and refunded_at is not null)
    or
    (status <> 'refunded' and refunded_at is null)
  )
);

comment on table public.billing_purchases is
  '買い切りの購入1件。枠の予約から Founder 番号まで、この1行が持つ。'
  '枠を数えるのは reserved / paid / refund_pending / disputed の4状態。';
comment on column public.billing_purchases.founder_number is
  '決済の確定順。返金しても消さない（欠番として一覧に残す）。再利用しない。';
comment on column public.billing_purchases.founder_public is
  '一覧とプロフィールに名前を出すか。既定は非公開。本人だけが変えられる。';
comment on column public.billing_purchases.pro_trial_redeemed_at is
  'Creator Pro の90日権を受け取った時刻。今回はまだ誰にも入らない。';

create trigger billing_purchases_touch_updated_at
  before update on public.billing_purchases
  for each row
  execute function public.app_billing_touch_updated_at();


-- **同じ人・同じ商品で、生きている購入は1つだけ。**
-- 買い直せるのは、失効・取り消し・返金のあとだけ。
create unique index if not exists billing_purchases_one_live_per_profile
  on public.billing_purchases (profile_id, offer_id)
  where profile_id is not null
    and status in ('reserved', 'paid', 'refund_pending', 'disputed');

-- 残り枠の勘定に使う
create index if not exists billing_purchases_offer_status_idx
  on public.billing_purchases (offer_id, status);

-- 一覧は番号順に並べる
create index if not exists billing_purchases_founder_number_idx
  on public.billing_purchases (founder_number)
  where founder_number is not null;

alter table public.billing_purchases enable row level security;
revoke all on table public.billing_purchases from public, anon, authenticated;




-- ============================================================================
-- 4. billing_entitlements ／ 「何ができるか」
-- ============================================================================
--
-- 【商品名で判定しない】
--   画面もサーバーも「Founding Creator を買ったか」ではなく
--   「founding_creator の権限が生きているか」を見る。
--   商品が増えても、判定の場所は増えない。
--
-- 【消さずに取り消す】
--   返金したら行を消すのではなく revoked_at を入れる。
--   **消すと「昔は持っていた」が追えなくなる。**
--
-- 【同じ購入から同じ権限は1行だけ】
--   下の一意制約が、Webhook が2回届いても2行入らないことを保証する。
--   受信済みの合図の表（billing_webhook_events）と二重に守る。

create table if not exists public.billing_entitlements (

  id bigint generated always as identity primary key,

  profile_id uuid not null
    references public.profiles (id) on delete cascade,

  entitlement_key text not null
    constraint billing_entitlements_key_valid
      check (entitlement_key in ('founding_creator', 'beta_access')),

  source_purchase_id uuid
    references public.billing_purchases (id) on delete set null,

  starts_at timestamptz not null default now(),
  ends_at   timestamptz,
  revoked_at timestamptz,

  created_at timestamptz not null default now(),

  constraint billing_entitlements_period_order
    check (ends_at is null or starts_at < ends_at),

  constraint billing_entitlements_one_per_source
    unique (profile_id, entitlement_key, source_purchase_id)
);

comment on table public.billing_entitlements is
  '「何ができるか」。商品名ではなく権限の鍵で判定する。'
  '取り消すときは行を消さず revoked_at を入れる。';

alter table public.billing_entitlements enable row level security;
revoke all on table public.billing_entitlements from public, anon, authenticated;




-- ============================================================================
-- 5. billing_webhook_events ／ 同じ合図を2回処理しない
-- ============================================================================
--
-- 【なぜ Stripe のイベント ID を主キーにするか】
--   Stripe は同じイベントを何度でも送りうる（配信が失敗すれば3日間、
--   運営が手で再送すれば15日間）。**受け取った ID を主キーにして
--   insert が通ったときだけ中身を処理する。**通らなければ、既に処理した合図。
--
-- 【processed_at を分けて持つ理由】
--   「受け取った」と「処理し終えた」は別の事実。
--   途中で落ちた合図は processed_at が空のまま残るので、あとから見つかる。

create table if not exists public.billing_webhook_events (

  stripe_event_id text primary key
    constraint billing_webhook_events_id_format
      check (stripe_event_id ~ '^evt_[A-Za-z0-9_]{1,240}$'),

  event_type text not null
    constraint billing_webhook_events_type_length
      check (char_length(event_type) between 1 and 120),

  -- そのイベントが指していた対象（cs_… / re_… / du_… など）
  object_id text
    constraint billing_webhook_events_object_length
      check (object_id is null or char_length(object_id) <= 240),

  -- 本番の合図か、試験の合図か。混ざったら分かるように残す
  livemode boolean not null,

  -- Stripe がこの知らせを組み立てたときの API の版（例 2026-08-26.dahlia）。
  -- **こちらが想定している版と食い違ったら、ここを見れば分かる。**
  -- 受け口の登録時に版を固定するので、ふだんは1つの値しか入らない。
  api_version text
    constraint billing_webhook_events_api_version_length
      check (api_version is null or char_length(api_version) between 1 and 40),

  stripe_created_at timestamptz,
  processed_at      timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.billing_webhook_events is
  '受け取った Stripe の合図。ID が主キーなので、同じ合図の再送では2度目の insert が通らない。';

create index if not exists billing_webhook_events_unprocessed_idx
  on public.billing_webhook_events (created_at)
  where processed_at is null;

alter table public.billing_webhook_events enable row level security;
revoke all on table public.billing_webhook_events from public, anon, authenticated;




-- ============================================================================
-- 6. 枠の勘定（内部用）
-- ============================================================================
--
-- 枠を占めるのは reserved / paid / refund_pending / disputed。
-- **この4つを書くのは、この関数の中だけ。**ほかの場所で数え直さない。

create or replace function public.billing_active_slots(p_offer_id bigint)
returns int
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::int
    from public.billing_purchases p
   where p.offer_id = p_offer_id
     and p.status in ('reserved', 'paid', 'refund_pending', 'disputed');
$fn$;

comment on function public.billing_active_slots(bigint) is
  'いま枠を占めている件数【内部用】。reserved / paid / refund_pending / disputed の4状態。';

revoke all on function public.billing_active_slots(bigint)
  from public, anon, authenticated;


-- 売り出し中かどうか。is_active と期間の両方を見る
create or replace function public.billing_offer_is_open(p_offer public.billing_offers)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_offer.is_active
     and (p_offer.starts_at is null or p_offer.starts_at <= now())
     and (p_offer.ends_at   is null or p_offer.ends_at   >  now());
$fn$;

comment on function public.billing_offer_is_open(public.billing_offers) is
  'その商品がいま売り出し中か【内部用】。有効の印と期間の両方を見る。';

revoke all on function public.billing_offer_is_open(public.billing_offers)
  from public, anon, authenticated;




-- ============================================================================
-- 7. billing_reserve_slot ／ 決済の前に、枠を1つ押さえる
-- ============================================================================
--
-- 【なぜ決済のあとで数えてはいけないか】
--   29人が買い終わった状態で3人が同時に決済すると、3人とも
--   「まだ1枠ある」を見てから払う。払われてから数えると32人になり、
--   **払った人に「枠が無いので返金します」と言うことになる。**
--   だから決済ページを作る前に押さえる。
--
-- 【どうやって同時を止めるか】
--   商品の行を `for update` で押さえてから数える。
--   同じ商品への予約は、この1行で必ず順番待ちになる。
--   （既存の consume_import_capacity が work_import_state で同じことをしている）
--
-- 【押さえるだけで、まだ何も確定しない】
--   ここで作る行は status = 'reserved'。Founder 番号はまだ付かない。
--   番号が付くのは Stripe が「払われた」と言ってきたときだけ。
--
-- 【service_role にしか渡さない】
--   誰の予約かを引数で受け取るので、呼ぶ側が本人であることを
--   先に確かめていなければならない。既存の管理 RPC と同じ形。

create or replace function public.billing_reserve_slot(
  p_profile_id uuid,
  p_offer_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_offer   public.billing_offers%rowtype;
  v_profile public.profiles%rowtype;
  v_live    public.billing_purchases%rowtype;
  v_used    int;
  v_row     public.billing_purchases%rowtype;
begin
  if p_profile_id is null then
    raise exception 'SIGN_IN_REQUIRED: 購入にはログインが必要です。';
  end if;

  select * into v_profile from public.profiles p where p.id = p_profile_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND: そのアカウントが見つかりません。';
  end if;

  -- **ゲストには売らない。**永続する権利を、消える見込みの器に結び付けない
  if v_profile.is_anonymous then
    raise exception
      'ACCOUNT_NOT_ELIGIBLE: ゲストのままでは購入できません。先に登録してください。';
  end if;

  if v_profile.account_status <> 'active' then
    raise exception
      'ACCOUNT_NOT_ELIGIBLE: 退会の手続き中のアカウントでは購入できません。';
  end if;

  -- 【買う前に、いま有効な版へ同意していること】
  --   規約 13-6。**お金を受け取ったあとで「同意していない」と言われる形にしない。**
  --   投稿の門番（app_guard_works）とまったく同じ見方をする。
  --   版が上がると、次に買う人はもう一度同意することになる。これは仕様どおり。
  if exists (
    select 1 from public.terms_versions tv
     where tv.is_current
       and not exists (
         select 1 from public.terms_agreements ta
          where ta.user_id = p_profile_id and ta.doc_kind = 'terms'
            and ta.version = tv.version)
  ) or exists (
    select 1 from public.privacy_versions pv
     where pv.is_current
       and not exists (
         select 1 from public.terms_agreements ta
          where ta.user_id = p_profile_id and ta.doc_kind = 'privacy'
            and ta.version = pv.version)
  ) then
    raise exception
      'TERMS_NOT_AGREED: 利用規約とプライバシーポリシーに同意してからお進みください。';
  end if;

  -- **ここが錠。**この商品への予約は、この1行で順番待ちになる
  select * into v_offer
    from public.billing_offers o
   where o.code = p_offer_code
   for update;

  if not found then
    raise exception 'OFFER_NOT_FOUND: その商品は見つかりません（%）。', p_offer_code;
  end if;

  if not public.billing_offer_is_open(v_offer) then
    raise exception 'OFFER_CLOSED: いまは販売していません。';
  end if;

  -- すでに生きている購入があるか
  select * into v_live
    from public.billing_purchases p
   where p.profile_id = p_profile_id
     and p.offer_id = v_offer.id
     and p.status in ('reserved', 'paid', 'refund_pending', 'disputed')
   limit 1;

  if found then
    if v_live.status = 'reserved' then
      -- 連打された。**新しい行を作らない。**同じ予約を返す
      return jsonb_build_object(
        'result',              'already_reserved',
        'purchase_id',          v_live.id,
        'offer_code',           v_offer.code,
        'amount',               v_live.amount,
        'currency',             v_live.currency,
        'checkout_session_id',  v_live.stripe_checkout_session_id,
        'checkout_expires_at',  v_live.checkout_expires_at
      );
    end if;

    raise exception 'ALREADY_OWNED: すでに購入済みです。';
  end if;

  v_used := public.billing_active_slots(v_offer.id);

  if v_offer.sales_cap is not null and v_used >= v_offer.sales_cap then
    raise exception 'SOLD_OUT: 販売枠が埋まりました（% / %）。',
      v_used, v_offer.sales_cap;
  end if;

  insert into public.billing_purchases
    (offer_id, profile_id, status, amount, currency)
  values
    (v_offer.id, p_profile_id, 'reserved', v_offer.amount, v_offer.currency)
  returning * into v_row;

  return jsonb_build_object(
    'result',      'reserved',
    'purchase_id', v_row.id,
    'offer_code',  v_offer.code,
    'offer_name',  v_offer.name,
    'amount',      v_row.amount,
    'currency',    v_row.currency
  );
end;
$fn$;

comment on function public.billing_reserve_slot(uuid, text) is
  '決済ページを作る前に販売枠を1つ押さえる。商品の行で錠を取るので上限を超えない。'
  '同じ人の生きている購入が既にあれば、新しい行を作らずそれを返す（連打対策）。';

revoke all on function public.billing_reserve_slot(uuid, text)
  from public, anon, authenticated;
grant execute on function public.billing_reserve_slot(uuid, text) to service_role;




-- ============================================================================
-- 8. billing_upsert_customer ／ Stripe の顧客を結び付ける
-- ============================================================================

create or replace function public.billing_upsert_customer(
  p_profile_id        uuid,
  p_stripe_customer_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_customers%rowtype;
begin
  if p_profile_id is null then
    raise exception 'SIGN_IN_REQUIRED: ログインが必要です。';
  end if;

  insert into public.billing_customers (profile_id, stripe_customer_id)
  values (p_profile_id, p_stripe_customer_id)
  on conflict (profile_id)
    do update set stripe_customer_id = excluded.stripe_customer_id
  returning * into v_row;

  return jsonb_build_object(
    'billing_customer_id', v_row.id,
    'stripe_customer_id',  v_row.stripe_customer_id
  );
end;
$fn$;

comment on function public.billing_upsert_customer(uuid, text) is
  'この人の Stripe 顧客を1つに保つ。既にあれば ID を上書きする。';

revoke all on function public.billing_upsert_customer(uuid, text)
  from public, anon, authenticated;
grant execute on function public.billing_upsert_customer(uuid, text) to service_role;


-- 既に結び付いている Stripe 顧客を読む（無ければ null）
create or replace function public.billing_get_customer(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'billing_customer_id', c.id,
    'stripe_customer_id',  c.stripe_customer_id
  )
  from public.billing_customers c
  where c.profile_id = p_profile_id;
$fn$;

comment on function public.billing_get_customer(uuid) is
  'この人の Stripe 顧客。無ければ null。';

revoke all on function public.billing_get_customer(uuid)
  from public, anon, authenticated;
grant execute on function public.billing_get_customer(uuid) to service_role;




-- ============================================================================
-- 9. billing_attach_checkout ／ 作った決済ページを予約に結び付ける
-- ============================================================================
--
-- 【なぜ別の関数にするか】
--   Stripe に決済ページを作る呼び出しは、DB の取引の外で起きる。
--   予約と同じ関数にすると、Stripe への呼び出しの間じゅう錠を握ることになる。
--   **押さえるのは一瞬にして、決済ページの ID はあとから結び付ける。**
--
-- 【予約中の行にしか結び付けない】
--   払い終わった行に別の決済ページを結び付けられると、
--   あとの突き合わせが壊れる。

create or replace function public.billing_attach_checkout(
  p_purchase_id         uuid,
  p_billing_customer_id uuid,
  p_session_id          text,
  p_expires_at          timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_purchases%rowtype;
begin
  update public.billing_purchases p
     set billing_customer_id        = p_billing_customer_id,
         stripe_checkout_session_id = p_session_id,
         checkout_expires_at        = p_expires_at
   where p.id = p_purchase_id
     and p.status = 'reserved'
  returning * into v_row;

  if not found then
    raise exception
      'PURCHASE_NOT_RESERVED: その購入は予約中ではありません（%）。', p_purchase_id;
  end if;

  return jsonb_build_object(
    'purchase_id',         v_row.id,
    'checkout_session_id', v_row.stripe_checkout_session_id,
    'checkout_expires_at', v_row.checkout_expires_at
  );
end;
$fn$;

comment on function public.billing_attach_checkout(uuid, uuid, text, timestamptz) is
  '作った決済ページを、予約中の購入へ結び付ける。予約中以外には結び付けない。';

revoke all on function public.billing_attach_checkout(uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.billing_attach_checkout(uuid, uuid, text, timestamptz)
  to service_role;




-- ============================================================================
-- 10. billing_complete_checkout ／ 払われたことを確定し、番号を出す
-- ============================================================================
--
-- 【ブラウザが戻ってきただけでは何もしない】
--   この関数を呼べるのは Webhook の受け口だけ（service_role）。
--   成功画面は「確認しています」と出すだけで、権限には触らない。
--
-- 【付ける前に6つ突き合わせる】
--   売り方（payment）／支払い済みか／決済ページの ID が一致するか／
--   商品が Founding Creator か／金額／通貨。
--   金額と通貨は**この DB の商品定義**と比べる。Stripe から来た値どうしでは比べない。
--
-- 【Founder 番号の出し方】
--   商品の行を `for update` で押さえ、その商品の最大の番号に1を足す。
--
--   ・連番の仕掛け（sequence）を使わない …… 取引が巻き戻っても番号が戻らず、
--     払ってもいない欠番が並ぶ。「通常の失敗で欠番を作らない」に反する。
--   ・素の max()+1 を裸で使わない …………… 同時に2つ走ると同じ番号になる。
--   ・錠 ＋ max()+1 ＋ 一意制約の3枚重ね …… 錠で順番を作り、万一すり抜けても
--     founder_number の一意制約が2つ目を弾く。
--     **弾かれた側は取引ごと巻き戻るので、権限が半分付いた行は残らない。**
--
-- 【返金した番号は再利用しない】
--   max() は返金済みの行も含めて数える。だから欠番は欠番のまま残る。
--
-- 【同じ合図が2回来たとき】
--   すでに paid で、決済ページの ID も一致していれば、
--   何も変えずに同じ番号を返す。**2つ目の番号を出さない。**

create or replace function public.billing_complete_checkout(
  p_session_id        text,
  p_purchase_id       uuid,
  p_offer_code        text,
  p_mode              text,
  p_payment_status    text,
  p_amount_total      integer,
  p_currency          text,
  p_payment_intent_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_purchase public.billing_purchases%rowtype;
  v_offer    public.billing_offers%rowtype;
  v_number   int;
begin
  -- --- 決済ページそのものの形 ---------------------------------------------
  if p_mode is distinct from 'payment' then
    raise exception 'MODE_MISMATCH: 買い切り以外の決済は受け付けません（%）。', p_mode;
  end if;

  if p_payment_status is distinct from 'paid' then
    raise exception 'PAYMENT_NOT_PAID: まだ支払いが確定していません（%）。',
      p_payment_status;
  end if;

  if p_purchase_id is null then
    raise exception 'PURCHASE_ID_MISSING: 購入の ID が付いていません。';
  end if;

  -- --- 突き合わせる相手を出す ---------------------------------------------
  select * into v_purchase
    from public.billing_purchases p
   where p.id = p_purchase_id
   for update;

  if not found then
    raise exception 'PURCHASE_NOT_FOUND: その購入が見つかりません（%）。', p_purchase_id;
  end if;

  if v_purchase.stripe_checkout_session_id is distinct from p_session_id then
    raise exception
      'SESSION_MISMATCH: 決済ページの ID が記録と一致しません。';
  end if;

  select * into v_offer
    from public.billing_offers o
   where o.id = v_purchase.offer_id
   for update;

  if v_offer.code is distinct from p_offer_code then
    raise exception 'OFFER_MISMATCH: 商品が一致しません（% / %）。',
      p_offer_code, v_offer.code;
  end if;

  -- **金額と通貨は、この DB の商品定義と比べる**
  if p_amount_total is distinct from v_offer.amount then
    raise exception 'AMOUNT_MISMATCH: 金額が一致しません（受信 % / 定義 %）。',
      p_amount_total, v_offer.amount;
  end if;

  if lower(coalesce(p_currency, '')) is distinct from v_offer.currency then
    raise exception 'CURRENCY_MISMATCH: 通貨が一致しません（受信 % / 定義 %）。',
      p_currency, v_offer.currency;
  end if;

  -- --- 2回目以降の合図 -----------------------------------------------------
  if v_purchase.status <> 'reserved' then
    if v_purchase.status in ('paid', 'refund_pending', 'disputed')
       and v_purchase.founder_number is not null then
      return jsonb_build_object(
        'result',        'already_granted',
        'purchase_id',   v_purchase.id,
        'founder_number', v_purchase.founder_number
      );
    end if;

    raise exception
      'PURCHASE_NOT_RESERVED: その購入は予約中ではありません（いま %）。',
      v_purchase.status;
  end if;

  -- --- 番号を出して確定する -----------------------------------------------
  --
  -- 上で商品の行を押さえてあるので、ここは同じ商品について1つずつしか走らない。
  select coalesce(max(p.founder_number), 0) + 1 into v_number
    from public.billing_purchases p
   where p.offer_id = v_offer.id;

  update public.billing_purchases p
     set status                   = 'paid',
         paid_at                  = now(),
         stripe_payment_intent_id = coalesce(p_payment_intent_id,
                                             p.stripe_payment_intent_id),
         founder_number           = v_number
   where p.id = v_purchase.id;

  -- --- 権限を付ける -------------------------------------------------------
  --
  -- 退会済み（profile_id が外れている）なら権限の付けようが無い。
  -- **お金の記録は残し、権限だけを飛ばす。**
  if v_purchase.profile_id is not null then
    insert into public.billing_entitlements
      (profile_id, entitlement_key, source_purchase_id)
    values
      (v_purchase.profile_id, 'founding_creator', v_purchase.id),
      (v_purchase.profile_id, 'beta_access',      v_purchase.id)
    on conflict (profile_id, entitlement_key, source_purchase_id) do nothing;
  end if;

  return jsonb_build_object(
    'result',         'granted',
    'purchase_id',    v_purchase.id,
    'founder_number', v_number,
    'profile_id',     v_purchase.profile_id
  );
end;
$fn$;

comment on function public.billing_complete_checkout(text, uuid, text, text, text, integer, text, text) is
  '決済の確定。売り方・支払い状態・決済ページ・商品・金額・通貨の6つが合ったときだけ'
  'Founder 番号を出し、founding_creator と beta_access を付ける。'
  '同じ合図が2回来ても番号は増えない。';

revoke all on function public.billing_complete_checkout(text, uuid, text, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.billing_complete_checkout(text, uuid, text, text, text, integer, text, text)
  to service_role;




-- ============================================================================
-- 11. billing_expire_checkout ／ 決済ページが失効したので枠を戻す
-- ============================================================================
--
-- 【DB の時計で勝手に戻さない】
--   予約に checkout_expires_at を持たせてはいるが、**その時刻を過ぎたことを
--   理由に枠を戻さない。**払われた直後に合図が遅れて届くことがあり、
--   時計だけで戻すと「払ったのに枠が無い」が起きる。
--   戻す根拠は Stripe が「失効した」と言ったことだけ。

create or replace function public.billing_expire_checkout(p_session_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_purchases%rowtype;
begin
  select * into v_row
    from public.billing_purchases p
   where p.stripe_checkout_session_id = p_session_id
   for update;

  if not found then
    return jsonb_build_object('result', 'unknown_session');
  end if;

  if v_row.status <> 'reserved' then
    -- 払い終わったあとに失効の合図が来ることはあるが、**戻さない**
    return jsonb_build_object('result', 'not_reserved', 'status', v_row.status);
  end if;

  update public.billing_purchases p
     set status = 'expired'
   where p.id = v_row.id;

  return jsonb_build_object('result', 'expired', 'purchase_id', v_row.id);
end;
$fn$;

comment on function public.billing_expire_checkout(text) is
  '決済ページの失効を受けて枠を戻す。予約中の行だけを動かす。'
  'DB の時計では戻さない。Stripe が失効したと言ったときだけ。';

revoke all on function public.billing_expire_checkout(text)
  from public, anon, authenticated;
grant execute on function public.billing_expire_checkout(text) to service_role;




-- ============================================================================
-- 12. 返金 ／ 始まったとき・成立したとき・失敗したとき
-- ============================================================================
--
-- 【始まっただけでは取り上げない】
--   返金は失敗することがある（Stripe の refund の status は
--   pending / requires_action / succeeded / failed / canceled）。
--   始まった時点で権利を消すと、失敗したときに戻せない。
--   だから refund_pending の間は権利をそのまま残す。
--
-- 【成立したときにだけ取り上げる】
--   権限に revoked_at を入れ、枠を1つ戻し、一覧を欠番にする。
--   **番号そのものは消さない。**再利用しない。

create or replace function public.billing_mark_refund_pending(
  p_payment_intent_id text,
  p_refund_id         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_purchases%rowtype;
begin
  select * into v_row
    from public.billing_purchases p
   where p.stripe_payment_intent_id = p_payment_intent_id
   for update;

  if not found then
    return jsonb_build_object('result', 'unknown_payment');
  end if;

  if v_row.status = 'refunded' then
    return jsonb_build_object('result', 'already_refunded', 'purchase_id', v_row.id);
  end if;

  if v_row.status <> 'paid' then
    return jsonb_build_object('result', 'not_paid', 'status', v_row.status);
  end if;

  update public.billing_purchases p
     set status              = 'refund_pending',
         stripe_refund_id    = coalesce(p_refund_id, p.stripe_refund_id),
         refund_requested_at = coalesce(p.refund_requested_at, now())
   where p.id = v_row.id;

  return jsonb_build_object('result', 'refund_pending', 'purchase_id', v_row.id);
end;
$fn$;

comment on function public.billing_mark_refund_pending(text, text) is
  '返金の手続きが始まったことを記録する。**権利はまだ取り上げない。**';

revoke all on function public.billing_mark_refund_pending(text, text)
  from public, anon, authenticated;
grant execute on function public.billing_mark_refund_pending(text, text) to service_role;


-- 返金の結果を反映する。p_refund_status は Stripe の refund.status そのまま
create or replace function public.billing_apply_refund_result(
  p_payment_intent_id text,
  p_refund_id         text,
  p_refund_status     text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_purchases%rowtype;
begin
  if p_refund_status not in
     ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') then
    raise exception 'REFUND_STATUS_UNKNOWN: 知らない返金の状態です（%）。',
      p_refund_status;
  end if;

  select * into v_row
    from public.billing_purchases p
   where p.stripe_payment_intent_id = p_payment_intent_id
   for update;

  if not found then
    return jsonb_build_object('result', 'unknown_payment');
  end if;

  -- まだ途中。記録だけ更新して終わる
  if p_refund_status in ('pending', 'requires_action') then
    update public.billing_purchases p
       set stripe_refund_id    = coalesce(p_refund_id, p.stripe_refund_id),
           refund_requested_at = coalesce(p.refund_requested_at, now()),
           status              = case when p.status = 'paid'
                                      then 'refund_pending' else p.status end
     where p.id = v_row.id;

    return jsonb_build_object('result', 'refund_pending', 'purchase_id', v_row.id);
  end if;

  -- 返金が成立した
  if p_refund_status = 'succeeded' then
    if v_row.status = 'refunded' then
      return jsonb_build_object('result', 'already_refunded', 'purchase_id', v_row.id);
    end if;

    if v_row.status not in ('paid', 'refund_pending') then
      return jsonb_build_object('result', 'not_refundable', 'status', v_row.status);
    end if;

    update public.billing_purchases p
       set status           = 'refunded',
           stripe_refund_id = coalesce(p_refund_id, p.stripe_refund_id),
           refunded_at      = now()
     where p.id = v_row.id;

    -- 権利を取り上げる。**行は消さない**
    update public.billing_entitlements e
       set revoked_at = now()
     where e.source_purchase_id = v_row.id
       and e.revoked_at is null;

    return jsonb_build_object(
      'result',         'refunded',
      'purchase_id',    v_row.id,
      'founder_number', v_row.founder_number
    );
  end if;

  -- 返金が失敗した／取り消された。**元の権利を維持する**
  if v_row.status = 'refund_pending' then
    update public.billing_purchases p
       set status              = 'paid',
           refund_requested_at = null
     where p.id = v_row.id;

    return jsonb_build_object('result', 'restored', 'purchase_id', v_row.id);
  end if;

  return jsonb_build_object('result', 'unchanged', 'status', v_row.status);
end;
$fn$;

comment on function public.billing_apply_refund_result(text, text, text) is
  '返金の結果を反映する。succeeded で権利を取り上げて枠を戻し、'
  'failed / canceled では元の権利を維持する。番号は再利用しない。';

revoke all on function public.billing_apply_refund_result(text, text, text)
  from public, anon, authenticated;
grant execute on function public.billing_apply_refund_result(text, text, text)
  to service_role;




-- ============================================================================
-- 13. 不審請求の申し立て（dispute）
-- ============================================================================
--
-- 【申し立て中は枠を押さえたまま】
--   結果が出るまでは、その人はまだ Founder。枠も番号もそのまま。
--   結果が運営側の勝ち（won / warning_closed）なら paid へ戻す。
--   利用者側の勝ち（lost）なら reversed にして権利を取り上げる。

create or replace function public.billing_mark_dispute(
  p_payment_intent_id text,
  p_dispute_status    text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_row public.billing_purchases%rowtype;
begin
  if p_dispute_status not in (
       'warning_needs_response', 'warning_under_review', 'warning_closed',
       'needs_response', 'under_review', 'won', 'lost', 'prevented') then
    raise exception 'DISPUTE_STATUS_UNKNOWN: 知らない申し立ての状態です（%）。',
      p_dispute_status;
  end if;

  select * into v_row
    from public.billing_purchases p
   where p.stripe_payment_intent_id = p_payment_intent_id
   for update;

  if not found then
    return jsonb_build_object('result', 'unknown_payment');
  end if;

  -- 決着した
  if p_dispute_status = 'lost' then
    if v_row.status = 'reversed' then
      return jsonb_build_object('result', 'already_reversed', 'purchase_id', v_row.id);
    end if;
    if v_row.status not in ('paid', 'refund_pending', 'disputed') then
      return jsonb_build_object('result', 'unchanged', 'status', v_row.status);
    end if;

    update public.billing_purchases p set status = 'reversed' where p.id = v_row.id;

    update public.billing_entitlements e
       set revoked_at = now()
     where e.source_purchase_id = v_row.id
       and e.revoked_at is null;

    return jsonb_build_object('result', 'reversed', 'purchase_id', v_row.id);
  end if;

  if p_dispute_status in ('won', 'warning_closed', 'prevented') then
    if v_row.status = 'disputed' then
      update public.billing_purchases p set status = 'paid' where p.id = v_row.id;
      return jsonb_build_object('result', 'restored', 'purchase_id', v_row.id);
    end if;
    return jsonb_build_object('result', 'unchanged', 'status', v_row.status);
  end if;

  -- まだ途中。paid の行だけを disputed にする（返金手続き中の行は触らない）
  if v_row.status = 'paid' then
    update public.billing_purchases p set status = 'disputed' where p.id = v_row.id;
    return jsonb_build_object('result', 'disputed', 'purchase_id', v_row.id);
  end if;

  return jsonb_build_object('result', 'unchanged', 'status', v_row.status);
end;
$fn$;

comment on function public.billing_mark_dispute(text, text) is
  '不審請求の申し立てを反映する。途中は disputed（枠は押さえたまま）、'
  'lost で reversed にして権利を取り上げ、won / warning_closed / prevented で paid へ戻す。';

revoke all on function public.billing_mark_dispute(text, text)
  from public, anon, authenticated;
grant execute on function public.billing_mark_dispute(text, text) to service_role;




-- ============================================================================
-- 14. Webhook の重複防止
-- ============================================================================
--
-- 【claim → 処理 → done の3手】
--   claim で行を1つ入れる。既にあれば false が返るので、そこで処理をやめる。
--   処理し終えたら done で processed_at を入れる。
--
-- 【なぜ claim と done を分けるか】
--   claim だけだと、処理の途中で落ちた合図も「済んだ」ことになる。
--   processed_at が空のまま残っていれば、あとから拾い直せる。

create or replace function public.billing_claim_webhook_event(
  p_event_id    text,
  p_event_type  text,
  p_object_id   text,
  p_livemode    boolean,
  p_created_at  timestamptz,
  p_api_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_inserted int;
  v_done     timestamptz;
begin
  insert into public.billing_webhook_events
    (stripe_event_id, event_type, object_id, livemode, stripe_created_at, api_version)
  values
    (p_event_id, p_event_type, p_object_id, coalesce(p_livemode, false), p_created_at,
     nullif(btrim(coalesce(p_api_version, '')), ''))
  on conflict (stripe_event_id) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 1 then
    return jsonb_build_object('claimed', true);
  end if;

  select w.processed_at into v_done
    from public.billing_webhook_events w
   where w.stripe_event_id = p_event_id;

  return jsonb_build_object(
    'claimed',      false,
    'processed_at', v_done
  );
end;
$fn$;

comment on function public.billing_claim_webhook_event(text, text, text, boolean, timestamptz, text) is
  'この合図を初めて受け取ったかを返す。2回目以降は claimed=false。';

revoke all on function public.billing_claim_webhook_event(text, text, text, boolean, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.billing_claim_webhook_event(text, text, text, boolean, timestamptz, text)
  to service_role;


create or replace function public.billing_finish_webhook_event(p_event_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  update public.billing_webhook_events w
     set processed_at = now()
   where w.stripe_event_id = p_event_id
     and w.processed_at is null;

  return jsonb_build_object('event_id', p_event_id);
end;
$fn$;

comment on function public.billing_finish_webhook_event(text) is
  'その合図を処理し終えたことを記録する。';

revoke all on function public.billing_finish_webhook_event(text)
  from public, anon, authenticated;
grant execute on function public.billing_finish_webhook_event(text) to service_role;




-- ============================================================================
-- 15. get_founder_offer_status ／ 残り枠と、自分の状態
-- ============================================================================
--
-- 【返さないもの】
--   決済ページの URL も ID も返さない。**あれは払える鍵なので、
--   買う操作をした本人へ、その場でだけ渡す。**
--   ここが返すのは「手続きの途中である」ことと、その期限まで。
--
-- 【誰でも呼べる】
--   残り枠は買う前に見えなければ意味が無い。ログインしていなければ
--   自分の状態（mine）は null になる。

create or replace function public.get_founder_offer_status(
  p_offer_code text default 'founding_creator_v0'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid     uuid := (select auth.uid());
  v_offer   public.billing_offers%rowtype;
  v_used    int;
  v_mine    jsonb := null;
  v_row     public.billing_purchases%rowtype;
  v_terms   text;
  v_privacy text;
  v_agreed  boolean := false;
begin
  select * into v_offer from public.billing_offers o where o.code = p_offer_code;
  if not found then
    return null;
  end if;

  v_used := public.billing_active_slots(v_offer.id);

  if v_uid is not null then
    select * into v_row
      from public.billing_purchases p
     where p.profile_id = v_uid
       and p.offer_id = v_offer.id
     order by
       case p.status
         when 'paid'           then 0
         when 'refund_pending' then 1
         when 'disputed'       then 2
         when 'reserved'       then 3
         else 4
       end,
       p.created_at desc
     limit 1;

    if found then
      v_mine := jsonb_build_object(
        'status',              v_row.status,
        'founder_number',      v_row.founder_number,
        'founder_public',      v_row.founder_public,
        'has_open_checkout',   (v_row.status = 'reserved'
                                and v_row.stripe_checkout_session_id is not null),
        'checkout_expires_at', case when v_row.status = 'reserved'
                                    then v_row.checkout_expires_at end,
        'paid_at',             v_row.paid_at
      );
    end if;
  end if;

  -- 【買う前に同意が要る（規約 13-6）ので、画面が案内できるように返す】
  --   **版そのものを返す。**画面が同意の form に載せる値で、
  --   agree_to_documents が「いま有効な版か」をもう一度確かめる。
  select tv.version into v_terms   from public.terms_versions   tv where tv.is_current;
  select pv.version into v_privacy from public.privacy_versions pv where pv.is_current;

  if v_uid is not null then
    v_agreed :=
      (v_terms is null or exists (
         select 1 from public.terms_agreements ta
          where ta.user_id = v_uid and ta.doc_kind = 'terms' and ta.version = v_terms))
      and
      (v_privacy is null or exists (
         select 1 from public.terms_agreements ta
          where ta.user_id = v_uid and ta.doc_kind = 'privacy' and ta.version = v_privacy));
  end if;

  return jsonb_build_object(
    'code',       v_offer.code,
    'name',       v_offer.name,
    'amount',     v_offer.amount,
    'currency',   v_offer.currency,
    'sales_cap',  v_offer.sales_cap,
    'used',       v_used,
    'remaining',  case when v_offer.sales_cap is null
                       then null
                       else greatest(v_offer.sales_cap - v_used, 0) end,
    'sold_out',   (v_offer.sales_cap is not null and v_used >= v_offer.sales_cap),
    'is_open',    public.billing_offer_is_open(v_offer),
    'starts_at',  v_offer.starts_at,
    'ends_at',    v_offer.ends_at,
    'signed_in',  (v_uid is not null),
    'terms_version',   v_terms,
    'privacy_version', v_privacy,
    'agreed',          v_agreed,
    'mine',       v_mine
  );
end;
$fn$;

comment on function public.get_founder_offer_status(text) is
  'Founder の残り枠と、いまの人の購入状態。決済ページの ID も URL も返さない。';

revoke all on function public.get_founder_offer_status(text)
  from public, anon, authenticated;
grant execute on function public.get_founder_offer_status(text)
  to anon, authenticated;




-- ============================================================================
-- 16. list_founders ／ Founder 一覧
-- ============================================================================
--
-- 【表そのものを配らない】
--   ブラウザへ渡すのは、番号と、出してよい表示名だけ。
--   金額・決済 ID・購入日時・profile_id は1つも返さない。
--
-- 【3つの見え方】
--   公開      #001 表示名（プロフィールへの入口つき）
--   非公開    #002 匿名希望
--   返金済み  #003 欠番
--
--   匿名希望の人も一覧から消さない。**番号と位置は残る。**
--   欠番と匿名希望は別の意味なので、同じ書き方にしない。
--
-- 【退会した人】
--   profile_id が外れていて名前が引けない。名前を出しようが無いので
--   匿名希望と同じ見え方にする（欠番にはしない。権利は生きているため）。

create or replace function public.list_founders(
  p_offer_code text default 'founding_creator_v0'
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(x.row order by x.founder_number), '[]'::jsonb)
    from (
      select
        p.founder_number,
        jsonb_build_object(
          'founder_number', p.founder_number,
          'kind', case
                    when p.status in ('refunded', 'reversed') then 'void'
                    when p.founder_public
                         and pr.id is not null
                         and pr.is_anonymous = false
                         and pr.handle is not null then 'public'
                    else 'anonymous'
                  end,
          'display_name', case
                            when p.status not in ('refunded', 'reversed')
                                 and p.founder_public
                                 and pr.id is not null
                                 and pr.is_anonymous = false
                                 and pr.handle is not null
                            then pr.display_name
                          end,
          'handle', case
                      when p.status not in ('refunded', 'reversed')
                           and p.founder_public
                           and pr.id is not null
                           and pr.is_anonymous = false
                           and pr.handle is not null
                      then pr.handle
                    end
        ) as row
        from public.billing_purchases p
        join public.billing_offers o on o.id = p.offer_id
        left join public.profiles pr on pr.id = p.profile_id
       where o.code = p_offer_code
         and p.founder_number is not null
    ) x;
$fn$;

comment on function public.list_founders(text) is
  'Founder 一覧。番号順。公開／匿名希望／欠番の3つの見え方だけを返す。'
  '金額・決済 ID・profile_id は返さない。';

revoke all on function public.list_founders(text)
  from public, anon, authenticated;
grant execute on function public.list_founders(text) to anon, authenticated;




-- ============================================================================
-- 17. get_founder_badge ／ プロフィールに出す番号
-- ============================================================================
--
-- 【なぜ get_public_profile を書き換えないか】
--   あの関数は作品・回答・統計を1本で返す既存の中心で、
--   課金の都合で書き換えると、課金を戻すときにあの関数まで戻すことになる。
--   **足すのは別の1本にして、画面の側で並べる。**
--
-- 【作品カードや回答欄には出さない】
--   出す場所を増やすと「払った人が目立つ」体験になる。v0 はプロフィールだけ。

create or replace function public.get_founder_badge(p_profile_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'founder_number', p.founder_number,
    'offer_code',     o.code
  )
  from public.billing_purchases p
  join public.billing_offers o on o.id = p.offer_id
  where p.profile_id = p_profile_id
    and p.founder_number is not null
    and p.founder_public
    and p.status in ('paid', 'refund_pending', 'disputed')
  order by p.founder_number
  limit 1;
$fn$;

comment on function public.get_founder_badge(uuid) is
  'その人のプロフィールに出す Founder 番号。公開設定が入で、権利が生きているときだけ返す。';

revoke all on function public.get_founder_badge(uuid)
  from public, anon, authenticated;
grant execute on function public.get_founder_badge(uuid) to anon, authenticated;




-- ============================================================================
-- 18. set_my_founder_visibility ／ 名前を出すかどうか
-- ============================================================================
--
-- 【本人しか変えられない】
--   誰の設定かを引数で受け取らない。**auth.uid() が唯一の宛先。**
--   購入の ID も Founder 番号も受け取らないので、
--   ブラウザから他人を指す方法が無い。

create or replace function public.set_my_founder_visibility(p_public boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row public.billing_purchases%rowtype;
begin
  if v_uid is null then
    raise exception 'SIGN_IN_REQUIRED: ログインが必要です。';
  end if;

  if p_public is null then
    raise exception 'INVALID_INPUT: 公開するかどうかが指定されていません。';
  end if;

  update public.billing_purchases p
     set founder_public = p_public
   where p.profile_id = v_uid
     and p.founder_number is not null
     and p.status in ('paid', 'refund_pending', 'disputed')
  returning * into v_row;

  if not found then
    raise exception 'NOT_A_FOUNDER: この操作を行える購入がありません。';
  end if;

  return jsonb_build_object(
    'founder_number', v_row.founder_number,
    'founder_public', v_row.founder_public
  );
end;
$fn$;

comment on function public.set_my_founder_visibility(boolean) is
  'Founder の名前を一覧とプロフィールに出すかを切り替える。本人の行だけを動かす。';

revoke all on function public.set_my_founder_visibility(boolean)
  from public, anon, authenticated;
grant execute on function public.set_my_founder_visibility(boolean) to authenticated;




-- ============================================================================
-- 19. get_my_entitlements ／ いま自分は何ができるか
-- ============================================================================
--
-- 商品名ではなく権限の鍵を返す。画面はこの配列に鍵が入っているかだけを見る。

create or replace function public.get_my_entitlements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(jsonb_agg(distinct e.entitlement_key), '[]'::jsonb)
    from public.billing_entitlements e
   where e.profile_id = (select auth.uid())
     and e.revoked_at is null
     and e.starts_at <= now()
     and (e.ends_at is null or e.ends_at > now());
$fn$;

comment on function public.get_my_entitlements() is
  'いま生きている自分の権限の鍵の一覧。取り消し済みと期限切れは入らない。';

revoke all on function public.get_my_entitlements()
  from public, anon, authenticated;
grant execute on function public.get_my_entitlements() to authenticated;




-- ============================================================================
-- 20. billing_reassign_purchase ／ 購入を別のアカウントへ結び直す
-- ============================================================================
--
-- 【何のためにあるか】
--   Founder 権は永続する。ところがアカウントのほうは、
--   メールアドレスの変更、ログインの事故、端末の紛失などで
--   実質的に入れなくなることがある。
--   **買った権利を、アカウントの事故で永久に失わせない。**
--
-- 【譲渡ではない】
--   他人への譲渡・売買は認めない。使うのは、
--   運営が本人だと確かめられたときの結び直しだけ。
--   だから利用者からは呼べず、理由を必ず書かせる。
--
-- 【何を動かして、何を動かさないか】
--   動かす   … 購入の profile_id と、権限の宛先
--   動かさない … Founder 番号・金額・支払いの ID・Stripe の顧客
--   番号を動かすと一覧の並びが変わる。**買った順という事実は動かない。**
--   Stripe の顧客は帳簿の側なので、そのまま残す。
--
-- 【古いほうの権限は消さずに取り消す】
--   返金のときと同じ。行を消すと「昔は持っていた」が追えなくなる。
--
-- 【記録は既存の監査記録に残す】
--   運営が行う危険な書き込みは admin_audit_log が持っている（D177）。
--   課金のためにもう1つ記録の表を作らない。**記録が2か所に割れると、
--   運営が何をしたかを1か所で追えなくなる。**
--   そのために、あの表が受け付ける操作と対象を1つずつ増やす。
--
-- 【なぜ「表があれば」で包むか】
--   admin_audit_log を作るのは管理 v0 の migration（D177）で、課金とは
--   別の作業線にある。**課金だけを先に当てられる状態を保つ**ため、
--   ここでは表があるときだけ CHECK を広げる。
--   表が無いまま結び直しを呼んだときは、記録が残せないので断る
--   （下の billing_reassign_purchase を見ること）。
--   **記録を残せない運営操作を、黙って通さない。**

do $$
begin
  if to_regclass('public.admin_audit_log') is null then
    return;
  end if;

  execute $q$
    alter table public.admin_audit_log
      drop constraint if exists admin_audit_log_action_valid
  $q$;
  execute $q$
    alter table public.admin_audit_log
      add constraint admin_audit_log_action_valid check (
        action in ('hide_work', 'resolve_report', 'reject_report', 'reassign_purchase')
      )
  $q$;

  execute $q$
    alter table public.admin_audit_log
      drop constraint if exists admin_audit_log_target_type_valid
  $q$;
  execute $q$
    alter table public.admin_audit_log
      add constraint admin_audit_log_target_type_valid check (
        target_type in ('work', 'report', 'purchase')
      )
  $q$;

  execute $q$
    alter table public.admin_audit_log
      drop constraint if exists admin_audit_log_action_matches_target
  $q$;
  execute $q$
    alter table public.admin_audit_log
      add constraint admin_audit_log_action_matches_target check (
        (action = 'hide_work'      and target_type = 'work')
        or
        (action in ('resolve_report', 'reject_report') and target_type = 'report')
        or
        (action = 'reassign_purchase' and target_type = 'purchase')
      )
  $q$;
end $$;


create or replace function public.billing_reassign_purchase(
  p_admin_user_id  uuid,
  p_purchase_id    uuid,
  p_new_profile_id uuid,
  p_reason         text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_reason   text := btrim(coalesce(p_reason, ''));
  v_purchase public.billing_purchases%rowtype;
  v_target   public.profiles%rowtype;
  v_old      uuid;
begin
  if p_admin_user_id is null then
    raise exception 'ADMIN_REQUIRED: 操作した運営の ID がありません。';
  end if;

  if char_length(v_reason) = 0 then
    raise exception 'REASON_REQUIRED: 理由を書いてください。';
  end if;
  if char_length(v_reason) > 1000 then
    raise exception 'REASON_TOO_LONG: 理由は1000字までです（いま %字）。',
      char_length(v_reason);
  end if;

  select * into v_purchase
    from public.billing_purchases p
   where p.id = p_purchase_id
   for update;

  if not found then
    raise exception 'PURCHASE_NOT_FOUND: その購入が見つかりません（%）。', p_purchase_id;
  end if;

  -- 取り消し済み・失効済みの購入は結び直さない。**戻す権利が無い**
  if v_purchase.status not in ('paid', 'refund_pending', 'disputed') then
    raise exception
      'PURCHASE_NOT_LIVE: その購入はいま有効ではありません（%）。', v_purchase.status;
  end if;

  select * into v_target from public.profiles p where p.id = p_new_profile_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND: 移す先のアカウントが見つかりません。';
  end if;
  if v_target.is_anonymous then
    raise exception 'ACCOUNT_NOT_ELIGIBLE: ゲストへは移せません。';
  end if;
  if v_target.account_status <> 'active' then
    raise exception 'ACCOUNT_NOT_ELIGIBLE: 退会の手続き中のアカウントへは移せません。';
  end if;

  if v_purchase.profile_id = p_new_profile_id then
    raise exception 'ALREADY_LINKED: すでにそのアカウントに結び付いています。';
  end if;

  -- 移す先が、同じ商品をすでに持っていたら移さない。
  -- **1人が2つの Founder 権を持つ形を作らない**（部分一意索引も同じことを言う）
  if exists (
    select 1 from public.billing_purchases p
     where p.profile_id = p_new_profile_id
       and p.offer_id = v_purchase.offer_id
       and p.status in ('reserved', 'paid', 'refund_pending', 'disputed')
  ) then
    raise exception 'ALREADY_OWNED: 移す先のアカウントは、すでにこの商品を持っています。';
  end if;

  v_old := v_purchase.profile_id;

  update public.billing_purchases p
     set profile_id = p_new_profile_id
   where p.id = v_purchase.id;

  -- 古いほうの権限を取り消す（行は消さない）
  update public.billing_entitlements e
     set revoked_at = now()
   where e.source_purchase_id = v_purchase.id
     and e.revoked_at is null;

  -- 新しいほうへ同じ権限を出し直す
  insert into public.billing_entitlements
    (profile_id, entitlement_key, source_purchase_id)
  values
    (p_new_profile_id, 'founding_creator', v_purchase.id),
    (p_new_profile_id, 'beta_access',      v_purchase.id)
  on conflict (profile_id, entitlement_key, source_purchase_id)
    do update set revoked_at = null, starts_at = now();

  -- 記録が残せないなら結び直さない。**運営の操作を無記録で通さない。**
  -- （admin_audit_log は管理 v0 の migration が作る。まだ当たっていない環境では
  --   ここで止まる。権利は動いていない＝取引ごと巻き戻る。）
  if to_regclass('public.admin_audit_log') is null then
    raise exception
      'AUDIT_LOG_MISSING: 監査記録の表がありません。記録を残せないので結び直しはしません。';
  end if;

  insert into public.admin_audit_log
    (admin_user_id, action, target_type, target_id, old_value, new_value, reason)
  values
    (p_admin_user_id, 'reassign_purchase', 'purchase',
     v_purchase.id::text,
     coalesce(v_old::text, '(なし)'),
     p_new_profile_id::text,
     v_reason);

  return jsonb_build_object(
    'purchase_id',    v_purchase.id,
    'founder_number', v_purchase.founder_number,
    'from_profile',   v_old,
    'to_profile',     p_new_profile_id
  );
end;
$fn$;

comment on function public.billing_reassign_purchase(uuid, uuid, uuid, text) is
  '購入を別のアカウントへ結び直す（運営専用）。譲渡ではなく、本人確認できた事故の救済。'
  'Founder 番号・金額・支払いの記録は動かさない。理由は必須で、監査記録に残る。';

revoke all on function public.billing_reassign_purchase(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.billing_reassign_purchase(uuid, uuid, uuid, text)
  to service_role;
