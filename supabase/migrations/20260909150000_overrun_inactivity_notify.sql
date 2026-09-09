-- ============================================================================
-- overrun_inactivity_notify ／ 予定終了時刻の超過・放置による破棄・通知の土台
-- ============================================================================
--
-- 【いままでの作り】
--   予定終了時刻（deadline_at）を過ぎると、そこから 0.5T の「猶予」が始まり、
--   猶予も過ぎると挑戦は **失敗** になった。失敗になると延長もできない。
--   つまり deadline は事実上「作りかけを壊す期限」だった。
--
-- 【これからの作り】
--   deadline_at は **予定終了時刻** であって、作りかけを壊す期限ではない。
--   過ぎても失敗にしない。時計も止めない。延長もできる。
--
--   作りかけが消える理由は1つだけ ——「長いあいだ何も操作されていない」。
--     最終有効操作から 24 時間 … 放置の予告を1回だけ出す
--     最終有効操作から 48 時間 … 自動で破棄する
--   この2つは予定終了時刻とはまったく別の時計で動く。
--
-- 【状態は3つに分かれる】
--   within    … 制作時間内
--   overrun   … 制作時間超過中（挑戦は続いている）
--   discarded … 放置による自動破棄済み
--   （投稿・放棄で終わったものは finished）
--
-- 【何を「有効操作」と数えるか】
--   ドラフトの行と候補の行が実際に書き換わったとき、
--   お題の行が実際に書き換わったとき、そして延長したとき。
--   **ページを開いただけでは数えない。**読み取りの関数は stable なので
--   1バイトも書かない。トリガーで拾う形にしてあるので、
--   将来 RPC が増えても「更新を書き忘れて永久に延命される」ことがない。
--
-- 【この migration を当てた直後に、いきなり破棄が起きないこと】
--   放置の起点は「最終有効操作」と「この規則を入れた時刻」の遅いほう。
--   当てた瞬間に 48 時間を過ぎている作りかけが一斉に消えることはない。
--   予告（24時間）も必ず先に出る。
--
-- 【通知】
--   通知は1つの表（notification_events）に貯める。
--   配送先（サイト内・ブラウザのプッシュ・メール）は別の表で分けて数える。
--   **プッシュが届かなくても、サイト内の履歴には必ず残る。**
--
-- ============================================================================


-- ============================================================================
-- 1. 放置の期限を1か所へ
-- ============================================================================
--
-- 日数を画面や関数へ散らさない。ここ1つだけを見る。
-- updated_at は「この値をいつ決めたか」で、放置の起点の下限にも使う。

create table if not exists public.draft_lifecycle_policy (
  policy_key text primary key
    constraint draft_lifecycle_policy_key_format
      check (policy_key ~ '^[a-z][a-z0-9_]{1,49}$'),

  seconds int not null
    constraint draft_lifecycle_policy_seconds_range
      check (seconds between 60 and 31536000),

  -- false = ユーザー承認済みの値。true = 私が置いた暫定値
  is_provisional boolean not null default false,

  note text not null
    constraint draft_lifecycle_policy_note_length
      check (char_length(note) between 1 and 300),

  updated_at timestamptz not null default now()
);

comment on table public.draft_lifecycle_policy is
  '作りかけが放置されたときの予告と破棄の期限（2026-09-09）。'
  '予定終了時刻（deadline_at）とは別物。日数はここ1か所だけに書く。';

insert into public.draft_lifecycle_policy (policy_key, seconds, is_provisional, note) values
  ('inactivity_warn_seconds', 86400, false,
   '最終有効操作から24時間で放置の予告を出す。ユーザー確定（2026-09-09）'),
  ('inactivity_discard_seconds', 172800, false,
   '最終有効操作から48時間で自動破棄する。ユーザー確定（2026-09-09）')
on conflict (policy_key) do nothing;

alter table public.draft_lifecycle_policy enable row level security;
revoke all on table public.draft_lifecycle_policy from public, anon, authenticated;


-- 秒を1つ読む。**この関数以外から数を読まない。**
create or replace function public.lifecycle_seconds(p_key text)
returns int
language sql
stable
set search_path = ''
as $fn$
  select p.seconds from public.draft_lifecycle_policy p where p.policy_key = p_key;
$fn$;

comment on function public.lifecycle_seconds(text) is
  '放置の期限を1つ読む（2026-09-09）。内部専用。';

revoke all on function public.lifecycle_seconds(text) from public, anon, authenticated;


-- 放置の起点の下限。**この規則を入れた（更新した）時刻。**
--
-- これが無いと、migration を当てた瞬間に「48時間以上動いていない作りかけ」が
-- 一斉に破棄され、予告（24時間）を一度も受け取らない人が出る。
create or replace function public.lifecycle_floor()
returns timestamptz
language sql
stable
set search_path = ''
as $fn$
  select max(p.updated_at) from public.draft_lifecycle_policy p;
$fn$;

comment on function public.lifecycle_floor() is
  '放置の起点の下限（2026-09-09）。規則を入れた／変えた時刻。'
  '当てた直後に一斉破棄が起きないようにするための下限。内部専用。';

revoke all on function public.lifecycle_floor() from public, anon, authenticated;


-- ============================================================================
-- 2. 最終有効操作の時刻
-- ============================================================================
--
-- 【なぜトリガーで拾うのか】
--   「めくる」「引き直す」「選ぶ」「確定する」「延ばす」…と操作の入口は多い。
--   入口ごとに1行ずつ書き足す作りにすると、**将来1つ増えたときに
--   書き忘れて、その操作だけ延命されない**（あるいは逆に、読むだけの関数へ
--   誤って書いてしまい、ページを開くだけで永久に延命される）。
--   行が実際に書き換わったかどうかで拾えば、書き忘れが起きない。
--
-- 【読み取りでは動かない】
--   get_current_draft / get_active_challenge / prompt_timer_json はすべて
--   stable で、1バイトも書かない。したがってページを開いても更新されない。

alter table public.prompts
  add column if not exists last_activity_at timestamptz;

update public.prompts p
   set last_activity_at = greatest(
         p.created_at,
         coalesce(p.started_at, p.created_at),
         coalesce(p.last_renewed_at, p.created_at))
 where p.last_activity_at is null;

alter table public.prompts alter column last_activity_at set default now();
alter table public.prompts alter column last_activity_at set not null;

comment on column public.prompts.last_activity_at is
  'この挑戦で最後に意味のある操作があった時刻（2026-09-09）。'
  '放置による自動破棄はここから数える。予定終了時刻とは別物。';

alter table public.draft_sessions
  add column if not exists last_activity_at timestamptz;

update public.draft_sessions ds
   set last_activity_at = greatest(
         ds.created_at,
         coalesce(ds.started_at, ds.created_at),
         coalesce(ds.updated_at, ds.created_at),
         coalesce(ds.last_renewed_at, ds.created_at))
 where ds.last_activity_at is null;

alter table public.draft_sessions alter column last_activity_at set default now();
alter table public.draft_sessions alter column last_activity_at set not null;

comment on column public.draft_sessions.last_activity_at is
  'このドラフトで最後に意味のある操作があった時刻（2026-09-09）。';

create index if not exists prompts_last_activity_idx
  on public.prompts (last_activity_at)
  where status = 'active';

create index if not exists draft_sessions_last_activity_idx
  on public.draft_sessions (last_activity_at)
  where status = 'in_progress';


-- お題の行が書き換わったら、最終操作の時刻を進める。
-- **進めるのは、進行中のまま書き換わったときだけ。**
-- 掃除が status を 'discarded' にする UPDATE では進めない
-- （進めてしまうと、破棄した瞬間に「たったいま操作された」ことになる）。
create or replace function public.prompts_touch_activity()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.status = 'active' and new.status = 'active'
     and new.last_activity_at = old.last_activity_at then
    new.last_activity_at := clock_timestamp();
  end if;
  return new;
end;
$fn$;

comment on function public.prompts_touch_activity() is
  'お題の行が進行中のまま書き換わったら、最終操作の時刻を進める（2026-09-09）。'
  '読み取りの関数は stable なので、ここは通らない。';

revoke all on function public.prompts_touch_activity() from public, anon, authenticated;

drop trigger if exists prompts_touch_activity_trigger on public.prompts;
create trigger prompts_touch_activity_trigger
  before update on public.prompts
  for each row
  execute function public.prompts_touch_activity();


create or replace function public.draft_sessions_touch_activity()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if old.status = 'in_progress' and new.status = 'in_progress'
     and new.last_activity_at = old.last_activity_at then
    new.last_activity_at := clock_timestamp();
  end if;
  return new;
end;
$fn$;

comment on function public.draft_sessions_touch_activity() is
  'ドラフトの行が進行中のまま書き換わったら、最終操作の時刻を進める（2026-09-09）。';

revoke all on function public.draft_sessions_touch_activity()
  from public, anon, authenticated;

drop trigger if exists draft_sessions_touch_activity_trigger on public.draft_sessions;
create trigger draft_sessions_touch_activity_trigger
  before update on public.draft_sessions
  for each row
  execute function public.draft_sessions_touch_activity();


-- カードをめくる・選ぶ・引き直すは draft_candidates を書き換える。
-- 親のドラフトの時刻を一緒に進める。
create or replace function public.draft_candidates_touch_session()
returns trigger
language plpgsql
set search_path = ''
as $fn$
declare
  v_id uuid := coalesce(new.session_id, old.session_id);
begin
  update public.draft_sessions ds
     set last_activity_at = clock_timestamp()
   where ds.id = v_id
     and ds.status = 'in_progress';
  return coalesce(new, old);
end;
$fn$;

comment on function public.draft_candidates_touch_session() is
  'カードの行が書き換わったら、親のドラフトの最終操作の時刻を進める（2026-09-09）。';

revoke all on function public.draft_candidates_touch_session()
  from public, anon, authenticated;

drop trigger if exists draft_candidates_touch_session_trigger on public.draft_candidates;
create trigger draft_candidates_touch_session_trigger
  after insert or update or delete on public.draft_candidates
  for each row
  execute function public.draft_candidates_touch_session();


-- ============================================================================
-- 3. 「放置による自動破棄済み」という状態を足す
-- ============================================================================
--
-- 既存の 'failed'（猶予切れの失敗）とは別の状態にする。
-- failed はこれから作られなくなるが、**既にある行は消さない**（記録として残す）。

alter table public.prompts
  add column if not exists discarded_at timestamptz;

comment on column public.prompts.discarded_at is
  '長いあいだ操作が無く、自動で破棄した時刻（2026-09-09）。'
  '制作時間の超過ではここへ入らない。';

alter table public.prompts drop constraint if exists prompts_status_valid;
alter table public.prompts
  add constraint prompts_status_valid check (
    status in ('active', 'submitted', 'abandoned', 'failed', 'discarded')
  );

alter table public.prompts drop constraint if exists prompts_status_timestamps;
alter table public.prompts
  add constraint prompts_status_timestamps check (
    (status = 'active'    and submitted_at is null and abandoned_at is null
                          and failed_at is null    and discarded_at is null)
    or
    (status = 'submitted' and submitted_at is not null and abandoned_at is null
                          and failed_at is null       and discarded_at is null)
    or
    (status = 'abandoned' and abandoned_at is not null and submitted_at is null
                          and failed_at is null       and discarded_at is null)
    or
    (status = 'failed'    and failed_at is not null and submitted_at is null
                          and abandoned_at is null  and discarded_at is null)
    or
    (status = 'discarded' and discarded_at is not null and submitted_at is null
                          and abandoned_at is null     and failed_at is null)
  );

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.prompts'::regclass
       and conname = 'prompts_discarded_after_created'
  ) then
    alter table public.prompts
      add constraint prompts_discarded_after_created
      check (discarded_at is null or discarded_at >= created_at);
  end if;
end $$;


alter table public.draft_sessions
  add column if not exists discarded_at timestamptz;

comment on column public.draft_sessions.discarded_at is
  '長いあいだ操作が無く、自動で破棄した時刻（2026-09-09）。';

alter table public.draft_sessions drop constraint if exists draft_sessions_status_valid;
alter table public.draft_sessions
  add constraint draft_sessions_status_valid check (
    status in ('in_progress', 'completed', 'abandoned', 'failed', 'discarded')
  );

alter table public.draft_sessions drop constraint if exists draft_sessions_status_timestamps;
alter table public.draft_sessions
  add constraint draft_sessions_status_timestamps check (
    (status = 'in_progress' and completed_at is null and abandoned_at is null
                            and failed_at is null    and discarded_at is null)
    or
    (status = 'completed'   and completed_at is not null and abandoned_at is null
                            and failed_at is null       and discarded_at is null)
    or
    (status = 'abandoned'   and abandoned_at is not null and completed_at is null
                            and failed_at is null       and discarded_at is null)
    or
    (status = 'failed'      and failed_at is not null and completed_at is null
                            and abandoned_at is null  and discarded_at is null)
    or
    (status = 'discarded'   and discarded_at is not null and completed_at is null
                            and abandoned_at is null     and failed_at is null)
  );


-- 放置で破棄する時点を1本で決める。**この式以外に日数を書かない。**
--
--   起点 = 最終有効操作 と「規則を入れた時刻」の遅いほう
--   予告 = 起点 + 24時間
--   破棄 = 起点 + 48時間
create or replace function public.inactivity_marks(p_last_activity_at timestamptz)
returns jsonb
language sql
stable
set search_path = ''
as $fn$
  select jsonb_build_object(
    'from_at',    v.base,
    'warn_at',    v.base + make_interval(secs => public.lifecycle_seconds('inactivity_warn_seconds')),
    'discard_at', v.base + make_interval(secs => public.lifecycle_seconds('inactivity_discard_seconds'))
  )
  from (select greatest(p_last_activity_at, public.lifecycle_floor()) as base) v;
$fn$;

comment on function public.inactivity_marks(timestamptz) is
  '放置の予告時刻と破棄時刻を1本で出す（2026-09-09）。'
  '起点は最終有効操作と、規則を入れた時刻の遅いほう。内部専用。';

revoke all on function public.inactivity_marks(timestamptz)
  from public, anon, authenticated;


-- ============================================================================
-- 4. 時計を作り直す（超過しても失敗にしない）
-- ============================================================================
--
-- 【消したもの】
--   grace_ends_at / grace_left_seconds / renew_opens_at / is_expired
--   —— どれも「猶予を使い切ったら失敗」を支えるための値だった。
--   猶予そのものを廃止したので、値ごと消す。
--   残しておくと、画面のどこかが古い意味で読み続ける。
--
-- 【足したもの】
--   phase                  within / overrun / discarded / finished
--   is_overrun             予定終了時刻を過ぎているか（過ぎても挑戦は続く）
--   inactivity_warn_at     放置の予告が出る時刻
--   auto_discard_at        放置で自動破棄される時刻
--   seconds_until_discard  破棄までの秒
--
-- 【can_renew はいつ真か】
--   終わっていない・進行中・期限を持つ、の3つだけ。
--   **時刻による窓は無い。**始まった直後でも、超過中でも押せる。

drop function if exists public.timer_core_json(
  text, int, timestamptz, timestamptz, int, timestamptz, bigint);

create or replace function public.timer_core_json(
  p_status           text,
  p_time_limit       int,
  p_started_at       timestamptz,
  p_deadline_at      timestamptz,
  p_renew_count      int,
  p_finished_at      timestamptz,
  p_elapsed          bigint,
  p_last_activity_at timestamptz,
  p_discarded_at     timestamptz
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $fn$
declare
  v_now      timestamptz := clock_timestamp();
  v_elapsed  bigint;
  v_marks    jsonb;
  v_warn_at  timestamptz;
  v_disc_at  timestamptz;
  v_gone     boolean;
  v_live     boolean;
  v_over     boolean;
  v_phase    text;
begin
  -- 終わっている挑戦は時計を止める。止めた時点の経過を出す
  if p_finished_at is not null then
    v_elapsed := coalesce(
      p_elapsed,
      floor(extract(epoch from (p_finished_at - p_started_at)))::bigint);
  else
    v_elapsed := greatest(0, floor(extract(epoch from (v_now - p_started_at))))::bigint;
  end if;

  v_marks   := public.inactivity_marks(coalesce(p_last_activity_at, p_started_at));
  v_warn_at := (v_marks ->> 'warn_at')::timestamptz;
  v_disc_at := (v_marks ->> 'discard_at')::timestamptz;

  -- 破棄されたか。**掃除が回る前でも、時刻を過ぎていれば破棄として扱う。**
  --   掃除は1日1回しか回らない。回るまで「まだ生きている」と見せると、
  --   その間に投稿できてしまい、DB の定義（正確に48時間）と食い違う。
  v_gone := p_status = 'discarded'
            or p_discarded_at is not null
            or (p_finished_at is null
                and p_status in ('active', 'in_progress')
                and v_now > v_disc_at);

  v_live := p_finished_at is null
            and not v_gone
            and p_status in ('active', 'in_progress');

  v_over := v_live
            and p_time_limit is not null
            and p_deadline_at is not null
            and v_now > p_deadline_at;

  v_phase := case
               when p_finished_at is not null then 'finished'
               when v_gone                    then 'discarded'
               when v_over                    then 'overrun'
               else                                'within'
             end;

  return jsonb_build_object(
    'status',             p_status,
    'phase',              v_phase,
    'is_unlimited',       p_time_limit is null,
    'has_deadline',       p_time_limit is not null and p_deadline_at is not null,
    'started_at',         p_started_at,
    'elapsed_seconds',    v_elapsed,
    'deadline_at',        p_deadline_at,
    'seconds_left',
      case when p_deadline_at is null then null
           else floor(extract(epoch from (p_deadline_at - v_now)))::bigint end,
    'overrun_seconds',
      case when p_deadline_at is null then 0
           else greatest(0, floor(extract(epoch from (v_now - p_deadline_at))))::bigint end,
    'is_overrun',         v_over,
    'is_discarded',       v_gone,
    -- **時刻の窓は無い。**始まった直後でも超過中でも延ばせる
    'can_renew',          v_live and p_time_limit is not null and p_deadline_at is not null,
    'renew_count',        coalesce(p_renew_count, 0),
    'time_limit_seconds', p_time_limit,
    'finished_at',        p_finished_at,
    'last_activity_at',   coalesce(p_last_activity_at, p_started_at),
    'inactivity_warn_at', case when v_live then v_warn_at else null end,
    'auto_discard_at',    case when v_live then v_disc_at else null end,
    'seconds_until_discard',
      case when v_live then floor(extract(epoch from (v_disc_at - v_now)))::bigint
           else null end,
    'discarded_at',       p_discarded_at,
    'server_now',         v_now
  );
end;
$fn$;

comment on function public.timer_core_json(text, int, timestamptz, timestamptz, int, timestamptz, bigint, timestamptz, timestamptz) is
  '制作挑戦の時間の状態を1か所で計算する（2026-09-09 に猶予と失敗を撤去）。'
  '予定終了時刻を過ぎても挑戦は続く。消えるのは放置による自動破棄だけ。内部専用。';

revoke all on function public.timer_core_json(text, int, timestamptz, timestamptz, int, timestamptz, bigint, timestamptz, timestamptz)
  from public, anon, authenticated;


create or replace function public.prompt_timer_json(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_p record;
begin
  select p.id, p.status, p.time_limit_seconds, p.deadline_at, p.started_at,
         p.renew_count, p.last_renewed_at, p.created_at, p.failed_at,
         p.submitted_at, p.abandoned_at, p.elapsed_seconds,
         p.last_activity_at, p.discarded_at
    into v_p
    from public.prompts p
   where p.id = p_prompt_id;

  if not found then
    return null;
  end if;

  return public.timer_core_json(
    v_p.status,
    v_p.time_limit_seconds,
    v_p.started_at,
    v_p.deadline_at,
    v_p.renew_count,
    coalesce(v_p.submitted_at, v_p.failed_at, v_p.abandoned_at),
    v_p.elapsed_seconds,
    v_p.last_activity_at,
    v_p.discarded_at);
end;
$fn$;

revoke all on function public.prompt_timer_json(uuid) from public, anon, authenticated;


create or replace function public.draft_timer_json(p_session_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_s record;
begin
  select ds.id, ds.status, ds.time_limit_seconds, ds.deadline_at, ds.started_at,
         ds.renew_count, ds.completed_at, ds.abandoned_at, ds.failed_at,
         ds.last_activity_at, ds.discarded_at
    into v_s
    from public.draft_sessions ds
   where ds.id = p_session_id;

  if not found then
    return null;
  end if;

  return public.timer_core_json(
    v_s.status,
    v_s.time_limit_seconds,
    v_s.started_at,
    v_s.deadline_at,
    v_s.renew_count,
    coalesce(v_s.completed_at, v_s.failed_at, v_s.abandoned_at),
    null,
    v_s.last_activity_at,
    v_s.discarded_at);
end;
$fn$;

revoke all on function public.draft_timer_json(uuid) from public, anon, authenticated;


-- ============================================================================
-- 5. 通知の共通の入れ物
-- ============================================================================
--
-- 【3つの層に分ける】
--   1. 出来事（notification_events）… 何が起きたか。1件1行。ここが真実
--   2. 配送（notification_deliveries）… どの経路で送ったか・送れたか
--   3. 送り先（push_subscriptions）… ブラウザのプッシュの宛先
--
--   **プッシュに頼らない。**プッシュが届かなくても、出来事は1に残る。
--   次にサイトへ来たときに読める。
--
-- 【同じことを二度知らせない】
--   dedupe_key が同じ行は1件しか入らない（unique）。
--   鍵の作り方で「何をもって別の出来事とするか」を決める。
--     予定超過   … 挑戦ID＋そのときの予定終了時刻
--                   （延長すると時刻が変わるので、また知らせられる）
--     24時間放置 … 挑戦ID＋放置の起点
--                   （制作を再開すると起点が動くので、また知らせられる）
--     自動破棄   … 挑戦ID（1回きり）
--
-- 【本体が消えても残る】
--   subject_id に外部キーを張らない。作りかけを物理的に消したあとでも、
--   「自動で破棄しました」と伝えられる必要がある。

create table if not exists public.notification_events (
  id bigserial primary key,

  user_id uuid not null references auth.users(id) on delete cascade,

  kind text not null
    constraint notification_events_kind_valid check (
      kind in ('deadline_overrun', 'inactivity_warning',
               'inactivity_discard', 'deadline_extended')),

  -- 何についての知らせか。**外部キーは張らない**（本体が消えても残すため）
  subject_kind text not null
    constraint notification_events_subject_kind_valid
      check (subject_kind in ('draft', 'prompt')),
  subject_id uuid not null,

  reason text
    constraint notification_events_reason_valid
      check (reason is null or reason in ('inactivity', 'deadline', 'user_action')),

  dedupe_key text not null unique
    constraint notification_events_dedupe_length
      check (char_length(dedupe_key) between 1 and 300),

  title text not null
    constraint notification_events_title_length check (char_length(title) between 1 and 120),
  body  text not null
    constraint notification_events_body_length  check (char_length(body)  between 1 and 500),

  -- 画面が使う付帯情報（戻り先の URL など）。正解の語は入れない
  payload jsonb not null default '{}'::jsonb,

  created_at      timestamptz not null default now(),
  seen_at         timestamptz,
  acknowledged_at timestamptz,

  constraint notification_events_ack_after_created
    check (acknowledged_at is null or acknowledged_at >= created_at)
);

comment on table public.notification_events is
  '利用者へ伝える出来事を貯める（2026-09-09）。プッシュが届かなくてもここに残る。'
  '自動破棄の記録もここが持つ（本体が消えても伝えられるよう外部キーを張らない）。';

create index if not exists notification_events_user_idx
  on public.notification_events (user_id, created_at desc);
create index if not exists notification_events_unack_idx
  on public.notification_events (user_id) where acknowledged_at is null;

-- 表そのものには誰も触れない。読むのは get_my_notifications だけ、
-- 書くのは emit_notification と acknowledge_notification だけ（D20 / D35 と同じ形）
alter table public.notification_events enable row level security;
revoke all on table public.notification_events from public, anon, authenticated;


create table if not exists public.notification_deliveries (
  id bigserial primary key,
  event_id bigint not null references public.notification_events(id) on delete cascade,

  channel text not null
    constraint notification_deliveries_channel_valid
      check (channel in ('in_app', 'web_push', 'email')),

  status text not null default 'pending'
    constraint notification_deliveries_status_valid
      check (status in ('pending', 'sent', 'failed', 'skipped')),

  attempts   int not null default 0
    constraint notification_deliveries_attempts_range check (attempts between 0 and 100),
  last_error text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_deliveries_one_per_channel unique (event_id, channel)
);

comment on table public.notification_deliveries is
  '出来事をどの経路で送ったか（2026-09-09）。'
  'in_app は貯めた時点で済み。web_push と email は別の仕組みが後から送る。';

create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (channel, status, id)
  where status = 'pending';

alter table public.notification_deliveries enable row level security;
revoke all on table public.notification_deliveries from public, anon, authenticated;


create table if not exists public.push_subscriptions (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,

  -- ブラウザが発行する宛先。**端末とブラウザごとに1本。**
  endpoint text not null unique
    constraint push_subscriptions_endpoint_length
      check (char_length(endpoint) between 10 and 2000),

  -- 中身を暗号化するための鍵（ブラウザが作る公開鍵と共有秘密）
  p256dh text not null
    constraint push_subscriptions_p256dh_length check (char_length(p256dh) between 10 and 200),
  auth   text not null
    constraint push_subscriptions_auth_length   check (char_length(auth)   between 5 and 100),

  user_agent text
    constraint push_subscriptions_ua_length check (user_agent is null or char_length(user_agent) <= 300),

  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),

  -- 宛先が無効になった時刻（ブラウザが 404/410 を返した）。null なら生きている
  expired_at timestamptz,
  last_error text
);

comment on table public.push_subscriptions is
  'ブラウザのプッシュの宛先（2026-09-09）。端末とブラウザごとに1本。'
  '無効になったものは expired_at を入れて残す（同じ宛先を作り直せるように）。';

create index if not exists push_subscriptions_user_idx
  on public.push_subscriptions (user_id) where expired_at is null;

-- 宛先も同じ。出し入れは save_push_subscription / delete_push_subscription だけ
alter table public.push_subscriptions enable row level security;
revoke all on table public.push_subscriptions from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 出来事を1件貯める（内部専用）
-- ----------------------------------------------------------------------------
--
-- 同じ dedupe_key が既にあれば何もしないで null を返す。
-- **例外にしない。**掃除が何度回っても静かに素通りしてほしい。

create or replace function public.emit_notification(
  p_user_id      uuid,
  p_kind         text,
  p_subject_kind text,
  p_subject_id   uuid,
  p_dedupe_key   text,
  p_title        text,
  p_body         text,
  p_reason       text    default null,
  p_payload      jsonb   default '{}'::jsonb,
  p_push         boolean default false
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_id       bigint;
  v_has_push boolean;
begin
  insert into public.notification_events
    (user_id, kind, subject_kind, subject_id, reason, dedupe_key, title, body, payload)
  values
    (p_user_id, p_kind, p_subject_kind, p_subject_id, p_reason, p_dedupe_key,
     p_title, p_body, coalesce(p_payload, '{}'::jsonb))
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    return null;   -- もう知らせてある
  end if;

  -- サイト内の履歴は貯めた時点で届いている
  insert into public.notification_deliveries (event_id, channel, status)
  values (v_id, 'in_app', 'sent');

  if p_push then
    select exists (
      select 1 from public.push_subscriptions s
       where s.user_id = p_user_id and s.expired_at is null
    ) into v_has_push;

    insert into public.notification_deliveries (event_id, channel, status)
    values (v_id, 'web_push', case when v_has_push then 'pending' else 'skipped' end);
  end if;

  return v_id;
end;
$fn$;

comment on function public.emit_notification(uuid, text, text, uuid, text, text, text, text, jsonb, boolean) is
  '出来事を1件貯める（2026-09-09）。同じ dedupe_key は1件しか入らない。内部専用。';

revoke all on function public.emit_notification(uuid, text, text, uuid, text, text, text, text, jsonb, boolean)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 本人が自分の知らせを読む・確認する
-- ----------------------------------------------------------------------------

create or replace function public.get_my_notifications(p_limit int default 20)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',              n.id,
        'kind',            n.kind,
        'subject_kind',    n.subject_kind,
        'subject_id',      n.subject_id,
        'reason',          n.reason,
        'title',           n.title,
        'body',            n.body,
        'payload',         n.payload,
        'created_at',      n.created_at,
        'acknowledged_at', n.acknowledged_at
      )
      order by n.created_at desc
    ),
    '[]'::jsonb
  )
  from (
    select * from public.notification_events e
     where e.user_id = (select auth.uid())
     order by (e.acknowledged_at is null) desc, e.created_at desc
     limit greatest(1, least(coalesce(p_limit, 20), 100))
  ) n;
$fn$;

comment on function public.get_my_notifications(int) is
  '自分あての知らせ（2026-09-09）。未確認を先に返す。お題の語は含まない。';

revoke all on function public.get_my_notifications(int) from public, anon, authenticated;
grant execute on function public.get_my_notifications(int) to authenticated;


create or replace function public.acknowledge_notification(p_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_n   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  update public.notification_events e
     set acknowledged_at = coalesce(e.acknowledged_at, clock_timestamp()),
         seen_at         = coalesce(e.seen_at, clock_timestamp())
   where e.id = p_id
     and e.user_id = v_uid;

  get diagnostics v_n = row_count;

  if v_n = 0 then
    raise exception 'NOTIFICATION_NOT_FOUND: その知らせは見つかりません。';
  end if;

  return public.get_my_notifications(20);
end;
$fn$;

comment on function public.acknowledge_notification(bigint) is
  '知らせを確認済みにする（2026-09-09）。確認したものは繰り返し出さない。';

revoke all on function public.acknowledge_notification(bigint) from public, anon, authenticated;
grant execute on function public.acknowledge_notification(bigint) to authenticated;


-- ----------------------------------------------------------------------------
-- ブラウザのプッシュの宛先を登録する・外す
-- ----------------------------------------------------------------------------
--
-- 同じ宛先が既にあれば上書きする（別の人の端末を横取りできないよう user_id も直す。
-- 端末を人に譲った場合に、前の持ち主あてに届き続けるのを防ぐ）。

create or replace function public.save_push_subscription(
  p_endpoint   text,
  p_p256dh     text,
  p_auth       text,
  p_user_agent text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_id  bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(btrim(p_endpoint), '') = '' then
    raise exception 'PUSH_ENDPOINT_REQUIRED: 送り先がありません。';
  end if;

  insert into public.push_subscriptions
    (user_id, endpoint, p256dh, auth, user_agent)
  values
    (v_uid, btrim(p_endpoint), btrim(p_p256dh), btrim(p_auth),
     left(coalesce(p_user_agent, ''), 300))
  on conflict (endpoint) do update
    set user_id      = v_uid,
        p256dh       = excluded.p256dh,
        auth         = excluded.auth,
        user_agent   = excluded.user_agent,
        last_seen_at = clock_timestamp(),
        expired_at   = null,
        last_error   = null
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'saved', true);
end;
$fn$;

comment on function public.save_push_subscription(text, text, text, text) is
  'ブラウザのプッシュの宛先を登録する（2026-09-09）。同じ宛先は上書きする。';

revoke all on function public.save_push_subscription(text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;


create or replace function public.delete_push_subscription(p_endpoint text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_n   int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  delete from public.push_subscriptions s
   where s.endpoint = btrim(p_endpoint) and s.user_id = v_uid;

  get diagnostics v_n = row_count;
  return jsonb_build_object('deleted', v_n);
end;
$fn$;

comment on function public.delete_push_subscription(text) is
  'ブラウザのプッシュの宛先を外す（2026-09-09）。自分のものだけ外せる。';

revoke all on function public.delete_push_subscription(text) from public, anon, authenticated;
grant execute on function public.delete_push_subscription(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 送る側（Secret key を持つ側）が使う3本
-- ----------------------------------------------------------------------------

create or replace function public.list_pending_push(p_limit int default 50)
returns table (
  delivery_id bigint,
  endpoint    text,
  p256dh      text,
  auth        text,
  title       text,
  body        text,
  url         text,
  tag         text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select d.id, s.endpoint, s.p256dh, s.auth,
         e.title, e.body,
         coalesce(e.payload ->> 'url', '/'),
         e.kind || ':' || e.subject_id::text
    from public.notification_deliveries d
    join public.notification_events e on e.id = d.event_id
    join public.push_subscriptions  s on s.user_id = e.user_id and s.expired_at is null
   where d.channel = 'web_push'
     and d.status = 'pending'
     and d.attempts < 5
   order by d.id
   limit greatest(1, least(coalesce(p_limit, 50), 200));
$fn$;

comment on function public.list_pending_push(int) is
  'まだ送っていないプッシュの宛先と中身（2026-09-09）。送る側だけが呼ぶ。';

revoke all on function public.list_pending_push(int) from public, anon, authenticated;
grant execute on function public.list_pending_push(int) to service_role;


create or replace function public.mark_push_result(
  p_delivery_id bigint,
  p_ok          boolean,
  p_error       text default null
)
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.notification_deliveries d
     -- 【いちど送れたものを「未送信」へ戻さない】
     --   1人が複数の端末を登録していると、同じ出来事に対して宛先の数だけ
     --   送信が起きる。1台目に届いて2台目が失敗したときに 'pending' へ戻すと、
     --   次の掃除で全部の端末へもう一度送ることになり、
     --   届いていた端末に同じ知らせが二度出る。
     set status     = case when d.status = 'sent' then 'sent'
                           when p_ok then 'sent'
                           when d.attempts + 1 >= 5 then 'failed'
                           else 'pending' end,
         attempts   = d.attempts + 1,
         last_error = case when p_ok then null else left(coalesce(p_error, ''), 500) end,
         updated_at = clock_timestamp()
   where d.id = p_delivery_id;
$fn$;

comment on function public.mark_push_result(bigint, boolean, text) is
  'プッシュ1件の結果を書く（2026-09-09）。5回失敗したら諦める。'
  '一度でも送れていれば、あとの失敗で送信待ちへ戻さない（二重送信を防ぐ）。';

revoke all on function public.mark_push_result(bigint, boolean, text)
  from public, anon, authenticated;
grant execute on function public.mark_push_result(bigint, boolean, text) to service_role;


-- ブラウザが「その宛先はもう無い」（404 / 410）と答えたとき。
-- 宛先を無効にして、以後そこへは送らない。
create or replace function public.expire_push_subscription(p_endpoint text, p_error text default null)
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.push_subscriptions s
     set expired_at = clock_timestamp(),
         last_error = left(coalesce(p_error, ''), 500)
   where s.endpoint = p_endpoint and s.expired_at is null;
$fn$;

comment on function public.expire_push_subscription(text, text) is
  '無効になったプッシュの宛先を止める（2026-09-09）。送る側だけが呼ぶ。';

revoke all on function public.expire_push_subscription(text, text)
  from public, anon, authenticated;
grant execute on function public.expire_push_subscription(text, text) to service_role;


-- ============================================================================
-- 6. 延長（いつでも押せる。残っている時間は捨てない）
-- ============================================================================
--
-- 【いままで押せなかった理由】
--   押せる窓が「残り 0.25T から、超過 0.5T まで」しかなかった。
--   30分の枠なら、始めてから 22分30秒 経つまで押せず、45分を過ぎたらもう押せない。
--   実測（2026-09-09、PGlite、30分枠）:
--     残り30分 → RENEW_TOO_EARLY / 残り10分 → RENEW_TOO_EARLY
--     残り 7分 → 成功 / 30秒超過 → 成功 / 10分超過 → 成功
--     20分超過 → RENEW_TOO_LATE（以後どうやっても押せない）
--
-- 【これからの式（ユーザー確定 2026-09-09「残り時間に足す（超過中はいまから）」）】
--   新しい予定終了時刻 = max(いまの予定終了時刻, 現在時刻) + 0.75T
--
--   期限内に押せば、残っている時間の上に 0.75T が積まれる（損をしない）。
--   超過中に押せば、いまから 0.75T（過ぎたぶんは戻らない）。
--   窓が無いので、いつ押しても成立する。

-- 使わなくなった2つの係数を消す。**残すと、どこかが古い意味で読み続ける。**
delete from public.time_policy where policy_key in ('renew_threshold_ratio', 'grace_ratio');

update public.time_policy
   set note = '延長一回で得る時間。max(いまの期限, 現在時刻) + 0.75T（2026-09-09 に式を変更）',
       updated_at = now()
 where policy_key = 'renew_grant_ratio';


create or replace function public.renew_prompt_deadline(p_prompt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_p      record;
  v_timer  jsonb;
  v_grant  numeric;
  v_now    timestamptz := clock_timestamp();
  v_secs   int;
  v_after  timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select p.id, p.status, p.time_limit_seconds, p.deadline_at, p.renew_count, p.started_at
    into v_p
    from public.prompts p
   where p.id = p_prompt_id
     and p.created_by = v_uid
   for update;

  if not found then
    raise exception 'PROMPT_NOT_FOUND: そのお題は見つかりません。';
  end if;

  if v_p.status <> 'active' then
    raise exception
      'PROMPT_NOT_ACTIVE: そのお題はもう延ばせません（状態: %）。', v_p.status;
  end if;

  if v_p.time_limit_seconds is null or v_p.deadline_at is null then
    raise exception
      'UNLIMITED_NO_RENEW: 制作時間が無制限のお題に、時間の延長はありません。';
  end if;

  v_timer := public.prompt_timer_json(p_prompt_id);

  -- **止めるのは放置による破棄だけ。**予定終了時刻の超過では止めない
  if (v_timer ->> 'is_discarded')::boolean then
    raise exception
      'CHALLENGE_DISCARDED: この制作は長いあいだ操作が無かったため、'
      'すでに自動で破棄されています。';
  end if;

  select tp.ratio into v_grant
    from public.time_policy tp where tp.policy_key = 'renew_grant_ratio';

  v_secs  := floor(v_p.time_limit_seconds * v_grant)::int;
  v_after := greatest(v_p.deadline_at, v_now) + make_interval(secs => v_secs);

  update public.prompts p
     set deadline_at     = v_after,
         renew_count     = p.renew_count + 1,
         last_renewed_at = v_now
   where p.id = p_prompt_id;

  perform public.record_renewal(
    v_uid, 'prompt', p_prompt_id,
    v_p.deadline_at, v_after, v_p.started_at, v_p.renew_count + 1);

  perform public.emit_notification(
    v_uid, 'deadline_extended', 'prompt', p_prompt_id,
    'ext:prompt:' || p_prompt_id::text || ':' || (v_p.renew_count + 1)::text,
    '制作時間を延長しました',
    '新しい終了予定は ' || to_char(v_after at time zone 'Asia/Tokyo', 'HH24:MI') || ' です。',
    'user_action',
    jsonb_build_object('url', '/prompt/' || p_prompt_id::text,
                       'granted_seconds', v_secs),
    false);

  return public.prompt_timer_json(p_prompt_id)
    || jsonb_build_object(
         'renewed',         true,
         'granted_seconds', v_secs,
         'deadline_before', v_p.deadline_at,
         'deadline_after',  v_after);
end;
$fn$;

comment on function public.renew_prompt_deadline(uuid) is
  '制作時間を延ばす（2026-09-09 に式を変更）。'
  '新しい期限 = max(いまの期限, 現在時刻) + 0.75T。押せる時刻の窓は無い。'
  '止めるのは放置による自動破棄だけで、予定終了時刻の超過では止めない。';

revoke all on function public.renew_prompt_deadline(uuid) from public, anon, authenticated;
grant execute on function public.renew_prompt_deadline(uuid) to authenticated;


create or replace function public.renew_draft_deadline(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_s     record;
  v_timer jsonb;
  v_grant numeric;
  v_now   timestamptz := clock_timestamp();
  v_secs  int;
  v_after timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.time_limit_seconds, ds.deadline_at,
         ds.renew_count, ds.started_at
    into v_s
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid
   for update;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_s.status <> 'in_progress' then
    raise exception
      'DRAFT_NOT_IN_PROGRESS: そのドラフトはもう延ばせません（状態: %）。', v_s.status;
  end if;

  if v_s.time_limit_seconds is null or v_s.deadline_at is null then
    raise exception
      'UNLIMITED_NO_RENEW: 制作時間が無制限の挑戦に、時間の延長はありません。';
  end if;

  v_timer := public.draft_timer_json(p_session_id);

  if (v_timer ->> 'is_discarded')::boolean then
    raise exception
      'CHALLENGE_DISCARDED: この制作は長いあいだ操作が無かったため、'
      'すでに自動で破棄されています。';
  end if;

  select tp.ratio into v_grant
    from public.time_policy tp where tp.policy_key = 'renew_grant_ratio';

  v_secs  := floor(v_s.time_limit_seconds * v_grant)::int;
  v_after := greatest(v_s.deadline_at, v_now) + make_interval(secs => v_secs);

  update public.draft_sessions ds
     set deadline_at     = v_after,
         renew_count     = ds.renew_count + 1,
         last_renewed_at = v_now
   where ds.id = p_session_id;

  perform public.record_renewal(
    v_uid, 'draft', p_session_id,
    v_s.deadline_at, v_after, v_s.started_at, v_s.renew_count + 1);

  perform public.emit_notification(
    v_uid, 'deadline_extended', 'draft', p_session_id,
    'ext:draft:' || p_session_id::text || ':' || (v_s.renew_count + 1)::text,
    '制作時間を延長しました',
    '新しい終了予定は ' || to_char(v_after at time zone 'Asia/Tokyo', 'HH24:MI') || ' です。',
    'user_action',
    jsonb_build_object('url', '/play', 'granted_seconds', v_secs),
    false);

  return public.draft_timer_json(p_session_id)
    || jsonb_build_object(
         'renewed',         true,
         'granted_seconds', v_secs,
         'deadline_before', v_s.deadline_at,
         'deadline_after',  v_after);
end;
$fn$;

comment on function public.renew_draft_deadline(uuid) is
  'ドラフト中の延長（2026-09-09）。規則は確定お題と同じ。総経過時間は減らない。';

revoke all on function public.renew_draft_deadline(uuid) from public, anon, authenticated;
grant execute on function public.renew_draft_deadline(uuid) to authenticated;


-- ============================================================================
-- 7. 「超過 → 失敗 → 延長不可」の経路を撤去する
-- ============================================================================
--
-- 撤去するもの
--   ・expire_overdue_prompts / expire_overdue_drafts（超過で status を failed にする掃除）
--   ・assert_draft_not_expired の中身（猶予切れで操作を止める）
--   ・works_guard_prompt_deadline の中身（猶予切れで投稿を止める）
--
-- 既にある status='failed' の行は書き換えない。**過去の記録は残す。**

drop function if exists public.expire_overdue_prompts(int);
drop function if exists public.expire_overdue_drafts(int);


-- ドラフトの操作を止めるのは、放置による破棄だけ。
-- 名前と引数は変えない（6か所から呼ばれているため）。
create or replace function public.assert_draft_not_expired(p_session_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_timer jsonb;
begin
  v_timer := public.draft_timer_json(p_session_id);
  if v_timer is null then
    return;
  end if;

  -- **予定終了時刻の超過では止めない。**制作は続けられる
  if (v_timer ->> 'is_discarded')::boolean then
    raise exception
      'DRAFT_DISCARDED: この制作は長いあいだ操作が無かったため、'
      '自動で破棄されました。新しいお題を引いてください。';
  end if;
end;
$fn$;

comment on function public.assert_draft_not_expired(uuid) is
  'ドラフトの操作を止める検査（2026-09-09 に猶予切れから放置破棄へ入れ替え）。'
  '名前は互換のため据え置き。予定終了時刻の超過では止めない。';

revoke all on function public.assert_draft_not_expired(uuid)
  from public, anon, authenticated;


create or replace function public.works_guard_prompt_deadline()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_timer jsonb;
begin
  v_timer := public.prompt_timer_json(new.prompt_id);

  if v_timer is null then
    return new;   -- 存在しないお題は create_work 側が先に断る
  end if;

  -- 過去に猶予切れで失敗になった行（2026-09-09 より前）はそのまま断る
  if (v_timer ->> 'status') = 'failed' then
    raise exception
      'PROMPT_EXPIRED: この挑戦は時間切れで終了しています。'
      '新しいお題を引いてください。';
  end if;

  -- **予定終了時刻を過ぎているだけなら通す。**超過中でも投稿できる
  if (v_timer ->> 'is_discarded')::boolean then
    raise exception
      'PROMPT_DISCARDED: この制作は長いあいだ操作が無かったため、'
      '自動で破棄されました。作品の画像やこれまでの記録は消えません。';
  end if;

  return new;
end;
$fn$;

comment on function public.works_guard_prompt_deadline() is
  '投稿の受け口の検査（2026-09-09 に猶予から放置破棄へ入れ替え）。'
  '予定終了時刻の超過では止めない。作品データは消さない。';


-- ============================================================================
-- 8. 掃除（予定超過の知らせ・24時間の予告・48時間の破棄）
-- ============================================================================
--
-- 【順番】
--   1. 予定終了時刻の超過を知らせる
--   2. 24時間の予告（まだ48時間に達していないものだけ）
--   3. 48時間の破棄
--   2 が 3 を除くので、50時間放置された作りかけに
--   「あと1日で消えます」と「消しました」を同時に送ることはない。

create or replace function public.notify_overrun_challenges(p_limit int default 200)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r     record;
  v_n   int := 0;
  v_lim int := greatest(1, coalesce(p_limit, 200));
begin
  for r in
    select 'prompt'::text as kind, p.id, p.created_by as uid, p.deadline_at,
           '/prompt/' || p.id::text as url
      from public.prompts p
     where p.status = 'active'
       and p.created_by is not null
       and p.time_limit_seconds is not null
       and p.deadline_at is not null
       and clock_timestamp() > p.deadline_at
       and clock_timestamp() <= (public.inactivity_marks(p.last_activity_at) ->> 'discard_at')::timestamptz
     union all
    select 'draft', ds.id, ds.user_id, ds.deadline_at, '/play'
      from public.draft_sessions ds
     where ds.status = 'in_progress'
       and ds.time_limit_seconds is not null
       and ds.deadline_at is not null
       and clock_timestamp() > ds.deadline_at
       and clock_timestamp() <= (public.inactivity_marks(ds.last_activity_at) ->> 'discard_at')::timestamptz
     limit v_lim
  loop
    if public.emit_notification(
         r.uid, 'deadline_overrun', r.kind, r.id,
         -- 延長すると予定終了時刻が変わるので、また知らせられる
         'overrun:' || r.kind || ':' || r.id::text || ':'
           || floor(extract(epoch from r.deadline_at))::bigint::text,
         '制作予定時間を超過しました',
         '制作はそのまま続けられます。必要なら延長できます。',
         'deadline',
         jsonb_build_object('url', r.url),
         true) is not null then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$fn$;

comment on function public.notify_overrun_challenges(int) is
  '予定終了時刻を過ぎた挑戦へ1回だけ知らせる（2026-09-09）。失敗にはしない。'
  '延長で予定時刻が変われば、また知らせる。';

revoke all on function public.notify_overrun_challenges(int)
  from public, anon, authenticated;
grant execute on function public.notify_overrun_challenges(int) to service_role;


create or replace function public.notify_inactive_challenges(p_limit int default 200)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r     record;
  v_n   int := 0;
  v_lim int := greatest(1, coalesce(p_limit, 200));
begin
  -- **絞り込みを SQL の側でやる。**
  --   先に上限だけ切ってから if で落とすと、進行中の挑戦が多い日に
  --   「上限のぶんを取ったが、どれも24時間に達していなかった」となり、
  --   予告を出すべき人がいつまでも拾われないことがある。
  for r in
    select * from (
      select 'prompt'::text as kind, p.id, p.created_by as uid,
             public.inactivity_marks(p.last_activity_at) as marks,
             '/prompt/' || p.id::text as url
        from public.prompts p
       where p.status = 'active' and p.created_by is not null
       union all
      select 'draft', ds.id, ds.user_id,
             public.inactivity_marks(ds.last_activity_at), '/play'
        from public.draft_sessions ds
       where ds.status = 'in_progress'
    ) t
     where clock_timestamp() >= (t.marks ->> 'warn_at')::timestamptz
       and clock_timestamp() <  (t.marks ->> 'discard_at')::timestamptz
     order by (t.marks ->> 'warn_at')::timestamptz
     limit v_lim
  loop
    if public.emit_notification(
         r.uid, 'inactivity_warning', r.kind, r.id,
         -- 制作を再開すると起点が動くので、次の周期でまた知らせられる
         'idle:' || r.kind || ':' || r.id::text || ':'
           || floor(extract(epoch from (r.marks ->> 'from_at')::timestamptz))::bigint::text,
         '制作途中のお題が1日間操作されていません',
         'あと1日で自動的に破棄されます。制作を再開すると、この期限は数え直します。',
         'inactivity',
         jsonb_build_object('url', r.url),
         true) is not null then
      v_n := v_n + 1;
    end if;
  end loop;

  return v_n;
end;
$fn$;

comment on function public.notify_inactive_challenges(int) is
  '最終有効操作から24時間で放置の予告を1回出す（2026-09-09）。'
  '既に48時間へ達しているものは出さない（破棄の知らせと重ならないように）。';

revoke all on function public.notify_inactive_challenges(int)
  from public, anon, authenticated;
grant execute on function public.notify_inactive_challenges(int) to service_role;


create or replace function public.discard_inactive_challenges(p_limit int default 200)
returns int
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r     record;
  v_n   int := 0;
  v_lim int := greatest(1, coalesce(p_limit, 200));
  v_now timestamptz;
begin
  for r in
    select * from (
      select 'prompt'::text as kind, p.id, p.created_by as uid,
             (public.inactivity_marks(p.last_activity_at) ->> 'discard_at')::timestamptz as at
        from public.prompts p
       where p.status = 'active' and p.created_by is not null
       union all
      select 'draft', ds.id, ds.user_id,
             (public.inactivity_marks(ds.last_activity_at) ->> 'discard_at')::timestamptz
        from public.draft_sessions ds
       where ds.status = 'in_progress'
    ) t
     where clock_timestamp() >= t.at
     order by t.at
     limit v_lim
  loop
    v_now := clock_timestamp();

    if r.kind = 'prompt' then
      update public.prompts p
         set status = 'discarded', discarded_at = greatest(v_now, p.created_at)
       where p.id = r.id and p.status = 'active';
    else
      update public.draft_sessions ds
         set status = 'discarded', discarded_at = greatest(v_now, ds.created_at)
       where ds.id = r.id and ds.status = 'in_progress';
    end if;

    perform public.emit_notification(
      r.uid, 'inactivity_discard', r.kind, r.id,
      'discard:' || r.kind || ':' || r.id::text,
      '制作途中のお題を自動的に破棄しました',
      '2日間操作がなかったため、制作途中のお題を自動的に破棄しました。',
      'inactivity',
      jsonb_build_object('url', '/play'),
      true);

    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$fn$;

comment on function public.discard_inactive_challenges(int) is
  '最終有効操作から48時間で作りかけを自動破棄する（2026-09-09）。'
  '破棄した事実は notification_events に残る（本体が消えても伝えられる）。';

revoke all on function public.discard_inactive_challenges(int)
  from public, anon, authenticated;
grant execute on function public.discard_inactive_challenges(int) to service_role;


-- ----------------------------------------------------------------------------
-- 掃除の窓を入れ替える
-- ----------------------------------------------------------------------------

create or replace function public.cleanup_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'orphan_prompts', (select count(*) from public.prompts p
                        where p.created_by is null
                          and p.status in ('active', 'abandoned')
                          and not exists (select 1 from public.works w
                                           where w.prompt_id = p.id)),
    -- 予定終了時刻を過ぎたが、まだ知らせていないもの（失敗にはしない）
    'unnotified_overrun', (
      select count(*) from public.prompts p
       where p.status = 'active' and p.created_by is not null
         and p.deadline_at is not null
         and clock_timestamp() > p.deadline_at
         and not exists (
           select 1 from public.notification_events e
            where e.dedupe_key = 'overrun:prompt:' || p.id::text || ':'
              || floor(extract(epoch from p.deadline_at))::bigint::text)),
    -- 48時間の放置に達しているのに、まだ破棄していないもの
    'pending_inactive_discard', (
      select count(*) from (
        select public.inactivity_marks(p.last_activity_at) as m from public.prompts p
         where p.status = 'active'
        union all
        select public.inactivity_marks(ds.last_activity_at) from public.draft_sessions ds
         where ds.status = 'in_progress') t
       where clock_timestamp() >= (t.m ->> 'discard_at')::timestamptz),
    'stale_drafts', (select count(*) from public.draft_sessions s
                      where (s.status = 'in_progress'
                             and s.updated_at < now() - interval '30 days')
                         or (s.status = 'abandoned'
                             and s.abandoned_at < now() - interval '30 days')
                         or (s.status = 'discarded'
                             and s.discarded_at < now() - interval '30 days')),
    'pending_push', (select count(*) from public.notification_deliveries d
                      where d.channel = 'web_push' and d.status = 'pending'),
    'expired_agreements', (select count(*) from public.terms_agreements a
                            where a.retain_until < now()),
    'pending_images', (select count(*) from public.storage_cleanup_queue q
                        where q.deleted_at is null),
    'pending_account_deletions', (select count(*) from public.account_deletions),
    'stale_guests', (select count(*) from public.profiles p
                      where p.is_anonymous and p.account_status = 'active'
                        and p.created_at < now() - interval '30 days'
                        and not exists (select 1 from public.draft_sessions s
                                         where s.user_id = p.id
                                           and s.updated_at > now() - interval '30 days')
                        and not exists (select 1 from public.works w
                                         where w.user_id = p.id)),
    'works_missing_image_cleanup', (select count(*) from public.works w
                                     where w.deleted_at is not null
                                       and w.image_path is not null
                                       and w.image_deleted_at is null)
  )
$$;

comment on function public.cleanup_status() is
  '掃除の残り件数（2026-09-09 に猶予切れの数え方を撤去し、超過の知らせ・'
  '放置の破棄・未送信のプッシュを足した）。';

revoke all on function public.cleanup_status() from public, anon, authenticated;
grant execute on function public.cleanup_status() to service_role;


-- 自動破棄した作りかけも、30日たったら実体を消す。
-- **知らせは残る**（notification_events は外部キーを張っていない）。
create or replace function public.cleanup_stale_drafts(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  with target as (
    select s.id
      from public.draft_sessions s
     where (s.status = 'in_progress' and s.updated_at    < now() - interval '30 days')
        or (s.status = 'abandoned'   and s.abandoned_at  < now() - interval '30 days')
        or (s.status = 'discarded'   and s.discarded_at  < now() - interval '30 days')
     limit greatest(coalesce(p_limit, 500), 1)
  )
  delete from public.draft_sessions s
   using target t
   where s.id = t.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.cleanup_stale_drafts(int) is
  '30日以上動いていないドラフトを消す（2026-09-09 に自動破棄ぶんを追加）。'
  'completed は消さない。破棄した事実の記録は消えない。';

revoke all on function public.cleanup_stale_drafts(int) from public, anon, authenticated;
grant execute on function public.cleanup_stale_drafts(int) to service_role;


-- ----------------------------------------------------------------------------
-- 全ページの帯が読むもの
-- ----------------------------------------------------------------------------
--
-- 破棄された挑戦は返さない。**掃除が回る前でも返さない**
-- （時計が is_discarded を立てた時点で、もう活きていない）。

create or replace function public.get_active_challenge(
  p_finished_window_seconds int default 1800
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_id    uuid;
  v_timer jsonb;
  v_work  uuid;
  v_win   int := greatest(0, coalesce(p_finished_window_seconds, 1800));
begin
  if v_uid is null then
    return null;
  end if;

  -- 1. 進行中のドラフト
  select ds.id into v_id
    from public.draft_sessions ds
   where ds.user_id = v_uid
     and ds.status = 'in_progress'
   order by ds.started_at desc
   limit 1;

  if v_id is not null then
    v_timer := public.draft_timer_json(v_id);
    if not (v_timer ->> 'is_discarded')::boolean then
      return v_timer
        || jsonb_build_object(
             'kind',        'draft',
             'id',          v_id,
             'href',        '/play',
             'is_finished', false,
             'work_id',     null);
    end if;
  end if;

  -- 2. 進行中の確定お題
  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid
     and p.status = 'active'
   order by p.started_at desc
   limit 1;

  if v_id is not null then
    v_timer := public.prompt_timer_json(v_id);
    if not (v_timer ->> 'is_discarded')::boolean then
      return v_timer
        || jsonb_build_object(
             'kind',        'prompt',
             'id',          v_id,
             'href',        '/prompt/' || v_id::text,
             'is_finished', false,
             'work_id',     null);
    end if;
  end if;

  -- 3. 直近に終わった挑戦（かかった時間を出すため）
  select p.id into v_id
    from public.prompts p
   where p.created_by = v_uid
     and p.status in ('submitted', 'failed')
     and coalesce(p.submitted_at, p.failed_at)
         > clock_timestamp() - make_interval(secs => v_win)
   order by coalesce(p.submitted_at, p.failed_at) desc
   limit 1;

  if v_id is null then
    return null;
  end if;

  select w.id into v_work from public.works w where w.prompt_id = v_id;

  v_timer := public.prompt_timer_json(v_id);
  return v_timer
    || jsonb_build_object(
         'kind',        'prompt',
         'id',          v_id,
         'href',        case when v_work is null then '/prompt/' || v_id::text
                             else '/works/' || v_work::text end,
         'is_finished', true,
         'work_id',     v_work);
end;
$fn$;

comment on function public.get_active_challenge(int) is
  'いまの制作挑戦の時間の状態を1件返す（2026-09-09 に破棄済みを外した）。'
  '予定終了時刻を過ぎていても返す。お題の語も他人の挑戦も返さない。';

revoke all on function public.get_active_challenge(int)
  from public, anon, authenticated;
grant execute on function public.get_active_challenge(int) to authenticated;


create or replace function public.renew_current_challenge()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_id  uuid;
  v_r   jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id into v_id
    from public.draft_sessions ds
   where ds.user_id = v_uid and ds.status = 'in_progress'
   order by ds.started_at desc
   limit 1;

  if v_id is not null then
    v_r := public.renew_draft_deadline(v_id);
  else
    select p.id into v_id
      from public.prompts p
     where p.created_by = v_uid and p.status = 'active'
     order by p.started_at desc
     limit 1;

    if v_id is null then
      raise exception 'NO_ACTIVE_CHALLENGE: いま進行中の制作挑戦がありません。';
    end if;

    v_r := public.renew_prompt_deadline(v_id);
  end if;

  -- 延ばした量と新しい終了予定を、帯がそのまま文にできる形で返す
  return public.get_active_challenge()
    || jsonb_build_object(
         'renewed',         true,
         'granted_seconds', v_r -> 'granted_seconds',
         'deadline_before', v_r -> 'deadline_before',
         'deadline_after',  v_r -> 'deadline_after');
end;
$fn$;

comment on function public.renew_current_challenge() is
  'いまの制作挑戦の時間を延ばす（2026-09-09）。'
  '延ばした量と新しい終了予定を一緒に返すので、画面はその場で結果を出せる。';

revoke all on function public.renew_current_challenge()
  from public, anon, authenticated;
grant execute on function public.renew_current_challenge() to authenticated;


-- ============================================================================
-- 9. 実制作時間は自己申告をやめ、計測値だけを使う
-- ============================================================================
--
-- 【なぜトリガーなのか】
--   画面から入力欄を消しても、フォームを直接叩けば値を送れる。
--   **受け口で上書きしないと、記録を書き換えられる穴が残る。**
--   works へ行が入る経路が将来増えても、必ずここを通る。
--
-- 【何を計測値とするか】
--   お題の開始（started_at）から投稿までの実経過。
--   延長したぶんは経過に含まれる（延長しても開始時刻は動かないため）。
--
-- 【3つとも後から復元できること】
--   最初に選んだ制作時間 … prompts.time_limit_seconds
--   実際に使った延長     … challenge_renewals（1回ごとに前後の期限が残る）
--   実経過               … prompts.started_at と works.created_at の差
--   どれも既にあるので、新しい表は作らない。

create or replace function public.works_set_measured_time()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_start timestamptz;
  v_secs  bigint;
begin
  if tg_op = 'UPDATE' then
    -- **投稿したあとに書き換えさせない。**古い値をそのまま残す
    new.actual_time_seconds := old.actual_time_seconds;
    return new;
  end if;

  select coalesce(p.started_at, p.created_at) into v_start
    from public.prompts p where p.id = new.prompt_id;

  if v_start is null then
    new.actual_time_seconds := null;
    return new;
  end if;

  v_secs := floor(extract(epoch from (clock_timestamp() - v_start)))::bigint;

  -- 列の制約は 1〜600000 秒。範囲へ収める
  new.actual_time_seconds := least(greatest(v_secs, 1), 600000)::int;
  return new;
end;
$fn$;

comment on function public.works_set_measured_time() is
  '実制作時間を計測値で埋める（2026-09-09）。利用者の申告値は受け取らない。'
  '投稿後の書き換えも受け付けない。';

revoke all on function public.works_set_measured_time() from public, anon, authenticated;

drop trigger if exists works_set_measured_time_trigger on public.works;
create trigger works_set_measured_time_trigger
  before insert or update on public.works
  for each row
  execute function public.works_set_measured_time();


-- 投稿画面が「計測された値」を出すために読む。**入力欄の代わり。**
create or replace function public.get_production_time(p_prompt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_p     record;
  v_grant bigint;
begin
  select p.id, p.created_by, p.time_limit_seconds, p.started_at, p.created_at,
         p.renew_count, p.submitted_at, p.status
    into v_p
    from public.prompts p
   where p.id = p_prompt_id;

  if not found or v_p.created_by is distinct from (select auth.uid()) then
    return null;
  end if;

  select coalesce(sum(
           floor(extract(epoch from (r.deadline_after - greatest(r.deadline_before, r.renewed_at))))
         ), 0)::bigint
    into v_grant
    from public.challenge_renewals r
   where r.kind = 'prompt' and r.challenge_id = p_prompt_id;

  return jsonb_build_object(
    'chosen_limit_seconds', v_p.time_limit_seconds,
    'renew_count',          coalesce(v_p.renew_count, 0),
    'granted_seconds',      v_grant,
    'elapsed_seconds',
      floor(extract(epoch from (coalesce(v_p.submitted_at, clock_timestamp())
                                - coalesce(v_p.started_at, v_p.created_at))))::bigint,
    'is_measured',          true);
end;
$fn$;

comment on function public.get_production_time(uuid) is
  '制作時間の計測値（2026-09-09）。最初に選んだ時間・延長の合計・実経過。'
  '自分のお題だけ読める。投稿画面はこれを表示するだけで、入力は受け取らない。';

revoke all on function public.get_production_time(uuid) from public, anon, authenticated;
grant execute on function public.get_production_time(uuid) to authenticated;


-- ============================================================================
-- 10. 当てたその場で確かめる
-- ============================================================================
--
-- **当たったかどうかを、あとから人が目で確かめる作りにしない。**
-- ここで数が合わなければ migration ごと失敗する。

do $$
declare
  v_n int;
begin
  select count(*) into v_n from public.draft_lifecycle_policy;
  if v_n <> 2 then
    raise exception '放置の期限が2件ではない（実際 %）', v_n;
  end if;

  if public.lifecycle_seconds('inactivity_warn_seconds') <> 86400
     or public.lifecycle_seconds('inactivity_discard_seconds') <> 172800 then
    raise exception '放置の期限が 24時間 / 48時間 になっていない';
  end if;

  select count(*) into v_n
    from information_schema.columns
   where table_schema = 'public'
     and column_name = 'last_activity_at'
     and table_name in ('prompts', 'draft_sessions')
     and is_nullable = 'NO';
  if v_n <> 2 then
    raise exception '最終有効操作の列が2つそろっていない（実際 %）', v_n;
  end if;

  select count(*) into v_n
    from pg_constraint
   where conname in ('prompts_status_valid', 'draft_sessions_status_valid')
     and pg_get_constraintdef(oid) like '%discarded%';
  if v_n <> 2 then
    raise exception '「破棄済み」の状態が2つの表に入っていない（実際 %）', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('expire_overdue_prompts', 'expire_overdue_drafts');
  if v_n <> 0 then
    raise exception '超過で失敗にする掃除が残っている（実際 %）', v_n;
  end if;

  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'timer_core_json';
  if v_n <> 1 then
    raise exception '時計の中心が1本になっていない（実際 %）', v_n;
  end if;

  select count(*) into v_n from public.time_policy
   where policy_key in ('grace_ratio', 'renew_threshold_ratio');
  if v_n <> 0 then
    raise exception '猶予と更新可能化の係数が残っている（実際 %）', v_n;
  end if;

  select count(*) into v_n
    from information_schema.tables
   where table_schema = 'public'
     and table_name in ('notification_events', 'notification_deliveries',
                        'push_subscriptions', 'draft_lifecycle_policy');
  if v_n <> 4 then
    raise exception '通知の表が4つそろっていない（実際 %）', v_n;
  end if;

  select count(*) into v_n
    from pg_trigger
   where tgname = 'works_set_measured_time_trigger' and not tgisinternal;
  if v_n <> 1 then
    raise exception '実制作時間を計測値で埋めるトリガーが無い（実際 %）', v_n;
  end if;

  raise notice '20260909150000 自己検査 合格';
end $$;


-- ============================================================================
-- 戻し方（この migration を取り消したいとき）
-- ============================================================================
--
--   1. 通知の表を落とす
--        drop table public.notification_deliveries;
--        drop table public.notification_events;
--        drop table public.push_subscriptions;
--        drop table public.draft_lifecycle_policy;
--   2. 20260905093000_renewal_history.sql の renew_prompt_deadline /
--      renew_draft_deadline を再実行する（猶予つきの式に戻る）
--   3. 20260905090000_challenge_clock.sql の timer_core_json /
--      prompt_timer_json / draft_timer_json / assert_draft_not_expired /
--      get_active_challenge / renew_current_challenge / expire_overdue_drafts
--      を再実行する
--   4. 20260904094000_time_overrun_renewal.sql の expire_overdue_prompts /
--      works_guard_prompt_deadline を再実行し、
--      time_policy へ grace_ratio と renew_threshold_ratio を入れ直す
--   5. 列と状態を戻す
--        drop trigger works_set_measured_time_trigger on public.works;
--        alter table public.prompts        drop column last_activity_at, drop column discarded_at;
--        alter table public.draft_sessions drop column last_activity_at, drop column discarded_at;
--      （status = 'discarded' の行は先に 'abandoned' へ移すこと）
--
-- **作品の画像・作品行・回答・お題の語には、この migration は一切触っていない。**
