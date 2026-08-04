-- ============================================================================
-- cleanup_jobs ／ 定期的な掃除（Step 16）
-- ============================================================================
--
-- 【このファイルがやること】
--   掃除の RPC を8本足す。**呼べるのは service_role だけ。**
--
--     1. 持ち主のいないお題を消す（P4）
--     2. 古いドラフトを消す
--     3. 保存期限を過ぎた同意の記録を消す
--     4. 消し残した作品画像を掃除待ちに積む
--     5. 掃除待ちの画像を取り出す／終わりを記録する
--     6. auth.users を消せていない退会を取り出す／終わりを記録する
--     7. 30日以上使われていないゲストを取り出す
--     8. 掃除の状況をまとめて見る
--
-- 【このファイルがやらないこと】
--   ・**auth.users を消さない。**それはサーバー側の Admin API が行う（D75）
--   ・作品・回答・集計・通報を消さない
--   ・利用者向けの権限を1つも配らない
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/021_cleanup_jobs_rollback.sql
--
--
-- ============================================================================
-- なぜ「消す」と「一覧を返す」を分けるか
-- ============================================================================
--
--   SQL だけで終わる掃除（お題・ドラフト・同意記録）は、その場で消す。
--
--   Storage と auth.users は SQL では消せない。だから DB 側は
--   **「まだ終わっていないものの一覧」を返すだけ**にして、
--   実際に消すのはサーバー側にする。
--
--   終わったことの記録も分ける。消せたものだけに印を付ければ、
--   **失敗したものは自然に次回へ持ち越される。**
--   「どこまで進んだか」を別に管理する必要が無い。
--
--
-- ============================================================================
-- 上限を必ず取るのはなぜか
-- ============================================================================
--
--   全部の RPC が p_limit を取る。放っておくと溜まるものを扱うので、
--   1回の実行で触る量に必ず天井を作る。
--
--   天井が無いと、溜まったぶんを一度に処理しようとして時間切れになり、
--   **1件も片づかないまま毎回失敗する**という状態に入りうる。
--   少しずつでも減っていくほうがよい。
--
-- ============================================================================




-- ----------------------------------------------------------------------------
-- 1. 持ち主のいないお題を消す（P4）
-- ----------------------------------------------------------------------------
--
-- ゲストが掃除されると prompts.created_by が null になる（set null）。
-- この行は RLS の created_by = auth.uid() が真にならないので**誰からも見えず**、
-- 放っておくと増え続けるだけになる。
--
-- 【消してよい条件（すべて満たすもの）】
--   1. created_by is null      … 持ち主がいない
--   2. 作品から参照されていない … 作品が付いていれば消せない（restrict）
--   3. status が active か abandoned
--
-- **status = 'submitted' なのに作品が無い行は消さない。**
-- 投稿済みのはずの作品が失われている状態で、原因を調べる必要がある
-- （診断 A5 が拾う）。掃除で消すと、その手がかりまで消える。
--
-- prompt_cards / quiz_questions / quiz_choices は cascade で一緒に消える。

create or replace function public.cleanup_orphan_prompts(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  with target as (
    select p.id
      from public.prompts p
     where p.created_by is null
       and p.status in ('active', 'abandoned')
       and not exists (select 1 from public.works w where w.prompt_id = p.id)
     limit greatest(coalesce(p_limit, 500), 1)
  )
  delete from public.prompts p
   using target t
   where p.id = t.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.cleanup_orphan_prompts(int) is
  '持ち主がいなくて作品も付いていないお題を消す（P4）。'
  'status = submitted は消さない（作品が失われた手がかりを残すため）。';

revoke all on function public.cleanup_orphan_prompts(int) from public, anon, authenticated;
grant execute on function public.cleanup_orphan_prompts(int) to service_role;


-- ----------------------------------------------------------------------------
-- 2. 古いドラフトを消す
-- ----------------------------------------------------------------------------
--
-- spec 8-3 の掃除の規則。
--   in_progress … 最終操作から30日（updated_at）
--   abandoned   … 放棄から30日（abandoned_at）
--   completed   … **消さない**（未選択カードの後日開示に候補が要る）
--
-- draft_candidates は cascade で一緒に消える。
-- prompts.draft_session_id は set null なので、確定したお題は残る。

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
     where (s.status = 'in_progress' and s.updated_at   < now() - interval '30 days')
        or (s.status = 'abandoned'   and s.abandoned_at < now() - interval '30 days')
     limit greatest(coalesce(p_limit, 500), 1)
  )
  delete from public.draft_sessions s
   using target t
   where s.id = t.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.cleanup_stale_drafts(int) is
  '30日以上動いていないドラフトを消す。completed は消さない。';

revoke all on function public.cleanup_stale_drafts(int) from public, anon, authenticated;
grant execute on function public.cleanup_stale_drafts(int) to service_role;


-- ----------------------------------------------------------------------------
-- 3. 保存期限を過ぎた同意の記録を消す
-- ----------------------------------------------------------------------------
--
-- 「無期限には持たない」と決めた（D74）。決めただけでは減らないので、
-- **実際に消す仕掛けをここに置く。**
-- プライバシーポリシーに「5年」と書いてあるものを、そのとおりにする。

create or replace function public.cleanup_expired_agreements(p_limit int default 1000)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted int;
begin
  with target as (
    select a.id
      from public.terms_agreements a
     where a.retain_until < now()
     limit greatest(coalesce(p_limit, 1000), 1)
  )
  delete from public.terms_agreements a
   using target t
   where a.id = t.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

comment on function public.cleanup_expired_agreements(int) is
  '保存期限を過ぎた同意の記録を消す。ポリシーに書いた5年をそのとおりにする。';

revoke all on function public.cleanup_expired_agreements(int) from public, anon, authenticated;
grant execute on function public.cleanup_expired_agreements(int) to service_role;


-- ----------------------------------------------------------------------------
-- 4. 消し残した作品画像を掃除待ちに積む
-- ----------------------------------------------------------------------------
--
-- Step 15 の削除は、Storage の削除に失敗すると image_deleted_at を
-- 立てないまま終わる（それが再試行の手がかりになる）。
-- ここでその作品を拾い、退会と同じ掃除待ちの列に積む。
--
-- **image_path は消さない。**Step 15 の削除は作品の行を残すので、
-- 消してしまうと「どのファイルだったか」を二度と辿れなくなる。
-- 消せたことは image_deleted_at で表す。

create or replace function public.enqueue_orphan_work_images(p_limit int default 500)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_added int;
begin
  with target as (
    select w.image_path
      from public.works w
     where w.deleted_at is not null
       and w.image_path is not null
       and w.image_deleted_at is null
     limit greatest(coalesce(p_limit, 500), 1)
  )
  insert into public.storage_cleanup_queue (bucket, path)
  select 'works', t.image_path from target t
  on conflict (bucket, path) do nothing;

  get diagnostics v_added = row_count;
  return v_added;
end $$;

comment on function public.enqueue_orphan_work_images(int) is
  '削除済みなのに画像が残っている作品を、掃除待ちの列に積む。';

revoke all on function public.enqueue_orphan_work_images(int) from public, anon, authenticated;
grant execute on function public.enqueue_orphan_work_images(int) to service_role;


-- ----------------------------------------------------------------------------
-- 5. 掃除待ちの画像
-- ----------------------------------------------------------------------------
--
-- 何度も失敗しているものを後回しにする。壊れた1件のせいで
-- **後ろに並んでいるものが永久に処理されない**のを避ける。

create or replace function public.list_pending_storage_objects(p_limit int default 100)
returns table (id bigint, bucket text, path text, attempts int)
language sql
stable
security definer
set search_path = ''
as $$
  select q.id, q.bucket, q.path, q.attempts
    from public.storage_cleanup_queue q
   where q.deleted_at is null
   order by q.attempts asc, q.enqueued_at asc
   limit greatest(coalesce(p_limit, 100), 1)
$$;

revoke all on function public.list_pending_storage_objects(int) from public, anon, authenticated;
grant execute on function public.list_pending_storage_objects(int) to service_role;


-- 消せた印。作品側にも印を付けておく（次から拾わないように）。
create or replace function public.mark_storage_object_done(p_id bigint)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
begin
  update public.storage_cleanup_queue q
     set deleted_at = now(), last_error = null
   where q.id = p_id
  returning q.path into v_path;

  if v_path is not null then
    update public.works w
       set image_deleted_at = coalesce(w.image_deleted_at, now())
     where w.image_path = v_path;
  end if;
end $$;

revoke all on function public.mark_storage_object_done(bigint) from public, anon, authenticated;
grant execute on function public.mark_storage_object_done(bigint) to service_role;


create or replace function public.mark_storage_object_failed(p_id bigint, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.storage_cleanup_queue q
     set attempts = q.attempts + 1,
         last_error = left(coalesce(p_error, ''), 500)
   where q.id = p_id
$$;

revoke all on function public.mark_storage_object_failed(bigint, text) from public, anon, authenticated;
grant execute on function public.mark_storage_object_failed(bigint, text) to service_role;


-- ----------------------------------------------------------------------------
-- 6. auth.users を消せていない退会
-- ----------------------------------------------------------------------------

create or replace function public.list_pending_account_deletions(p_limit int default 50)
returns table (user_id uuid, requested_at timestamptz, attempts int, last_error text)
language sql
stable
security definer
set search_path = ''
as $$
  select d.user_id, d.requested_at, d.attempts, d.last_error
    from public.account_deletions d
   order by d.attempts asc, d.requested_at asc
   limit greatest(coalesce(p_limit, 50), 1)
$$;

revoke all on function public.list_pending_account_deletions(int) from public, anon, authenticated;
grant execute on function public.list_pending_account_deletions(int) to service_role;


-- 消せたら記録ごと消す。**残す必要が無いものは残さない。**
create or replace function public.finish_account_deletion(p_user_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.account_deletions d where d.user_id = p_user_id
$$;

revoke all on function public.finish_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.finish_account_deletion(uuid) to service_role;


create or replace function public.fail_account_deletion(p_user_id uuid, p_error text)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.account_deletions d
     set attempts = d.attempts + 1,
         last_error = left(coalesce(p_error, ''), 500)
   where d.user_id = p_user_id
$$;

revoke all on function public.fail_account_deletion(uuid, text) from public, anon, authenticated;
grant execute on function public.fail_account_deletion(uuid, text) to service_role;


-- ----------------------------------------------------------------------------
-- 7. 使われていないゲストを取り出す
-- ----------------------------------------------------------------------------
--
-- ゲストはメールを持たず、ブラウザのデータを消せば二度と戻れない。
-- 放っておくと auth.users が増え続けるだけなので、30日で片づける。
--
-- 【消してよい条件】
--   ・匿名である
--   ・作られてから30日以上たっている
--   ・**30日以内に動いたドラフトを持っていない**
--   ・作品を持っていない
--
-- 最後の条件は本来ありえない（ゲストは投稿できない）が、念のため入れる。
-- 作品を持つ人を消すと works.user_id が null になり、
-- **works_owner_or_deleted に引っかかって削除そのものが失敗する。**
-- 制約が守ってくれるが、失敗する前に除いておく。
--
-- 消した結果、その人が答えた回答は user_id が null になって残り、
-- 引いたお題は created_by が null になって第1節の掃除対象になる。

create or replace function public.list_stale_guests(p_limit int default 100)
returns table (user_id uuid, created_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, p.created_at
    from public.profiles p
   where p.is_anonymous
     and p.account_status = 'active'
     and p.created_at < now() - interval '30 days'
     and not exists (
       select 1 from public.draft_sessions s
        where s.user_id = p.id and s.updated_at > now() - interval '30 days')
     and not exists (select 1 from public.works w where w.user_id = p.id)
   order by p.created_at asc
   limit greatest(coalesce(p_limit, 100), 1)
$$;

comment on function public.list_stale_guests(int) is
  '30日以上使われていないゲスト。実際に消すのは Admin API（D75）。';

revoke all on function public.list_stale_guests(int) from public, anon, authenticated;
grant execute on function public.list_stale_guests(int) to service_role;


-- ----------------------------------------------------------------------------
-- 8. 掃除の状況
-- ----------------------------------------------------------------------------
--
-- 掃除が動いているかを1回の問い合わせで見るためのもの。
-- **数が減っていることを確認する手段が無いと、動いていないことに気づけない。**

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
    'stale_drafts', (select count(*) from public.draft_sessions s
                      where (s.status = 'in_progress'
                             and s.updated_at < now() - interval '30 days')
                         or (s.status = 'abandoned'
                             and s.abandoned_at < now() - interval '30 days')),
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
  '掃除の残り件数。減っていることを確かめるための窓。';

revoke all on function public.cleanup_status() from public, anon, authenticated;
grant execute on function public.cleanup_status() to service_role;




-- ============================================================================
-- 9. 検算
-- ============================================================================

do $$
declare
  v_funcs int;
  v_open  int;
begin
  select count(*)::int into v_funcs
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('cleanup_orphan_prompts', 'cleanup_stale_drafts',
                       'cleanup_expired_agreements', 'enqueue_orphan_work_images',
                       'list_pending_storage_objects', 'mark_storage_object_done',
                       'mark_storage_object_failed', 'list_pending_account_deletions',
                       'finish_account_deletion', 'fail_account_deletion',
                       'list_stale_guests', 'cleanup_status');

  if v_funcs <> 12 then
    raise exception '掃除の関数が12本ではありません（実際 %）', v_funcs;
  end if;

  -- 利用者から呼べるものが1つも無いこと。
  -- 対象は上と同じ12本。and と or を混ぜると読み違えるので、
  -- 名前の一覧を1つの in で書く。
  select count(*)::int into v_open
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('cleanup_orphan_prompts', 'cleanup_stale_drafts',
                       'cleanup_expired_agreements', 'enqueue_orphan_work_images',
                       'list_pending_storage_objects', 'mark_storage_object_done',
                       'mark_storage_object_failed', 'list_pending_account_deletions',
                       'finish_account_deletion', 'fail_account_deletion',
                       'list_stale_guests', 'cleanup_status')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if v_open <> 0 then
    raise exception '掃除の関数のうち % 本を利用者が呼べます', v_open;
  end if;

  raise notice '── 掃除の関数 12本 OK（利用者からは呼べない）──';
end $$;
