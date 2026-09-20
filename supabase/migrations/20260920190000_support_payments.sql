-- 自由額の単発支援。Founder の購入・番号・権利とは別の記録にする。
-- 決済を確定する関数は service_role 専用。anon/authenticated に表権限を渡さない。

create table public.billing_support_payments (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete set null,
  stripe_checkout_session_id text unique
    check (stripe_checkout_session_id is null or stripe_checkout_session_id ~ '^cs_[A-Za-z0-9_]{1,240}$'),
  stripe_payment_intent_id text unique
    check (stripe_payment_intent_id is null or stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,240}$'),
  amount integer not null check (amount between 500 and 100000),
  currency text not null default 'jpy' check (currency = 'jpy'),
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'refund_pending', 'refunded', 'disputed', 'reversed', 'expired')),
  source text not null check (source in
    ('footer', 'account', 'founder', 'founder_soldout', 'support_page', 'campaign', 'direct')),
  refunded_amount integer not null default 0
    check (refunded_amount >= 0 and refunded_amount <= amount),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint billing_support_paid_clock check (
    (status in ('pending', 'expired') and paid_at is null)
    or (status not in ('pending', 'expired') and paid_at is not null)
  ),
  constraint billing_support_refund_clock check (
    (status = 'refunded' and refunded_at is not null)
    or (status <> 'refunded' and refunded_at is null)
  )
);

create index billing_support_source_paid_idx
  on public.billing_support_payments (source, paid_at)
  where status = 'paid';
create index billing_support_profile_idx
  on public.billing_support_payments (profile_id, created_at desc)
  where profile_id is not null;
create trigger billing_support_touch_updated_at
  before update on public.billing_support_payments
  for each row execute function public.app_billing_touch_updated_at();
alter table public.billing_support_payments enable row level security;
revoke all on public.billing_support_payments from public, anon, authenticated;

-- 返金 ID ごとに最終状態を持つ。再送と部分返金で二重計上しない。
create table public.billing_support_refunds (
  stripe_refund_id text primary key
    check (stripe_refund_id ~ '^re_[A-Za-z0-9_]{1,240}$'),
  support_payment_id uuid not null references public.billing_support_payments(id) on delete restrict,
  amount integer not null check (amount > 0),
  status text not null check (status in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index billing_support_refunds_payment_idx
  on public.billing_support_refunds (support_payment_id);
create trigger billing_support_refunds_touch_updated_at
  before update on public.billing_support_refunds
  for each row execute function public.app_billing_touch_updated_at();
alter table public.billing_support_refunds enable row level security;
revoke all on public.billing_support_refunds from public, anon, authenticated;

create function public.billing_support_start(
  p_profile_id uuid, p_amount integer, p_source text
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  if p_amount is null or p_amount not between 500 and 100000 then
    raise exception 'SUPPORT_AMOUNT_INVALID';
  end if;
  if p_source is null or p_source not in
     ('footer', 'account', 'founder', 'founder_soldout', 'support_page', 'campaign', 'direct') then
    raise exception 'SUPPORT_SOURCE_INVALID';
  end if;
  insert into public.billing_support_payments (profile_id, amount, source)
  values (p_profile_id, p_amount, p_source) returning id into v_id;
  return jsonb_build_object('id', v_id, 'amount', p_amount, 'source', p_source);
end;
$fn$;
revoke all on function public.billing_support_start(uuid, integer, text) from public, anon, authenticated;
grant execute on function public.billing_support_start(uuid, integer, text) to service_role;

create function public.billing_support_attach(p_id uuid, p_session_id text)
returns void language plpgsql security definer set search_path = '' as $fn$
begin
  update public.billing_support_payments
     set stripe_checkout_session_id = p_session_id
   where id = p_id and status = 'pending' and stripe_checkout_session_id is null;
  if not found then raise exception 'SUPPORT_NOT_PENDING'; end if;
end;
$fn$;
revoke all on function public.billing_support_attach(uuid, text) from public, anon, authenticated;
grant execute on function public.billing_support_attach(uuid, text) to service_role;

-- 成功 URL はこの関数を呼べない。署名済み Webhook だけが使う。
create function public.billing_support_complete(
  p_session_id text, p_support_id uuid, p_mode text, p_payment_status text,
  p_amount integer, p_currency text, p_payment_intent_id text
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_row public.billing_support_payments%rowtype;
begin
  select * into v_row from public.billing_support_payments
   where stripe_checkout_session_id = p_session_id for update;
  if not found or p_support_id is distinct from v_row.id then
    raise exception 'SUPPORT_SESSION_MISMATCH';
  end if;
  if p_mode is distinct from 'payment' or p_payment_status is distinct from 'paid'
     or p_amount is distinct from v_row.amount or p_currency is distinct from 'jpy'
     or p_payment_intent_id is null then
    raise exception 'SUPPORT_PAYMENT_MISMATCH';
  end if;
  if v_row.stripe_payment_intent_id is not null
     and v_row.stripe_payment_intent_id is distinct from p_payment_intent_id then
    raise exception 'SUPPORT_INTENT_MISMATCH';
  end if;
  if v_row.status in ('pending', 'expired') then
    update public.billing_support_payments
       set status = 'paid', paid_at = now(),
           stripe_payment_intent_id = p_payment_intent_id
     where id = v_row.id;
  end if;
  return jsonb_build_object('id', v_row.id, 'result', 'recorded');
end;
$fn$;
revoke all on function public.billing_support_complete(text, uuid, text, text, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.billing_support_complete(text, uuid, text, text, integer, text, text)
  to service_role;

create function public.billing_support_expire(p_session_id text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_id uuid;
begin
  update public.billing_support_payments
     set status = 'expired'
   where stripe_checkout_session_id = p_session_id and status = 'pending'
   returning id into v_id;
  return jsonb_build_object('expired', v_id is not null);
end;
$fn$;
revoke all on function public.billing_support_expire(text) from public, anon, authenticated;
grant execute on function public.billing_support_expire(text) to service_role;

-- handled=false なら Founder 側の支払いとして処理する。
create function public.billing_support_refund(
  p_payment_intent_id text, p_refund_id text, p_amount integer, p_status text
) returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  v_row public.billing_support_payments%rowtype;
  v_refunded integer;
  v_pending boolean;
  v_status text;
begin
  select * into v_row from public.billing_support_payments
   where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then return jsonb_build_object('handled', false); end if;
  if p_refund_id is null or p_amount is null or p_amount < 1 or p_amount > v_row.amount
     or p_status not in ('pending', 'requires_action', 'succeeded', 'failed', 'canceled') then
    raise exception 'SUPPORT_REFUND_MISMATCH';
  end if;
  insert into public.billing_support_refunds
    (stripe_refund_id, support_payment_id, amount, status)
  values (p_refund_id, v_row.id, p_amount, p_status)
  on conflict (stripe_refund_id) do update
    set status = case when public.billing_support_refunds.status = 'succeeded'
                      then 'succeeded' else excluded.status end
  where public.billing_support_refunds.support_payment_id = excluded.support_payment_id
    and public.billing_support_refunds.amount = excluded.amount;
  if not found then raise exception 'SUPPORT_REFUND_MISMATCH'; end if;
  select coalesce(sum(r.amount) filter (where r.status = 'succeeded'), 0)::int,
         coalesce(bool_or(r.status in ('pending', 'requires_action')), false)
    into v_refunded, v_pending
    from public.billing_support_refunds r where r.support_payment_id = v_row.id;
  if v_refunded > v_row.amount then raise exception 'SUPPORT_REFUND_OVERFLOW'; end if;
  v_status := case when v_row.status = 'reversed' then 'reversed'
                   when v_refunded = v_row.amount then 'refunded'
                   when v_row.status = 'disputed' then 'disputed'
                   when v_pending then 'refund_pending'
                   else 'paid' end;
  update public.billing_support_payments
     set refunded_amount = v_refunded,
         status = v_status,
         refunded_at = case when v_status = 'refunded'
                            then coalesce(refunded_at, now()) else null end
   where id = v_row.id;
  return jsonb_build_object('handled', true, 'status', v_status);
end;
$fn$;
revoke all on function public.billing_support_refund(text, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.billing_support_refund(text, text, integer, text) to service_role;

create function public.billing_support_dispute(p_payment_intent_id text, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare v_row public.billing_support_payments%rowtype; v_status text; v_pending boolean;
begin
  if p_status not in ('warning_needs_response', 'warning_under_review', 'warning_closed',
    'needs_response', 'under_review', 'won', 'lost', 'prevented') then
    raise exception 'SUPPORT_DISPUTE_STATUS_UNKNOWN';
  end if;
  select * into v_row from public.billing_support_payments
   where stripe_payment_intent_id = p_payment_intent_id for update;
  if not found then return jsonb_build_object('handled', false); end if;
  select coalesce(bool_or(status in ('pending', 'requires_action')), false) into v_pending
    from public.billing_support_refunds where support_payment_id = v_row.id;
  v_status := case when v_row.status in ('refunded', 'reversed') then v_row.status
                   when p_status = 'lost' then 'reversed'
                   when p_status in ('won', 'warning_closed', 'prevented')
                     then case when v_pending then 'refund_pending' else 'paid' end
                   else 'disputed' end;
  update public.billing_support_payments set status = v_status where id = v_row.id;
  return jsonb_build_object('handled', true, 'status', v_status);
end;
$fn$;
revoke all on function public.billing_support_dispute(text, text) from public, anon, authenticated;
grant execute on function public.billing_support_dispute(text, text) to service_role;

-- Checkout の高エントロピー ID を持つ人に、支払いの確定状態だけ返す。
-- 呼び出し自体は service_role に閉じ、画面経由で余計な情報を出さない。
create function public.billing_support_status(p_session_id text)
returns text language sql stable security definer set search_path = '' as $fn$
  select status from public.billing_support_payments
   where stripe_checkout_session_id = p_session_id;
$fn$;
revoke all on function public.billing_support_status(text) from public, anon, authenticated;
grant execute on function public.billing_support_status(text) to service_role;

-- 運営用。決済成立済みで、返金・異議申し立てを除いた数字だけを売上に数える。
create function public.billing_revenue_summary()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object(
    'founder_sales', (select count(*) from public.billing_purchases where status = 'paid'),
    'founder_revenue', (select coalesce(sum(amount), 0) from public.billing_purchases where status = 'paid'),
    'founder_remaining', (select greatest(o.sales_cap - public.billing_active_slots(o.id), 0)
      from public.billing_offers o where o.code = 'founding_creator_v0'),
    'support_count', (select count(*) from public.billing_support_payments where status = 'paid'),
    'support_revenue', (select coalesce(sum(amount - refunded_amount), 0)
      from public.billing_support_payments where status = 'paid'),
    'support_average', (select coalesce(round(avg(amount - refunded_amount)), 0)
      from public.billing_support_payments where status = 'paid'),
    'support_refunded', (select coalesce(sum(amount), 0) from public.billing_support_refunds
      where status = 'succeeded'),
    'support_by_source', (select coalesce(jsonb_object_agg(source, totals), '{}'::jsonb)
      from (select source, jsonb_build_object('count', count(*),
             'amount', sum(amount - refunded_amount)) as totals
            from public.billing_support_payments where status = 'paid'
           group by source) s)
  );
$fn$;
revoke all on function public.billing_revenue_summary() from public, anon, authenticated;
grant execute on function public.billing_revenue_summary() to service_role;
