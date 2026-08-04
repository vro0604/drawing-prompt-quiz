-- ============================================================================
-- 022_concurrent_write_guards_rollback.sql
--   20260804160000_concurrent_write_guards.sql を元に戻す
-- ============================================================================
--
-- 【戻すとどうなるか】
--   いいね・お気に入りを同時に押したとき、また
--
--     duplicate key value violates unique constraint "likes_pkey"
--
--   が利用者の画面に出るようになる。**戻す理由がなければ戻さないこと。**
--
-- 【表・列・権限は触っていない】
--   この migration は関数3本の中身しか変えていないので、
--   戻すのも関数だけ。データは一切動かない。
--
-- 【使いかた】
--   Supabase の SQL Editor に貼って実行する。
--   このファイルは supabase/migrations/ に置かないこと（自動適用されてしまう）。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. toggle_like を on conflict の無い形へ戻す
-- ----------------------------------------------------------------------------

create or replace function public.toggle_like(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_liked boolean;
  v_count int;
begin

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_LIKE: いいねにはアカウント登録が必要です。'
      'クイズの回答はゲストのままできます。';
  end if;

  if not exists (
    select 1 from public.works w
     where w.id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ) then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  delete from public.likes l
   where l.work_id = p_work_id and l.user_id = v_uid;

  if found then
    v_liked := false;
  else
    insert into public.likes (work_id, user_id) values (p_work_id, v_uid);
    v_liked := true;
  end if;

  select w.likes_count into v_count from public.works w where w.id = p_work_id;

  return jsonb_build_object('work_id', p_work_id, 'liked', v_liked, 'likes_count', v_count);
end;
$fn$;

comment on function public.toggle_like(uuid) is
  'いいねを付ける／外す。登録ユーザーのみ（D7）。公開作品だけが対象。';


-- ----------------------------------------------------------------------------
-- 2. toggle_save を元へ戻す
-- ----------------------------------------------------------------------------

create or replace function public.toggle_save(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_saved boolean;
  v_count int;
begin

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_SAVE: お気に入りにはアカウント登録が必要です。'
      'クイズの回答はゲストのままできます。';
  end if;

  if not exists (
    select 1 from public.works w
     where w.id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ) then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  delete from public.saves s
   where s.work_id = p_work_id and s.user_id = v_uid;

  if found then
    v_saved := false;
  else
    insert into public.saves (work_id, user_id) values (p_work_id, v_uid);
    v_saved := true;
  end if;

  select w.saves_count into v_count from public.works w where w.id = p_work_id;

  return jsonb_build_object('work_id', p_work_id, 'saved', v_saved, 'saves_count', v_count);
end;
$fn$;

comment on function public.toggle_save(uuid) is
  '保存を付ける／外す。登録ユーザーのみ。公開作品だけが対象。'
  '保存一覧を他人へ見せるかは profiles.show_saved_works が決める（get_public_saves）。';


-- ----------------------------------------------------------------------------
-- 3. submit_answer の包みを外す
-- ----------------------------------------------------------------------------
--
-- 適用のときと同じく、いま入っている定義から該当箇所だけを戻す。

do $rb$
declare
  v_src text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_answer';

  if v_src is null then
    raise exception 'submit_answer が見つかりません。';
  end if;

  if v_src not ilike '%when unique_violation%' then
    raise notice 'submit_answer は包まれていません。何もしません。';
    return;
  end if;

  v_new := regexp_replace(
    v_src,
    'begin\s*insert into public\.answers \(work_id, user_id, correct_count\)\s*'
    'values \(p_work_id, v_uid, v_correct_count\)\s*'
    'returning id into v_answer_id;\s*'
    'exception when unique_violation then\s*'
    'raise exception ''ALREADY_ANSWERED:[^'']*'';\s*'
    'end;',
    'insert into public.answers (work_id, user_id, correct_count) '
    'values (p_work_id, v_uid, v_correct_count) '
    'returning id into v_answer_id;'
  );

  if v_new = v_src then
    raise exception 'submit_answer の包みが見つかりませんでした。手で確かめてください。';
  end if;

  execute v_new;
end
$rb$;
