-- ============================================================================
-- usage_events ／ 5つの動きを確認できるようにする（最小限の計測）
-- ============================================================================
--
-- 【確認したいのは5つ】
--   共有操作 ／ 回答完了 ／ 次の作品への遷移 ／ 制作開始 ／ 持ち出し利用
--
-- 【そのうち3つは、いまのDBから数えられる】
--   回答完了     answers.created_at
--   制作開始     draft_sessions.created_at
--   持ち出し利用 prompt_element_origins.created_at
--
--   これらは書き込みを伴う操作なので、行がそのまま記録になっている。
--   docs/postlaunch-feature-architecture.md 3-3 が
--   「汎用イベントログは要らない。すでに書き込みで全部記録されているから」
--   と判断しているのは、この3つのことを指している。
--
-- 【残る2つは、行が増えないので数えられない】
--   共有操作             共有ボタンを押しても何も書き込まれない
--   次の作品への遷移     ページを開くだけなので同上
--
--   この2つのためだけに表を1つ置く。**汎用のイベントログにしない。**
--   記録できるキーを CHECK で2つに固定し、増やすときは移行が要る形にする。
--   増やしにくくしておかないと、いつのまにか閲覧履歴の表になる。
--
-- 【外部サービスを契約していない】
--   解析サービスの依存も、外向きの通信も足していない。
--
-- ============================================================================


create table if not exists public.usage_events (
  id bigint generated always as identity primary key,

  event_key text not null
    constraint usage_events_key_valid
      check (event_key in ('share_opened', 'next_work_opened')),

  -- 誰が押したか。ゲスト掃除で消えたら null になる
  user_id uuid
    references public.profiles (id) on delete set null on update restrict,

  -- どの作品から起きたか。作品が消えたら null
  work_id uuid
    references public.works (id) on delete set null on update restrict,

  created_at timestamptz not null default now()
);

comment on table public.usage_events is
  '書き込みを伴わない2つの動きだけを記録する（共有操作／次の作品への遷移）。'
  'ほかの3つ（回答完了・制作開始・持ち出し利用）は既存の表から数えられるので入れない。'
  '汎用のイベントログにしないため、キーは CHECK で固定する。';

create index if not exists usage_events_key_created_idx
  on public.usage_events (event_key, created_at desc);

alter table public.usage_events enable row level security;
revoke all on table public.usage_events from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 記録する
-- ----------------------------------------------------------------------------
--
-- ゲストも記録できる。**ここを登録者だけにすると、
-- いちばん人数の多い層の動きが数から消える。**
-- 未サインインのまま押した場合は user_id が null で入る。

create or replace function public.record_usage_event(
  p_event_key text,
  p_work_id   uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if p_event_key not in ('share_opened', 'next_work_opened') then
    raise exception 'BAD_EVENT_KEY: 記録できない種類です。';
  end if;

  insert into public.usage_events (event_key, user_id, work_id)
  values (p_event_key, (select auth.uid()), p_work_id);
end;
$fn$;

comment on function public.record_usage_event(text, uuid) is
  '共有操作と次の作品への遷移だけを記録する。ほかの種類は受け付けない。';

revoke all on function public.record_usage_event(text, uuid)
  from public, anon, authenticated;
grant execute on function public.record_usage_event(text, uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5つをまとめて数える
-- ----------------------------------------------------------------------------
--
-- 3つは既存の表から、2つは usage_events から数える。
-- 運営用。一般利用者には配らない。

create or replace function public.get_usage_summary(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object(
    'since_days', greatest(1, coalesce(p_days, 30)),
    'share_opened', (
      select count(*) from public.usage_events e
       where e.event_key = 'share_opened'
         and e.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'next_work_opened', (
      select count(*) from public.usage_events e
       where e.event_key = 'next_work_opened'
         and e.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'answer_completed', (
      select count(*) from public.answers a
       where a.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'draft_started', (
      select count(*) from public.draft_sessions d
       where d.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30)))),
    'carryover_used', (
      select count(*) from public.prompt_element_origins o
       where o.created_at > now() - make_interval(days => greatest(1, coalesce(p_days, 30))))
  );
$fn$;

comment on function public.get_usage_summary(int) is
  '5つの動きの件数。3つは既存の表から、2つは usage_events から数える。運営用。';

revoke all on function public.get_usage_summary(int)
  from public, anon, authenticated;
grant execute on function public.get_usage_summary(int) to service_role;
