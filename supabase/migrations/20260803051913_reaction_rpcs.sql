-- ============================================================================
-- reaction_rpcs ／ Step 12: いいね・保存
-- ============================================================================
--
-- 【このファイルがやること】
--   1. カウンタを同期するトリガー2本を作る
--   2. toggle_like / toggle_save を作る
--   3. 実行権限を設定する
--
-- 【このファイルがやらないこと】
--   ・**既存21表の列・制約・権限を一切変更しない**
--   ・データを1行も消さない・書き換えない
--   ・取得系RPCに手を入れない
--     （状態は get_work_detail の liked_by_me / saved_by_me、
--       一覧は get_my_likes / get_my_saves をそのまま使う）
--   ・通報を作らない。Step 15
--   ・ランキングを作らない。Step 13
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/014_reaction_rpcs_rollback.sql
--
--
-- 【いちばん大事な決まり：いいね・保存は登録ユーザーだけ（D7）】
--
--   spec 10 の権限表で、いいねと保存は「匿名 ×／登録 ○」。
--   理由は Step 13 の人気ランキングにある。
--   ゲストのままいくらでも押せると、ブラウザを開き直すだけで
--   何度でも押せてしまい、順位が意味を持たなくなる。
--
--   投稿のときと同じく、判定は **偽造できない JWT** だけを見る（spec 9-1）。
--   profiles.is_anonymous（表の値）は使わない。
--
--   ずれていないことは診断 A10 が見張る
--   （いいね／保存の持ち主が匿名ユーザーなら1行返る）。
--
--
-- 【押す対象は公開作品だけ】
--
--   非公開・審査で伏せた・削除済みの作品にはいいねできない。
--   条件は get_work_detail と同じにそろえる。
--
--   満たさない場合は「見つかりません」とだけ返す（D40）。
--   「非公開です」と返すと、その作品が存在することを教えてしまう。
--
--   **自分の作品にはいいねできる。** 自作への回答を禁じている（D28）のは
--   答えを知っていると統計が歪むためで、いいねにその問題は無い。
--
--
-- 【カウンタをトリガーで同期する理由（D24）】
--
--   works.likes_count / saves_count は「数え直せば復元できる控え」で、
--   正本は likes / saves の行そのもの。
--
--   トリガーにすると **行が増えた・減った事実そのものに反応する**ので、
--   将来ほかの経路から行が入っても数がずれない。
--   Step 10 の回答集計（answers → works.answers_count）と同じ作り。
--
--   ずれていないことは診断 A11 が見張る。
--
-- ============================================================================




-- ============================================================================
-- 1. カウンタを同期するトリガー
-- ============================================================================
--
-- 【減らすときに greatest(..., 0) を挟む理由】
--   works の CHECK は likes_count >= 0。何かの理由で控えが実際より
--   小さくなっていると、減算で負になって**行の更新そのものが失敗する**。
--   いいねを取り消しただけで操作が失敗するのは割に合わないので、
--   0 で止める。ずれていること自体は診断 A11 が見つける。
--
-- 【作品が消えるときについて】
--   works が消えると likes は ON DELETE CASCADE で一緒に消え、
--   このトリガーが動く。そのとき更新先の works の行はもう無いので、
--   update は0行に当たって何も起きない（エラーにはならない）。
--   MVP の削除は論理削除なので、そもそもこの経路は通らない。


-- ----------------------------------------------------------------------------
-- 1-a. likes
-- ----------------------------------------------------------------------------

create function public.likes_after_change_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    update public.works w
       set likes_count = w.likes_count + 1
     where w.id = new.work_id;
  elsif tg_op = 'DELETE' then
    update public.works w
       set likes_count = greatest(w.likes_count - 1, 0)
     where w.id = old.work_id;
  end if;

  return null;   -- after トリガーなので戻り値は使われない
end;
$fn$;

comment on function public.likes_after_change_counts() is
  'works.likes_count を likes の行数に合わせる。正本は likes（D24）。';


create trigger likes_after_change_counts
  after insert or delete on public.likes
  for each row
  execute function public.likes_after_change_counts();


-- ----------------------------------------------------------------------------
-- 1-b. saves
-- ----------------------------------------------------------------------------

create function public.saves_after_change_counts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if tg_op = 'INSERT' then
    update public.works w
       set saves_count = w.saves_count + 1
     where w.id = new.work_id;
  elsif tg_op = 'DELETE' then
    update public.works w
       set saves_count = greatest(w.saves_count - 1, 0)
     where w.id = old.work_id;
  end if;

  return null;
end;
$fn$;

comment on function public.saves_after_change_counts() is
  'works.saves_count を saves の行数に合わせる。正本は saves（D24）。';


create trigger saves_after_change_counts
  after insert or delete on public.saves
  for each row
  execute function public.saves_after_change_counts();




-- ============================================================================
-- 2. toggle_like / toggle_save
-- ============================================================================
--
-- 押すたびに「付ける／外す」が入れ替わる。
--
-- 【なぜ add と remove に分けないか】
--   画面のボタンは1つで、いまの状態は画面が持っている。
--   その状態が古いまま add を送ると「もう付いています」という
--   意味のないエラーになる。**いまどうなっているかを DB 側で見て
--   反対にする**ほうが、画面の状態が多少ずれていても破綻しない。
--
-- 【返り値】
--   反映後の状態と件数を返す。画面はこれをそのまま描けばよい。


-- ----------------------------------------------------------------------------
-- 2-a. toggle_like
-- ----------------------------------------------------------------------------

create function public.toggle_like(p_work_id uuid)
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
    insert into public.likes (work_id, user_id) values (p_work_id, v_uid);
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
  'いいねを付ける／外す。登録ユーザーのみ（D7）。公開作品だけが対象。';


-- ----------------------------------------------------------------------------
-- 2-b. toggle_save
-- ----------------------------------------------------------------------------

create function public.toggle_save(p_work_id uuid)
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
      'GUEST_CANNOT_SAVE: 保存にはアカウント登録が必要です。'
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




-- ============================================================================
-- 3. 実行権限
-- ============================================================================
--
-- どちらも authenticated だけ。匿名ゲストも Postgres 側では authenticated
-- なので、ゲストを弾くのは関数の中の検査が担う。
--
-- トリガー関数2本は誰にも与えない。

revoke all on function public.toggle_like(uuid)  from public, anon, authenticated;
revoke all on function public.toggle_save(uuid)  from public, anon, authenticated;
revoke all on function public.likes_after_change_counts()
  from public, anon, authenticated;
revoke all on function public.saves_after_change_counts()
  from public, anon, authenticated;

grant execute on function public.toggle_like(uuid) to authenticated;
grant execute on function public.toggle_save(uuid) to authenticated;
