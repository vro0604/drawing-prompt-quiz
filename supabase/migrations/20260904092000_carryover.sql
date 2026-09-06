-- ============================================================================
-- carryover ／ 一部持ち出し（D161）と、回答後のお題開示（D162 の 4）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 持ち出した要素の置き場（saved_elements）を作る
--   2. お題の派生関係の置き場（prompt_element_origins）を作る
--   3. 回答後に「正解のお題まるごと」を返す RPC を作る
--   4. 要素を1〜3個保存する RPC を作る
--   5. 保存した要素の一覧と削除の RPC を作る
--
-- 【誰が使えるか】
--   持ち出しは**登録者のみ**（D164）。判定は JWT の is_anonymous で行う。
--   `profiles.is_anonymous` では判定しない（既存の書き込みRPCと同じ形。DB検査112〜115）。
--   ゲストの作品鑑賞とクイズ回答は止めない。
--
-- 【回答後のお題開示について】
--   これは**新しい正解の出口**になる。既存の出口は4本だけだった
--   （complete_draft / get_my_prompt / get_my_answer / get_saved_works）。
--   本数を増やす以上、次の2つを満たすことを検証側でも見る。
--     ・回答していない人には1件も返さない
--     ・作品が公開条件を満たさないときは1件も返さない
--   検証は scripts/db-checks.mjs（静的）と test/db/ の縦断試験（実際に呼ぶ）の両方。
--
-- 【なぜ「回答した人には出題されなかった枠まで見せる」のか】
--   D162 の 4 が「回答後、正解のお題と作者のフレーバーテキストを一緒に
--   必ず開示する」と決めているため。出題は3問だが、お題は3〜6語ある。
--   3問ぶんしか返さないと「正解のお題」を開示したことにならない。
--
--   その人はもうその作品に回答できない（1作品1回）ので、
--   本人にとっての先読みにはならない。他人には返らない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 持ち出した要素
-- ----------------------------------------------------------------------------
--
-- 【既存の saves との違い】
--   saves は「作品のお気に入り」で、work_id と user_id しか持たない。
--   こちらは**お題の中の語1つ**を持ち、どこから持ってきたかを併せて持つ。
--   名前が近いだけで別物なので、表を分ける。

create table if not exists public.saved_elements (
  id bigint generated always as identity primary key,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  -- 他者の作品から持ち出したときの元作品（D161「元作品と元お題を記録する」）。
  -- 自分のお題から持ち出したときは null。
  -- 作品が消えても持ち出した事実は残すので set null。
  source_work_id uuid
    references public.works (id) on delete set null on update restrict,

  -- 元のお題。他者作品からでも自分のお題からでも入る。
  source_prompt_id uuid
    references public.prompts (id) on delete set null on update restrict,

  created_at timestamptz not null default now(),

  -- 同じ語を二重に持たない。最初に持ち出したときの出所を正とする。
  constraint saved_elements_unique unique (user_id, tag_id)
);

comment on table public.saved_elements is
  '持ち出した要素（D161）。登録者のみ。作品のお気に入り（saves）とは別物。'
  '権限を与えず、RPC 経由でのみ読み書きする。';

create index if not exists saved_elements_user_idx
  on public.saved_elements (user_id, created_at desc);

alter table public.saved_elements enable row level security;
revoke all on table public.saved_elements from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. お題の派生関係
-- ----------------------------------------------------------------------------
--
-- 「鑑賞から次の制作へ着想が伝わった経路」を残すための表（D161）。
-- 1つのお題に、持ち出した要素の数だけ行が入る（1〜3行）。
--
-- 派生したお題からさらに持ち出すと、その新しいお題にも行が入り、
-- source_prompt_id をたどって鎖になる。

create table if not exists public.prompt_element_origins (
  prompt_id uuid not null
    references public.prompts (id) on delete cascade on update restrict,

  tag_id bigint not null
    references public.tags (id) on delete restrict on update restrict,

  source_prompt_id uuid
    references public.prompts (id) on delete set null on update restrict,

  source_work_id uuid
    references public.works (id) on delete set null on update restrict,

  created_at timestamptz not null default now(),

  constraint prompt_element_origins_pkey primary key (prompt_id, tag_id)
);

comment on table public.prompt_element_origins is
  'お題の中の語が、どのお題・どの作品から持ち出されたか（D161）。'
  'prompt_id を含むため公開しない。';

create index if not exists prompt_element_origins_source_prompt_idx
  on public.prompt_element_origins (source_prompt_id);

create index if not exists prompt_element_origins_source_work_idx
  on public.prompt_element_origins (source_work_id);

alter table public.prompt_element_origins enable row level security;
revoke all on table public.prompt_element_origins from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 回答後のお題開示
-- ----------------------------------------------------------------------------
--
-- 【誰に返るか】
--   ・その作品に回答済みの人  … 返る
--   ・その作品の作者          … 返る（自分のお題なので元から見られる）
--   ・それ以外                … null
--   ・未サインイン            … 実行権限が無い（authenticated のみ）
--
-- 返り値に prompt_id は含めない（D23）。カードの中身だけを返す。

create or replace function public.get_answered_prompt(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_work record;
begin
  if v_uid is null then
    return null;
  end if;

  -- 公開条件を満たす作品だけ。満たさなければ「無い」と同じ扱い（D40）
  select w.id, w.prompt_id, w.user_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  -- 作者本人か、回答済みの人だけ。
  -- **ここが唯一の入場条件。**これを外すと公開の正解出口になる。
  if v_work.user_id <> v_uid
     and not exists (
       select 1 from public.answers a
        where a.work_id = p_work_id and a.user_id = v_uid
     ) then
    return null;
  end if;

  return jsonb_build_object(
    'work_id', v_work.id,
    'is_author', v_work.user_id = v_uid,
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'category_key',    tg.pool_key,
                 'category_label',  tp.label
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
        join public.tag_pools  tp on tp.pool_key      = tg.pool_key
       where pc.prompt_id = v_work.prompt_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_answered_prompt(uuid) is
  '回答済みの人と作者にだけ、正解のお題まるごとを返す（D162 の 4）。'
  '他人・未回答者・未サインインには null。返り値に prompt_id は含めない（D23）。';

revoke all on function public.get_answered_prompt(uuid)
  from public, anon, authenticated;
grant execute on function public.get_answered_prompt(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. 要素を1〜3個保存する
-- ----------------------------------------------------------------------------
--
-- 入口は2つ（D161）。
--   p_source_kind = 'work'   … 他者作品に回答したあと、そのお題から
--   p_source_kind = 'prompt' … 自分で引いたお題から
--
-- 【制限を設けないもの】
--   種類（モーフだけ／状態だけ／混在）、カテゴリ、組み合わせ。
--   D161 が「持ち出せる内容に制限を設けない」と決めている。
--   ここで見るのは「その語がそのお題に本当に入っているか」だけ。

create or replace function public.save_prompt_elements(
  p_source_kind text,
  p_source_id   uuid,
  p_tag_ids     bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_is_anonymous boolean;
  v_prompt_id    uuid;
  v_work_id      uuid;
  v_count        int;
  v_matched      int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- 登録者のみ（D164）。偽造できない JWT で見る
  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);
  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_CARRY: 要素の持ち出しにはアカウント登録が必要です。'
      'ゲストのままでも作品の鑑賞とクイズの回答はできます。';
  end if;

  if p_tag_ids is null then
    raise exception 'BAD_ELEMENTS: 持ち出す要素が指定されていません。';
  end if;

  select count(*) into v_count
    from (select distinct unnest(p_tag_ids) as tag_id) x;

  if v_count <> coalesce(array_length(p_tag_ids, 1), 0) then
    raise exception 'DUPLICATE_ELEMENT: 同じ要素を2回指定することはできません。';
  end if;

  if v_count < 1 or v_count > 3 then
    raise exception
      'BAD_ELEMENT_COUNT: 持ち出せるのは1〜3個です（いま %個）。', v_count;
  end if;

  -- --- 出所を確かめる -------------------------------------------------------
  if p_source_kind = 'work' then
    -- 公開されていて、自分が回答済みの作品だけ。
    -- 回答していない作品のお題を持ち出せると、それは正解の出口になる。
    select w.id, w.prompt_id into v_work_id, v_prompt_id
      from public.works w
     where w.id = p_source_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
       and (
         w.user_id = v_uid
         or exists (select 1 from public.answers a
                     where a.work_id = w.id and a.user_id = v_uid)
       );

    if v_prompt_id is null then
      raise exception
        'SOURCE_NOT_AVAILABLE: その作品のお題はまだ開示されていません。'
        '先にクイズへ回答してください。';
    end if;

  elsif p_source_kind = 'prompt' then
    -- 自分で引いたお題だけ
    select p.id into v_prompt_id
      from public.prompts p
     where p.id = p_source_id
       and p.created_by = v_uid;

    if v_prompt_id is null then
      raise exception 'SOURCE_NOT_FOUND: そのお題は見つかりません。';
    end if;

    v_work_id := null;

  else
    raise exception 'BAD_SOURCE_KIND: 出所の種類 % は使えません。', p_source_kind;
  end if;

  -- --- 指定された語が、本当にそのお題に入っているか -------------------------
  select count(*) into v_matched
    from public.prompt_cards pc
   where pc.prompt_id = v_prompt_id
     and pc.tag_id = any(p_tag_ids);

  if v_matched <> v_count then
    raise exception
      'ELEMENT_NOT_IN_PROMPT: そのお題に含まれない要素が指定されています。';
  end if;

  -- --- 保存する -------------------------------------------------------------
  --
  -- 既に持っている語は増やさない（unique）。出所は最初のものを残す。
  insert into public.saved_elements (user_id, tag_id, source_work_id, source_prompt_id)
  select v_uid, pc.tag_id, v_work_id, v_prompt_id
    from public.prompt_cards pc
   where pc.prompt_id = v_prompt_id
     and pc.tag_id = any(p_tag_ids)
  on conflict (user_id, tag_id) do nothing;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.save_prompt_elements(text, uuid, bigint[]) is
  'お題の要素を1〜3個保存する（D161）。登録者のみ（D164）。'
  '他者作品からは回答済みのときだけ。返り値は保存済み一覧。';


-- ----------------------------------------------------------------------------
-- 5. 保存した要素の一覧
-- ----------------------------------------------------------------------------
--
-- 本人の分だけを返す。他人の持ち出しは見られない。

create or replace function public.list_saved_elements()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',              se.id,
        'tag_id',          se.tag_id,
        'tag_label',       tg.label,
        'category_key',    tg.pool_key,
        'category_label',  tp.label,
        'category_kind',   coalesce(dc.kind, 'legacy'),
        'source_work_id',  se.source_work_id,
        'has_source_work', se.source_work_id is not null,
        'created_at',      se.created_at
      )
      order by se.created_at desc
    ),
    '[]'::jsonb
  )
  from public.saved_elements se
  join public.tags      tg on tg.id       = se.tag_id
  join public.tag_pools tp on tp.pool_key = tg.pool_key
  left join public.draw_categories dc on dc.pool_key = tg.pool_key
  where se.user_id = (select auth.uid());
$fn$;

comment on function public.list_saved_elements() is
  '自分が持ち出した要素の一覧（D161）。元お題IDは返さない（D23）。';


-- ----------------------------------------------------------------------------
-- 6. 保存した要素を捨てる
-- ----------------------------------------------------------------------------

create or replace function public.delete_saved_element(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  delete from public.saved_elements se
   where se.id = p_id and se.user_id = v_uid;

  return public.list_saved_elements();
end;
$fn$;

comment on function public.delete_saved_element(bigint) is
  '持ち出した要素を1件捨てる。他人の行は消せない（user_id で絞る）。';


-- ----------------------------------------------------------------------------
-- 7. 実行権限
-- ----------------------------------------------------------------------------

revoke all on function public.save_prompt_elements(text, uuid, bigint[])
  from public, anon, authenticated;
revoke all on function public.list_saved_elements()
  from public, anon, authenticated;
revoke all on function public.delete_saved_element(bigint)
  from public, anon, authenticated;

-- authenticated には匿名ゲストも含まれる。ゲストを止めるのは関数の中の
-- is_anonymous 判定で、権限では止めない（既存の create_work と同じ形）。
grant execute on function public.save_prompt_elements(text, uuid, bigint[]) to authenticated;
grant execute on function public.list_saved_elements() to authenticated;
grant execute on function public.delete_saved_element(bigint) to authenticated;
