-- ============================================================================
-- 20260804160000_concurrent_write_guards.sql
--   同じ操作が同時に届いたときに、素の Postgres エラーを外へ出さない
-- ============================================================================
--
-- 【直すもの】
--   toggle_like / toggle_save / submit_answer の3本。
--
-- 【何が起きていたか】
--   3本とも「いまの状態を見てから書く」形になっている。
--
--     delete ... ;
--     if found then 外した
--                else insert ...        ← ここ
--
--   見てから書くまでのすき間に同じ操作が並ぶと、両方が
--   「まだ無い」と判断して両方が insert する。あとの1つが
--   一意索引に当たり、**利用者の画面に**
--
--     duplicate key value violates unique constraint "likes_pkey"
--
--   がそのまま出ていた。公開前デバッグで実際に再現した
--   （いいねボタンを同時に4回押すと2回目が失敗する）。
--
--   これは机上の話ではない。いいねは1つのボタンで、押すとページが
--   描き直される。**利用者が二度押しするのはごくふつうの操作**。
--
-- 【なぜ内部の言葉が出るのが問題か】
--   1. 利用者に意味が通じない。何が起きたのか分からず、
--      壊れたのかと思って離れる
--   2. 表と制約の名前が外へ出る。攻める側にとっては
--      構造を知る手がかりになる
--
-- 【直しかた】
--   この工程には**すでに正しい書き方がある**。create_report は
--   insert を begin ... exception when unique_violation で包み、
--   'REPORT_ALREADY_SENT: この作品はすでに報告済みです。' に
--   置き換えている（20260803213330）。新しい流儀を持ち込まず、
--   同じ形を残りの3本へ広げる。
--
--   ただし「正しい結果」は操作ごとに違う。
--
--   ・いいね／お気に入り … **入れ替える操作**。二度押しの結果は
--     どちらに転んでもよいが、**エラーにしてはいけない**。
--     on conflict do nothing で「付いている」状態に落ち着かせる。
--     件数はトリガーが実際の行数から数えるので、ずれない。
--
--   ・回答 … **1作品につき1回だけ**（spec 9-6）。2件目は
--     受け付けてはいけないので、事前検査と同じ
--     'ALREADY_ANSWERED' に変換して断る。
--
-- 【この migration が変えないもの】
--   ・表・列・索引・権限は一切変えない（関数の中身だけ）
--   ・判定の条件、返り値の形、権限の付け方は元のまま
--   ・再実行しても同じ結果になる（create or replace）
--
-- 【元に戻すには】
--   supabase/rollback/022_concurrent_write_guards_rollback.sql
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. toggle_like
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

  -- 登録ユーザーだけ（D7 / spec 10）。判定は JWT だけを見る。
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_LIKE: いいねにはアカウント登録が必要です。'
      'クイズの回答はゲストのままできます。';
  end if;

  -- 押せるのは公開作品だけ。条件は get_work_detail と同じ。
  if not exists (
    select 1 from public.works w
     where w.id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ) then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  -- いま付いていれば外し、付いていなければ付ける。
  delete from public.likes l
   where l.work_id = p_work_id and l.user_id = v_uid;

  if found then
    v_liked := false;
  else
    -- **on conflict do nothing がこの migration の要点。**
    -- 同時に押されて、もう片方が先に入れていたときは何もしない。
    -- 二度押しの結末は「付いている」。エラーにはしない。
    insert into public.likes (work_id, user_id)
    values (p_work_id, v_uid)
    on conflict (work_id, user_id) do nothing;

    v_liked := true;
  end if;

  -- トリガーが更新したあとの件数を読み直して返す。
  -- 自分で数え直さないのは、控えと実数がずれていたときに
  -- 画面だけ辻褄が合ってしまい、ずれに気づけなくなるため。
  select w.likes_count into v_count from public.works w where w.id = p_work_id;

  return jsonb_build_object('work_id', p_work_id, 'liked', v_liked, 'likes_count', v_count);
end;
$fn$;

comment on function public.toggle_like(uuid) is
  'いいねを付ける／外す。登録ユーザーのみ（D7）。公開作品だけが対象。'
  '同時に押されても例外にしない（on conflict do nothing）。';


-- ----------------------------------------------------------------------------
-- 2. toggle_save
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
    insert into public.saves (work_id, user_id)
    values (p_work_id, v_uid)
    on conflict (work_id, user_id) do nothing;

    v_saved := true;
  end if;

  select w.saves_count into v_count from public.works w where w.id = p_work_id;

  return jsonb_build_object('work_id', p_work_id, 'saved', v_saved, 'saves_count', v_count);
end;
$fn$;

comment on function public.toggle_save(uuid) is
  '保存を付ける／外す。登録ユーザーのみ。公開作品だけが対象。'
  '保存一覧を他人へ見せるかは profiles.show_saved_works が決める（get_public_saves）。'
  '同時に押されても例外にしない（on conflict do nothing）。';


-- ----------------------------------------------------------------------------
-- 3. submit_answer の保存部分だけを包み直す
-- ----------------------------------------------------------------------------
--
-- **関数全体は元のまま。**採点も集計も触らない。
-- 変えるのは answers への insert を begin ... exception で包む一点だけ。
--
-- 回答は入れ替える操作ではないので do nothing にはできない。
-- 2件目は断るのが正しく、そのときの文言は事前検査と同じにする
-- （利用者から見て、速く二度押ししたかどうかで説明が変わらないように）。

-- 【なぜ関数全体を書き直さずに置き換えるか】
--   submit_answer は採点・集計・診断のために200行近くある。
--   ここへ全文を写すと、写し間違いが混ざったときに
--   **採点そのものが静かに壊れる。**変えたいのは insert の3行だけなので、
--   いま DB に入っている定義を読み、その一箇所だけを差し替える。
--
--   空白や改行の入りかたに引きずられないよう、照合は正規表現で行う。
--   1件も置き換わらなければ例外にして巻き戻す（黙って素通ししない）。

do $mig$
declare
  v_src text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_src
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_answer';

  if v_src is null then
    raise exception 'submit_answer が見つかりません。適用の順番が違う可能性があります。';
  end if;

  if v_src ilike '%when unique_violation%' then
    raise notice 'submit_answer はすでに包まれています。何もしません。';
    return;
  end if;

  v_new := regexp_replace(
    v_src,
    'insert into public\.answers \(work_id, user_id, correct_count\)\s*'
    'values \(p_work_id, v_uid, v_correct_count\)\s*'
    'returning id into v_answer_id;',
    'begin '
    'insert into public.answers (work_id, user_id, correct_count) '
    'values (p_work_id, v_uid, v_correct_count) '
    'returning id into v_answer_id; '
    'exception when unique_violation then '
    'raise exception ''ALREADY_ANSWERED: この作品にはもう回答しています。やり直しはできません。''; '
    'end;'
  );

  if v_new = v_src then
    raise exception
      'submit_answer の保存部分が想定と違います。置き換えていません。手で確かめてください。';
  end if;

  execute v_new;
end
$mig$;


-- ----------------------------------------------------------------------------
-- 4. 検算
-- ----------------------------------------------------------------------------
--
-- 直したつもりで直っていない、を防ぐ。1つでも合わなければ巻き戻す。

do $verify$
declare
  v_n int;
begin

  -- 4-1. いいね・お気に入りが on conflict を持っている
  select count(*)::int into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('toggle_like', 'toggle_save')
     and p.prosrc ilike '%on conflict (work_id, user_id) do nothing%';

  if v_n <> 2 then
    raise exception '検算1 失敗: on conflict を持つ toggle が %本（期待 2）', v_n;
  end if;

  -- 4-2. 回答が unique_violation を日本語へ変換している
  select count(*)::int into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'submit_answer'
     and p.prosrc ilike '%when unique_violation%'
     and p.prosrc like '%ALREADY_ANSWERED%';

  if v_n <> 1 then
    raise exception '検算2 失敗: submit_answer の変換が入っていません';
  end if;

  -- 4-3. search_path を落としていない（security definer の必須条件）
  select count(*)::int into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('toggle_like', 'toggle_save', 'submit_answer')
     and p.prosecdef
     and not exists (
       select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search\_path=%'
     );

  if v_n <> 0 then
    raise exception '検算3 失敗: search_path が外れた関数が %本', v_n;
  end if;

  -- 4-4. 権限が元のまま（PUBLIC へ配っていない）
  select count(*)::int into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
         aclexplode(p.proacl) a
   where n.nspname = 'public'
     and p.proname in ('toggle_like', 'toggle_save', 'submit_answer')
     and a.grantee = 0;

  if v_n <> 0 then
    raise exception '検算4 失敗: PUBLIC に EXECUTE が付いています（%件）', v_n;
  end if;

  raise notice '検算4件すべて通過';
end
$verify$;
