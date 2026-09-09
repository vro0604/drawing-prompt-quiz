-- ============================================================================
-- 回答の取り込み枠（P4）
-- ============================================================================
--
-- 【この migration が足すもの】
--   表を4つと、関数を8本、`answers` への引き金を1つ。
--   既存の表の列は1つも足さず、過去のデータを1行も書き換えない。
--
--     public.work_import_state        …… 作品ごとの取り込みの状態（錠を取る行）
--     public.work_capacity_grants     …… 枠を増やした記録（台帳）
--     public.analysis_imports         …… 取り込んだ回答
--     public.capacity_notifications   …… 残量の目盛りをまたいだ記録
--
-- 【何のための仕掛けか】
--   作品ごとに「高度な分析へ回せる回答の数」を持つ。回答そのものは今までどおり
--   全部保存され、無料の集計にも全部が入る。取り込み枠が要るのは、
--   区画を押して掘り下げる側だけ。
--
-- 【お金の受け取りはここに無い】
--   決済業者も金額もパックの件数も決まっていないので、購入の経路は作っていない。
--   枠を増やす関数（grant_import_capacity）は運営の鍵でしか呼べない。
--   将来、支払いが済んだ知らせを受け取る場所からこの関数を呼べばつながる。
--
-- 【既に動いている作品への影響】
--   表を足すだけなので、いまある作品の枠は0、いまある回答は未取り込み、
--   自動取り込みは切、から始まる。**知らないうちに枠が減ることはない。**
--   無料の集計は今までどおり全部の回答で出る。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 作品ごとの取り込みの状態
-- ----------------------------------------------------------------------------
--
-- 【この表が錠になる】
--   枠を消費するときは、必ずこの行を `for update` で押さえてから数える。
--   同じ作品へ回答が同時に2件届いても、片方がこの行を待つので、
--   残り1枠を2件で使ってしまうことが起きない。
--
-- 【残量をここに持たない】
--   残量 ＝ 台帳の合計 − 取り込んだ件数。どちらも別の表を数えれば出る。
--   ここに数を持つと、台帳と食い違ったときにどちらが正しいか分からなくなる。
--   数えるのは索引が効くので、この規模では速い（P4 の実測を参照）。
--
-- 【epoch（枠の世代）が要る理由】
--   残量が2割・5割…を切ったときの知らせは、同じ目盛りで何度も送らない。
--   ただし枠を買い足したら、また送れるようになってほしい。
--   そこで枠を足すたびに世代を1つ進め、知らせの記録を世代ごとに持つ。
--   世代が変われば、同じ目盛りでもう一度送れる。

create table if not exists public.work_import_state (
  work_id uuid primary key
    references public.works (id) on delete restrict on update restrict,

  -- 新しい回答が来たら自動で取り込むか。**既定は切**（2026-09-09 の暫定）
  auto_import boolean not null default false,

  -- 枠の世代。枠を足すたびに1つ進む
  epoch int not null default 0
    constraint work_import_state_epoch_positive check (epoch >= 0),

  -- いまの世代が始まったときの残量。割合の分母になる
  epoch_base int not null default 0
    constraint work_import_state_base_positive check (epoch_base >= 0),

  updated_at timestamptz not null default now()
);

comment on table public.work_import_state is
  '作品ごとの取り込みの状態【作者限定】。枠を消費するときの錠でもある。'
  '残量は持たない（台帳の合計から取り込んだ件数を引いて出す）。';
comment on column public.work_import_state.epoch is
  '枠の世代。枠を足すと1つ進み、残量の知らせがもう一度送れるようになる。';
comment on column public.work_import_state.epoch_base is
  'いまの世代が始まった時点の残量。「残り2割」の分母。';

alter table public.work_import_state enable row level security;


-- ----------------------------------------------------------------------------
-- 2. 枠を増やした記録（台帳）
-- ----------------------------------------------------------------------------
--
-- 【なぜ数を足すだけにしないか】
--   「いま枠が130ある」だけでは、なぜ130なのかが追えない。
--   支払いで増えたのか、運営が足したのか、試験で足したのか。
--   後から数が合わないと分かったとき、直しようがない。
--
-- 【作品の行を消せなくする】
--   work_id は `on delete restrict`。作品の行を消そうとすると、
--   この台帳が残っているせいで消せない。**それが狙い。**
--   買った記録が作品の削除で消えると、支払いの証跡が無くなる。
--   いまのところ作品の行を物理的に消す経路はどこにも無い（実測）が、
--   将来足されたときに、この台帳が止める側に立つ。
--
-- 【誰に付与したか】
--   付与した時点の作者。退会すると null になる（他の表と同じ扱い）。
--   誰の分だったか分からなくなっても、どの作品の枠かは残る。

create table if not exists public.work_capacity_grants (
  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete restrict on update restrict,

  granted_to uuid
    references public.profiles (id) on delete set null on update restrict,

  quantity int not null
    constraint work_capacity_grants_quantity_positive check (quantity > 0),

  -- どこから来た枠か
  source_type text not null
    constraint work_capacity_grants_source_valid check (
      source_type in ('checkout', 'admin', 'promotion', 'test')
    ),

  -- 支払いの控え番号など。無いこともある
  source_ref text
    constraint work_capacity_grants_ref_length check (
      source_ref is null or char_length(source_ref) <= 200
    ),

  created_at timestamptz not null default now()
);

comment on table public.work_capacity_grants is
  '取り込み枠を増やした記録【作者と運営限定】。残量はこの合計から出す。'
  '作品の行を消せなくする（支払いの証跡を作品の削除で失わないため）。';

create index if not exists work_capacity_grants_work_idx
  on public.work_capacity_grants (work_id, created_at);

alter table public.work_capacity_grants enable row level security;


-- ----------------------------------------------------------------------------
-- 3. 取り込んだ回答
-- ----------------------------------------------------------------------------
--
-- 【回答そのものに印を付けない】
--   回答は回答。取り込みは作者側の分析の都合。分析から外すこと（P3）とも別。
--   3つを1つの列で表すと、あとで «外したから枠が戻るのか» のような
--   混ざった問いが出てくる。表を分けておけば、答えは「別の話」で済む。
--
-- 【同じ回答を二度取り込まない】
--   answer_id を主キーにしてある。二度目の取り込みは主キーで弾かれるので、
--   同じ回答で枠が2つ減ることはない。

create table if not exists public.analysis_imports (
  answer_id bigint primary key
    references public.answers (id) on delete cascade on update restrict,

  work_id uuid not null
    references public.works (id) on delete restrict on update restrict,

  imported_at timestamptz not null default now(),

  -- どの操作で取り込まれたか
  source text not null default 'manual'
    constraint analysis_imports_source_valid check (
      source in ('auto', 'manual', 'backfill')
    )
);

comment on table public.analysis_imports is
  '高度な分析へ回すために取り込んだ回答【作者限定】。1件＝枠1つ。'
  '回答そのものにも、分析から外したかにも触れない別の概念。';

create index if not exists analysis_imports_work_idx
  on public.analysis_imports (work_id, imported_at);

alter table public.analysis_imports enable row level security;


-- ----------------------------------------------------------------------------
-- 4. 残量の目盛りをまたいだ記録
-- ----------------------------------------------------------------------------
--
-- 世代と目盛りの組で1件だけ。同じ目盛りで何度も知らせない。
-- 枠を足すと世代が進むので、そこからまた知らせられる。

create table if not exists public.capacity_notifications (
  id bigint generated always as identity primary key,

  work_id uuid not null
    references public.works (id) on delete restrict on update restrict,

  -- 知らせる相手（作品の作者）。退会すると null
  user_id uuid
    references public.profiles (id) on delete set null on update restrict,

  kind text not null
    constraint capacity_notifications_kind_valid check (
      kind in ('remaining_20', 'remaining_5', 'exhausted')
    ),

  epoch int not null,

  -- そのときの残量と、割合の分母
  remaining_at_event int not null,
  base_at_event int not null,

  created_at timestamptz not null default now(),

  -- **メールを送れた時刻。**いまは送る仕組みが無いので必ず null のまま。
  -- 送る仕組みができたら、送れた時点でここに時刻が入る
  email_sent_at timestamptz,

  constraint capacity_notifications_once
    unique (work_id, epoch, kind)
);

comment on table public.capacity_notifications is
  '取り込み枠の残量が目盛りを下回ったことの記録【作者限定】。'
  '世代と目盛りの組で1件だけ。枠を足すと世代が進み、また知らせられる。';
comment on column public.capacity_notifications.email_sent_at is
  'メールを送れた時刻。アプリからメールを送る仕組みがまだ無いので、いまは常に null。';

create index if not exists capacity_notifications_work_idx
  on public.capacity_notifications (work_id, created_at desc);

alter table public.capacity_notifications enable row level security;


-- ----------------------------------------------------------------------------
-- 5. 数え方（内部用）
-- ----------------------------------------------------------------------------

/**
 * その作品の枠の合計。台帳を足すだけ。
 */
create or replace function public.work_granted_capacity(p_work_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(sum(g.quantity), 0)::int
    from public.work_capacity_grants g
   where g.work_id = p_work_id;
$fn$;

revoke all on function public.work_granted_capacity(uuid) from public, anon, authenticated;

/**
 * その作品で取り込み済みの回答の数。
 */
create or replace function public.work_imported_count(p_work_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $fn$
  select count(*)::int
    from public.analysis_imports i
   where i.work_id = p_work_id;
$fn$;

revoke all on function public.work_imported_count(uuid) from public, anon, authenticated;

/**
 * 残り枠。台帳の合計 − 取り込み済み。
 *
 * **負にならない。**負になったら消費の側が壊れているので、
 * 0 で止めずにそのまま出す（隠すと気づけない）。ここでは計算だけする。
 */
create or replace function public.work_remaining_capacity(p_work_id uuid)
returns int
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.work_granted_capacity(p_work_id) - public.work_imported_count(p_work_id);
$fn$;

revoke all on function public.work_remaining_capacity(uuid) from public, anon, authenticated;

/**
 * 状態の行を作って返す（無ければ作る）。**必ずここを通してから錠を取る。**
 */
create or replace function public.ensure_work_import_state(p_work_id uuid)
returns void
language sql
security definer
set search_path = ''
as $fn$
  insert into public.work_import_state (work_id)
  values (p_work_id)
  on conflict (work_id) do nothing;
$fn$;

revoke all on function public.ensure_work_import_state(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. 残量の目盛りをまたいだかを見て、記録する（内部用）
-- ----------------------------------------------------------------------------
--
-- 【割合の分母】
--   いまの世代が始まったときの残量（epoch_base）。
--   枠を足した直後の残量がそれになる。
--
--   例。枠を100足したときに残り0だったなら分母は100。
--   79件取り込んで残り21。もう1件取り込んで20になった時点で
--   20 ÷ 100 = 2割なので「残り2割」を1回だけ知らせる。
--   さらに10件取り込んで10になっても、5%（＝5件）にはまだ届かない。
--   そこへ枠を100足すと残り110で世代が進み、分母は110になる。
--   そこからまた2割（22件）と5%（5.5件）で知らせられる。
--
-- 【またいだ目盛りは全部記録する】
--   まとめて取り込むと、1回の操作で2割と5%を同時に下回ることがある。
--   そのときは2件記録する。世代と目盛りの組で1件しか入らないので、
--   同じ知らせが二重になることはない。
--
-- 【0 になったら自動取り込みを切る】
--   知らせと同時に切る。枠を足しても勝手には戻さない（作者が入れ直す）。

create or replace function public.record_capacity_thresholds(p_work_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_state     record;
  v_remaining int;
  v_owner     uuid;
begin
  select s.epoch, s.epoch_base into v_state
    from public.work_import_state s
   where s.work_id = p_work_id;

  if not found or v_state.epoch_base <= 0 then
    return;
  end if;

  v_remaining := public.work_remaining_capacity(p_work_id);
  select w.user_id into v_owner from public.works w where w.id = p_work_id;

  if v_remaining <= 0 then
    insert into public.capacity_notifications
      (work_id, user_id, kind, epoch, remaining_at_event, base_at_event)
    values
      (p_work_id, v_owner, 'exhausted', v_state.epoch, v_remaining, v_state.epoch_base)
    on conflict (work_id, epoch, kind) do nothing;

    -- 枠が尽きたら自動取り込みを切る
    update public.work_import_state s
       set auto_import = false, updated_at = now()
     where s.work_id = p_work_id;
  end if;

  if v_remaining > 0 and v_remaining::numeric / v_state.epoch_base <= 0.05 then
    insert into public.capacity_notifications
      (work_id, user_id, kind, epoch, remaining_at_event, base_at_event)
    values
      (p_work_id, v_owner, 'remaining_5', v_state.epoch, v_remaining, v_state.epoch_base)
    on conflict (work_id, epoch, kind) do nothing;
  end if;

  if v_remaining > 0 and v_remaining::numeric / v_state.epoch_base <= 0.20 then
    insert into public.capacity_notifications
      (work_id, user_id, kind, epoch, remaining_at_event, base_at_event)
    values
      (p_work_id, v_owner, 'remaining_20', v_state.epoch, v_remaining, v_state.epoch_base)
    on conflict (work_id, epoch, kind) do nothing;
  end if;
end;
$fn$;

comment on function public.record_capacity_thresholds(uuid) is
  '残量が目盛り（2割・5%・0）を下回ったことを記録する【内部用】。'
  '世代ごとに1回だけ。0になったら自動取り込みを切る。';

revoke all on function public.record_capacity_thresholds(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. 古い順に取り込む（内部用）
-- ----------------------------------------------------------------------------
--
-- 【順番を固定する】
--   回答した時刻の古い順。同じ時刻の回答があるので、そのときは回答の id の
--   小さい順。**この2つで必ず一意に決まる。**決めておかないと、
--   同じ状況で走らせても取り込まれる相手が変わる。
--
-- 【枠より多く取り込まない】
--   錠を取ってから残量を数え、その数だけを取り込む。
--   取り込み済みの回答は最初から候補に入らないので、二度目は0件になる。

create or replace function public.consume_import_capacity(
  p_work_id uuid,
  p_source  text,
  p_limit   int default null
)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_remaining int;
  v_take      int;
  v_done      int;
begin
  perform public.ensure_work_import_state(p_work_id);

  -- **ここが錠。**同じ作品への取り込みは、必ずこの行で順番待ちになる
  perform 1 from public.work_import_state s
    where s.work_id = p_work_id
    for update;

  v_remaining := public.work_remaining_capacity(p_work_id);
  if v_remaining <= 0 then
    return 0;
  end if;

  v_take := v_remaining;
  if p_limit is not null and p_limit < v_take then
    v_take := p_limit;
  end if;
  if v_take <= 0 then
    return 0;
  end if;

  with target as (
    select a.id
      from public.answers a
     where a.work_id = p_work_id
       and not exists (
         select 1 from public.analysis_imports i where i.answer_id = a.id
       )
     order by a.created_at, a.id
     limit v_take
  )
  insert into public.analysis_imports (answer_id, work_id, source)
  select t.id, p_work_id, p_source from target t
  on conflict (answer_id) do nothing;

  get diagnostics v_done = row_count;

  if v_done > 0 then
    perform public.record_capacity_thresholds(p_work_id);
  end if;

  return v_done;
end;
$fn$;

comment on function public.consume_import_capacity(uuid, text, int) is
  '古い回答から順に、残り枠のぶんだけ取り込む【内部用】。'
  '状態の行で錠を取るので、同時に走っても枠を使いすぎない。';

revoke all on function public.consume_import_capacity(uuid, text, int)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 8. 新しい回答が来たときに、自動で取り込む
-- ----------------------------------------------------------------------------
--
-- 自動取り込みが入っていて、残り枠があるときだけ1件取り込む。
-- 切っているとき、または枠が無いときは何もしない（回答は今までどおり保存される）。

create or replace function public.answers_after_insert_auto_import()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_on boolean;
begin
  select s.auto_import into v_on
    from public.work_import_state s
   where s.work_id = new.work_id;

  if coalesce(v_on, false) then
    perform public.consume_import_capacity(new.work_id, 'auto', 1);
  end if;

  return null;
end;
$fn$;

revoke all on function public.answers_after_insert_auto_import()
  from public, anon, authenticated;

drop trigger if exists answers_after_insert_auto_import on public.answers;
create trigger answers_after_insert_auto_import
  after insert on public.answers
  for each row
  execute function public.answers_after_insert_auto_import();


-- ----------------------------------------------------------------------------
-- 9. 枠を増やす（運営の鍵だけ）
-- ----------------------------------------------------------------------------
--
-- 【誰が呼べるか】
--   service_role だけ。利用者の鍵では呼べない。
--   決済業者も金額も決まっていないので、購入の画面は作っていない。
--   将来、支払いが済んだ知らせを受け取る場所からここを呼べばつながる。
--
-- 【枠を足しても自動取り込みは入れ直さない】
--   一度尽きて切れたものを勝手に戻すと、買った瞬間に古い回答へ
--   まとめて消費されることになる。入れ直すのは作者。

create or replace function public.grant_import_capacity(
  p_work_id     uuid,
  p_quantity    int,
  p_source_type text default 'admin',
  p_source_ref  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_owner     uuid;
  v_remaining int;
begin
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'BAD_QUANTITY: 増やす枠は1以上で指定してください。';
  end if;

  select w.user_id into v_owner from public.works w where w.id = p_work_id;
  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  perform public.ensure_work_import_state(p_work_id);

  perform 1 from public.work_import_state s where s.work_id = p_work_id for update;

  insert into public.work_capacity_grants
    (work_id, granted_to, quantity, source_type, source_ref)
  values (p_work_id, v_owner, p_quantity, p_source_type, p_source_ref);

  v_remaining := public.work_remaining_capacity(p_work_id);

  -- 世代を進める。残量の知らせが、この新しい枠に対してまた出せるようになる
  update public.work_import_state s
     set epoch      = s.epoch + 1,
         epoch_base = v_remaining,
         updated_at = now()
   where s.work_id = p_work_id;

  return jsonb_build_object(
    'work_id',   p_work_id,
    'granted',   p_quantity,
    'total',     public.work_granted_capacity(p_work_id),
    'imported',  public.work_imported_count(p_work_id),
    'remaining', v_remaining
  );
end;
$fn$;

comment on function public.grant_import_capacity(uuid, int, text, text) is
  '取り込み枠を増やす。運営の鍵（service_role）だけが呼べる。'
  '台帳へ1行足し、枠の世代を1つ進める。自動取り込みは入れ直さない。';

revoke all on function public.grant_import_capacity(uuid, int, text, text)
  from public, anon, authenticated;
grant execute on function public.grant_import_capacity(uuid, int, text, text) to service_role;


-- ----------------------------------------------------------------------------
-- 10. 作者が、残り枠を使って古い回答から取り込む
-- ----------------------------------------------------------------------------
--
-- これは購入ではない。**既に持っている枠を使うだけ。**

create or replace function public.import_answers(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_done int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if not exists (
    select 1 from public.works w where w.id = p_work_id and w.user_id = v_uid
  ) then
    raise exception 'NOT_WORK_OWNER: 自分の作品の取り込みだけができます。';
  end if;

  v_done := public.consume_import_capacity(p_work_id, 'manual', null);

  return jsonb_build_object(
    'imported_now', v_done,
    'imported',     public.work_imported_count(p_work_id),
    'remaining',    public.work_remaining_capacity(p_work_id)
  );
end;
$fn$;

comment on function public.import_answers(uuid) is
  '作者が残り枠を使って、古い回答から順に取り込む。購入ではない。';

revoke all on function public.import_answers(uuid) from public, anon, authenticated;
grant execute on function public.import_answers(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 11. 自動取り込みの入り切り
-- ----------------------------------------------------------------------------
--
-- 入れた瞬間に、溜まっている未取り込みの回答を古い順に取り込む。
-- そこで枠が尽きたら、そのまま切れる（record_capacity_thresholds が切る）。

create or replace function public.set_auto_import(p_work_id uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_done int := 0;
  v_on   boolean;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if not exists (
    select 1 from public.works w where w.id = p_work_id and w.user_id = v_uid
  ) then
    raise exception 'NOT_WORK_OWNER: 自分の作品の設定だけが変えられます。';
  end if;

  perform public.ensure_work_import_state(p_work_id);

  update public.work_import_state s
     set auto_import = p_on, updated_at = now()
   where s.work_id = p_work_id;

  if p_on then
    v_done := public.consume_import_capacity(p_work_id, 'backfill', null);
  end if;

  select s.auto_import into v_on
    from public.work_import_state s where s.work_id = p_work_id;

  return jsonb_build_object(
    'auto_import',  v_on,
    'imported_now', v_done,
    'imported',     public.work_imported_count(p_work_id),
    'remaining',    public.work_remaining_capacity(p_work_id)
  );
end;
$fn$;

comment on function public.set_auto_import(uuid, boolean) is
  '自動取り込みの入り切り。入れた瞬間に、溜まっている回答を古い順に取り込む。'
  'そこで枠が尽きれば、そのまま切れる。';

revoke all on function public.set_auto_import(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_auto_import(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 12. 数える相手を、無料と高度分析で分ける
-- ----------------------------------------------------------------------------
--
-- 【なぜ名前を変えるか】
--   P3 では `eligible_answers` が1つだけで、「外していない回答」を意味していた。
--   P4 からは2つになる。
--
--     無料の集計   … その作品への回答すべて
--     高度な分析   … 取り込み済み かつ 外していない
--
--   1つの名前のまま意味を変えると、呼んでいる側を読んだときに
--   どちらの意味かが分からない。**名前を2つに割る。**

drop function if exists public.eligible_answers(uuid);

/**
 * 無料の集計が数える相手。その作品への回答すべて。
 *
 * 取り込みも、分析から外したかも見ない。**無料の結果は今までどおり全部で出る。**
 */
create or replace function public.analysis_all_answers(p_work_id uuid)
returns table (answer_id bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id from public.answers a where a.work_id = p_work_id;
$fn$;

comment on function public.analysis_all_answers(uuid) is
  '無料の集計が数える回答【内部用】。その作品への回答すべて。';

revoke all on function public.analysis_all_answers(uuid) from public, anon, authenticated;

/**
 * 高度な分析（区画を押しての掘り下げ）が数える相手。
 *
 * 取り込み済みで、かつ作者が分析から外していないもの。
 * **条件が増えるときはここだけを書き換える。**呼ぶ側は変わらない。
 */
create or replace function public.analysis_advanced_answers(p_work_id uuid)
returns table (answer_id bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id
    from public.answers a
    join public.analysis_imports i on i.answer_id = a.id
   where a.work_id = p_work_id
     and not exists (
       select 1 from public.analysis_exclusions x where x.answer_id = a.id
     );
$fn$;

comment on function public.analysis_advanced_answers(uuid) is
  '高度な分析が数える回答【内部用】。取り込み済み かつ 分析から外していない。'
  '母集団の条件はここだけに書く。';

revoke all on function public.analysis_advanced_answers(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 13. 作者向けの集計を、無料の母集団で数え直す
-- ----------------------------------------------------------------------------
--
-- 【変えたところ】
--   数える相手を「外していない回答」から「その作品への回答すべて」へ戻した。
--   無料で見えるものは、取り込みを買っていなくても今までどおり全部で出る。
--
--   代わりに、母数の内訳を返す。**「100件の結果」を「1023件の結果」に
--   見せない**ため、画面はこの内訳をそのまま出す。

create or replace function public.get_work_answer_analysis(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_prompt    uuid;
  v_questions int;
  v_ids       bigint[];
begin
  if v_uid is null then
    return null;
  end if;

  select w.prompt_id into v_prompt
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  -- 無料の集計はすべての回答で数える
  select coalesce(array_agg(e.answer_id), array[]::bigint[])
    into v_ids
    from public.analysis_all_answers(p_work_id) e;

  return (
    with per_answer as (
      select a.id as answer_id,
             string_agg(
               case when ai.is_correct then '1' else '0' end, ''
               order by qq.position
             ) as pattern,
             count(*) as items,
             count(*) filter (
               where ai.answer_mode = 'exact' and ai.is_correct
             ) as exact_corrects
        from public.answers a
        join public.answer_items ai   on ai.answer_id = a.id
        join public.quiz_questions qq on qq.id = ai.question_id
       where a.id = any (v_ids)
       group by a.id
    )
    select jsonb_build_object(
      -- 無料の集計の母数。すべての回答
      'answers_count',  cardinality(v_ids),
      -- 母数の内訳。画面はこの4つを並べて出す
      'imported_count',   public.work_imported_count(p_work_id),
      'unimported_count', cardinality(v_ids) - public.work_imported_count(p_work_id),
      'excluded_count', (
        select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
      ),
      'advanced_count', (select count(*) from public.analysis_advanced_answers(p_work_id)),
      'min_subgroup',   public.analysis_min_subgroup(),
      'question_count', v_questions,
      'perfect_exact_count', (
        select count(*) from per_answer p
         where p.items = v_questions and p.exact_corrects = v_questions
      ),
      'patterns', coalesce((
        select jsonb_agg(x.obj order by x.n desc, x.pattern)
          from (
            select p.pattern,
                   count(*) as n,
                   jsonb_build_object('pattern', p.pattern, 'count', count(*)) as obj
              from per_answer p
             group by p.pattern
          ) x
      ), '[]'::jsonb),
      'sections', public.answer_word_stats(p_work_id, v_ids)
    )
  );
end;
$fn$;

comment on function public.get_work_answer_analysis(uuid) is
  '作者だけが見る無料の集計。母集団はその作品への回答すべて。'
  '母数の内訳（取り込み済み・未取り込み・外している・高度分析対象）も返す。';


-- ----------------------------------------------------------------------------
-- 14. 掘り下げは、取り込み済みの回答だけで数える
-- ----------------------------------------------------------------------------
--
-- 【変えたところ】
--   母集団を `analysis_advanced_answers` にした。取り込んでいない回答は入らない。
--   取り込み済みでも、分析から外していれば入らない。
--
--   取り込みが0件なら、掘り下げは始められない。そのときは
--   `not_imported` を立てて返す（少人数のときと同じく、中身は返さない）。

create or replace function public.get_work_drilldown(
  p_work_id uuid,
  p_pattern text default null,
  p_filters jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_prompt    uuid;
  v_questions int;
  v_min       int := public.analysis_min_subgroup();
  v_ids       bigint[];
  v_subgroup  bigint[];
  v_count     int;
  v_bad       int;
  v_targets   bigint[];
begin
  if v_uid is null then
    return null;
  end if;

  select w.prompt_id into v_prompt
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  if p_filters is null or jsonb_typeof(p_filters) <> 'array' then
    raise exception 'BAD_FILTERS: 絞り込みの形式が正しくありません。';
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  if p_pattern is not null
     and (length(p_pattern) <> v_questions or p_pattern !~ '^[01]+$') then
    raise exception 'BAD_PATTERN: 当て方の指定が正しくありません。';
  end if;

  select count(*)
    into v_bad
    from jsonb_array_elements(p_filters) f
   where not exists (
     select 1
       from public.quiz_questions qq
       join public.quiz_choices c on c.question_id = qq.id
      where qq.prompt_id = v_prompt
        and qq.id  = (f ->> 'question_id')::bigint
        and c.tag_id = (f ->> 'tag_id')::bigint
   );

  if v_bad > 0 then
    raise exception 'BAD_FILTER_TARGET: この作品に無い問か語が指定されています。';
  end if;

  if (select count(distinct f ->> 'question_id') from jsonb_array_elements(p_filters) f)
     <> (select count(*) from jsonb_array_elements(p_filters) f) then
    raise exception
      'DUPLICATE_FILTER_SECTION: 同じ項目に2つの条件は重ねられません。'
      'その項目の条件を選び直してください。';
  end if;

  -- **高度な分析の母集団はここだけで決める**
  select coalesce(array_agg(e.answer_id), array[]::bigint[])
    into v_ids
    from public.analysis_advanced_answers(p_work_id) e;

  -- 取り込みが1件も無ければ、掘り下げは始められない
  if cardinality(v_ids) = 0 then
    return jsonb_build_object(
      'not_imported',    true,
      'below_threshold', false,
      'min_subgroup',    v_min,
      'subgroup_count',  null,
      'question_count',  v_questions,
      'pattern',         p_pattern,
      'sections',        '[]'::jsonb
    );
  end if;

  with per as (
    select a.id as answer_id,
           string_agg(
             case when ai.is_correct then '1' else '0' end, ''
             order by qq.position
           ) as pattern
      from public.answers a
      join public.answer_items ai   on ai.answer_id = a.id
      join public.quiz_questions qq on qq.id = ai.question_id
     where a.id = any (v_ids)
     group by a.id
  )
  select coalesce(array_agg(p.answer_id), array[]::bigint[])
    into v_subgroup
    from per p
   where (p_pattern is null or p.pattern = p_pattern)
     and not exists (
       select 1
         from jsonb_array_elements(p_filters) f
        where not exists (
          select 1
            from public.answer_items ai
           where ai.answer_id = p.answer_id
             and ai.question_id = (f ->> 'question_id')::bigint
             and (f ->> 'tag_id')::bigint
                 in (ai.selected_tag_id, coalesce(ai.selected_tag_id_2, ai.selected_tag_id))
        )
     );

  v_count := cardinality(v_subgroup);

  if v_count < v_min then
    return jsonb_build_object(
      'not_imported',    false,
      'below_threshold', true,
      'min_subgroup',    v_min,
      'subgroup_count',  null,
      'question_count',  v_questions,
      'pattern',         p_pattern,
      'sections',        '[]'::jsonb
    );
  end if;

  if p_pattern is null then
    v_targets := null;
  else
    select coalesce(array_agg(qq.id order by qq.position), array[]::bigint[])
      into v_targets
      from public.quiz_questions qq
     where qq.prompt_id = v_prompt
       and substr(p_pattern, qq.position + 1, 1) = '0';
  end if;

  return jsonb_build_object(
    'not_imported',    false,
    'below_threshold', false,
    'min_subgroup',    v_min,
    'subgroup_count',  v_count,
    'question_count',  v_questions,
    'pattern',         p_pattern,
    'sections',        public.answer_word_stats(p_work_id, v_subgroup, v_targets)
  );
end;
$fn$;

comment on function public.get_work_drilldown(uuid, text, jsonb) is
  '作者だけが呼べる掘り下げ。母集団は取り込み済みかつ外していない回答。'
  '取り込みが0件なら not_imported、5人未満なら人数も内訳も返さない。';


-- ----------------------------------------------------------------------------
-- 15. 回答一覧に「取り込み済みか」を足す
-- ----------------------------------------------------------------------------
--
-- 外す相手を選ぶときに、どれが高度分析へ回っているかが見えるようにする。
-- 誰が答えたかは今までどおり返さない。当て方の並びも返さない。

create or replace function public.get_work_answer_list(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_prompt uuid;
  v_questions int;
begin
  if v_uid is null then
    return null;
  end if;

  select w.prompt_id into v_prompt
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  return (
    with numbered as (
      select a.id,
             a.created_at,
             row_number() over (order by a.created_at, a.id) as no
        from public.answers a
       where a.work_id = p_work_id
    ),
    per as (
      select n.id, n.no, n.created_at,
             count(*) filter (where ai.is_correct) as corrects,
             count(*) as items,
             count(*) filter (where ai.answer_mode = 'exact' and ai.is_correct)
               as exact_corrects
        from numbered n
        join public.answer_items ai on ai.answer_id = n.id
       group by n.id, n.no, n.created_at
    )
    select jsonb_build_object(
      'total',          (select count(*) from numbered),
      'excluded_count', (
        select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
      ),
      'imported_count', public.work_imported_count(p_work_id),
      'question_count', v_questions,
      'answers', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'no',               p.no,
                   'answered_at',      p.created_at,
                   'correct_sections', p.corrects,
                   'question_count',   p.items,
                   'is_perfect_exact',
                     p.items = v_questions and p.exact_corrects = v_questions,
                   'is_excluded', exists (
                     select 1 from public.analysis_exclusions x where x.answer_id = p.id
                   ),
                   'is_imported', exists (
                     select 1 from public.analysis_imports i where i.answer_id = p.id
                   )
                 )
                 order by p.no
               )
          from per p
      ), '[]'::jsonb)
    )
  );
end;
$fn$;

comment on function public.get_work_answer_list(uuid) is
  '作者向けの回答一覧。身元も当て方の並びも返さない。'
  '外す相手を指すための通し番号と、日時と、含んだ項目数と、取り込み済みか。';


-- ----------------------------------------------------------------------------
-- 16. 作者が見る、取り込み枠の状態と履歴
-- ----------------------------------------------------------------------------
--
-- 【削除した作品でも見える】
--   条件に `deleted_at is null` を入れていない。作品を消しても、
--   買った枠と取り込んだ記録は残る。作者はそれを確かめられる。
--   下書き（非公開）も同じ。
--
-- 【未取り込みの回答について、いつのものかまでは出す】
--   いちばん古いものと、いちばん新しいものの時刻。中身は出さない。
--   何を選んだか、どの区画に入るかは、取り込んで初めて見えるものなので、
--   ここには含めない。
--
--   「直近で何件増えたか」の期間（24時間なのか7日なのか）は決まっていないので、
--   その数は返していない。

create or replace function public.get_work_import_state(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_state record;
begin
  if v_uid is null then
    return null;
  end if;

  if not exists (
    select 1 from public.works w where w.id = p_work_id and w.user_id = v_uid
  ) then
    return null;
  end if;

  select s.auto_import, s.epoch, s.epoch_base into v_state
    from public.work_import_state s
   where s.work_id = p_work_id;

  return jsonb_build_object(
    'granted_total', public.work_granted_capacity(p_work_id),
    'imported',      public.work_imported_count(p_work_id),
    'remaining',     public.work_remaining_capacity(p_work_id),
    'auto_import',   coalesce(v_state.auto_import, false),
    'epoch',         coalesce(v_state.epoch, 0),
    'epoch_base',    coalesce(v_state.epoch_base, 0),

    'answers_total', (
      select count(*) from public.answers a where a.work_id = p_work_id
    ),
    'unimported', (
      select count(*) from public.answers a
       where a.work_id = p_work_id
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),
    'excluded', (
      select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
    ),
    'advanced', (select count(*) from public.analysis_advanced_answers(p_work_id)),

    -- 未取り込みの回答が、いつからいつまでのものか
    'oldest_unimported_at', (
      select min(a.created_at) from public.answers a
       where a.work_id = p_work_id
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),
    'latest_unimported_at', (
      select max(a.created_at) from public.answers a
       where a.work_id = p_work_id
         and not exists (select 1 from public.analysis_imports i where i.answer_id = a.id)
    ),

    'grants', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'id',          g.id,
                 'quantity',    g.quantity,
                 'source_type', g.source_type,
                 'source_ref',  g.source_ref,
                 'created_at',  g.created_at
               )
               order by g.created_at desc, g.id desc
             )
        from public.work_capacity_grants g
       where g.work_id = p_work_id
    ), '[]'::jsonb),

    'notifications', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'kind',       n.kind,
                 'epoch',      n.epoch,
                 'remaining',  n.remaining_at_event,
                 'base',       n.base_at_event,
                 'created_at', n.created_at,
                 'email_sent', n.email_sent_at is not null
               )
               order by n.created_at desc
             )
        from public.capacity_notifications n
       where n.work_id = p_work_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_work_import_state(uuid) is
  '作者が見る取り込み枠の状態と履歴。削除した作品でも下書きでも返る。'
  '未取り込みの回答は件数と時刻の幅だけで、中身は返さない。';

revoke all on function public.get_work_import_state(uuid) from public, anon, authenticated;
grant execute on function public.get_work_import_state(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 17. 外す／戻すが返す数を、高度分析の母集団に合わせる
-- ----------------------------------------------------------------------------
--
-- 中身は P3 のまま。返り値の `analysed_count` だけ、
-- 「外していない回答の数」から「高度分析の対象になる回答の数」へ変えた。
--
-- **外しても取り込み枠は戻らない**（2026-09-09 のユーザー確定）。
-- 戻す仕掛けをどこにも書いていないので、外す・戻すを繰り返しても
-- 台帳も取り込みの記録も動かない。

create or replace function public.set_answer_excluded(
  p_work_id    uuid,
  p_answer_nos int[],
  p_excluded   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ids bigint[];
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if not exists (
    select 1 from public.works w
     where w.id = p_work_id and w.user_id = v_uid and w.deleted_at is null
  ) then
    raise exception 'NOT_WORK_OWNER: 自分の作品の分析だけが変えられます。';
  end if;

  if p_answer_nos is null or cardinality(p_answer_nos) = 0 then
    raise exception 'NO_TARGET: 対象が選ばれていません。';
  end if;

  with numbered as (
    select a.id, row_number() over (order by a.created_at, a.id) as no
      from public.answers a
     where a.work_id = p_work_id
  )
  select coalesce(array_agg(n.id), array[]::bigint[])
    into v_ids
    from numbered n
   where n.no = any (p_answer_nos);

  if cardinality(v_ids) <> cardinality(p_answer_nos) then
    raise exception 'ANSWER_NOT_FOUND: 指定した回答が見つかりません。画面を開き直してください。';
  end if;

  if p_excluded then
    insert into public.analysis_exclusions (answer_id, work_id, excluded_by)
    select id, p_work_id, v_uid from unnest(v_ids) as u(id)
    on conflict (answer_id) do nothing;
  else
    delete from public.analysis_exclusions x where x.answer_id = any (v_ids);
  end if;

  return jsonb_build_object(
    'changed',        cardinality(v_ids),
    'excluded_count', (
      select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
    ),
    -- 高度分析の対象になる回答の数（取り込み済み かつ 外していない）
    'analysed_count', (
      select count(*) from public.analysis_advanced_answers(p_work_id)
    ),
    -- **枠は戻らない。**確かめられるように、そのままの数を返す
    'remaining_capacity', public.work_remaining_capacity(p_work_id)
  );
end;
$fn$;

comment on function public.set_answer_excluded(uuid, int[], boolean) is
  '作者が回答を自分の分析から外す／戻す。回答そのものは消さない。'
  '外しても取り込み枠は戻らない。作品の持ち主以外は断る。';
