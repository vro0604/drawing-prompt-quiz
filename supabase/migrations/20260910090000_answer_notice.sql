-- 回答の知らせ（D192）
--
-- 【何のためか】
--   作品に回答が付いても、作者が自分から作品ページへ戻らない限り
--   気付けなかった。投稿 → 誰かが答える → 作者が知る → 結果を見る、
--   までを閉じる。
--
-- 【表を増やさない理由】
--   知らせの表は作らない。「その作品の結果を最後に見た時刻」を
--   works に1列持てば、未確認かどうかは
--   「その時刻より後に来た回答があるか」で数えられる。
--   作品ごとに数えるので、1作品に何件来ても知らせは1つにまとまる。
--   出所: ユーザー指示（2026-09-10）「専用notifications表は初期版では作らない。
--   調査案2を採用する。」
--
-- 【回答の側は1行も変えない】
--   submit_answer には手を入れない。知らせは、回答が入った事実と
--   最後に見た時刻の差から導く。だから「回答は失敗したのに知らせだけ残る」
--   が構造的に起きない。
--   出所: ユーザー指示（2026-09-10）「submit_answer 自体へ
--   通知行をINSERTする処理は追加しない。」
--
-- 【回答者が誰かは返さない】
--   ここで足す関数は、回答者のIDも名前も1つも返さない。
--   作品の側の情報だけを返す。
--   出所: ユーザー指示（2026-09-10）「回答者ID・名前を通知へ出さない。」

begin;

-- ── 1. 最後に結果を見た時刻 ────────────────────────────
--
-- null は「まだ一度も見ていない」。既存の作品はすべて null から始まる。
-- 列名は works の既存の時刻列（created_at / deleted_at / image_deleted_at）
-- と同じ「何が どうされた _at」の形にそろえてある。

alter table public.works
  add column if not exists result_seen_at timestamptz;

comment on column public.works.result_seen_at is
  '作者がこの作品の結果を最後に開いた時刻。null はまだ一度も開いていない。'
  'これより後に来た回答があれば「未確認」（D192）。';

-- 未確認の作品を引くための索引。作者ごとに引くので user_id から。
create index if not exists works_user_result_seen_idx
  on public.works (user_id, result_seen_at)
  where deleted_at is null;

-- ── 2. 未確認があるか（ヘッダーの見た目だけに使う）──────────
--
-- **件数を返さない。**返すのは「ある / ない」だけ。
-- 出所: ユーザー指示（2026-09-10）「絶対に表示しない：回答件数 /
-- 通知件数 / 数字badge / 未読を示す丸badge / いいね型カウンター」。
-- 数を返さなければ、画面の都合で数が出てしまう道がそもそも無い。

create or replace function public.has_unseen_results()
returns boolean
language sql
stable
security definer
set search_path to ''
as $function$
  select exists (
    select 1
      from public.works w
     where w.user_id = (select auth.uid())
       and w.deleted_at is null
       and exists (
         select 1
           from public.answers a
          where a.work_id = w.id
            and (w.result_seen_at is null or a.created_at > w.result_seen_at)
       )
  );
$function$;

comment on function public.has_unseen_results() is
  '自分の作品に未確認の回答があるか。件数は返さない（D192）。';

-- ── 3. 未確認の作品の一覧 ──────────────────────────────
--
-- 回答1件を1行にしない。**作品を1行にする。**
-- 出所: ユーザー指示（2026-09-10）「未確認回答の存在する『作品』を
-- 一覧にする。回答1件を通知1件として並べない。」
--
-- 回答の件数も、回答者も返さない。並び順に使うのは
-- 「その作品にいちばん新しい回答が来た時刻」だけ。

create or replace function public.list_unseen_result_works(
  p_limit integer default 50
)
returns table(
  work_id       uuid,
  title         text,
  image_path    text,
  image_width   integer,
  image_height  integer,
  division      text,
  latest_answer_at timestamptz
)
language sql
stable
security definer
set search_path to ''
as $function$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    (select max(a.created_at)
       from public.answers a
      where a.work_id = w.id
        and (w.result_seen_at is null or a.created_at > w.result_seen_at))
  from public.works w
 where w.user_id = (select auth.uid())
   and w.deleted_at is null
   and exists (
     select 1
       from public.answers a
      where a.work_id = w.id
        and (w.result_seen_at is null or a.created_at > w.result_seen_at)
   )
 order by 7 desc
 limit greatest(1, least(coalesce(p_limit, 50), 100));
$function$;

comment on function public.list_unseen_result_works(integer) is
  '未確認の回答がある自分の作品。作品ごとに1行。回答の件数も回答者も返さない（D192）。';

-- ── 4. 結果を開く（開いた時刻を記録してから返す）────────────
--
-- 【なぜ既存の get_my_work_result と分けるか】
--   既存のほうは読むだけの関数（STABLE）で、作品ページを開くたびに
--   呼ばれている。**閉じた状態で開いても確認済みにしてはいけない。**
--   出所: ユーザー指示（2026-09-10）「単に通知一覧を開いただけでは
--   確認済みにしない。作者本人が対象作品の結果を実際に開いた時点、
--   すなわち既存の result=open の結果表示が成立した時点で
--   『最後に結果を確認した時刻』を更新する。」
--
--   だから「開く」ほうだけを別の関数にして、そちらでだけ時刻を書く。
--   返す中身は既存の関数をそのまま呼ぶので、結果画面は1つのまま。

create or replace function public.open_my_work_result(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    return null;
  end if;

  -- 自分の作品でなければ1行も動かない。他人の作品の時刻は触れない。
  update public.works w
     set result_seen_at = now()
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  -- 中身は既存の関数がそのまま返す。**作者かどうかの判定もそちらが持つ。**
  return public.get_my_work_result(p_work_id);
end;
$function$;

comment on function public.open_my_work_result(uuid) is
  '自分の作品の結果を開く。開いた時刻を記録してから、get_my_work_result と同じものを返す（D192）。';

-- ── 5. 権限 ────────────────────────────────────────
--
-- postgres が作った関数は、既定で anon にも EXECUTE が配られる。
-- `revoke from public` だけでは外れない（2026-09-09 に本番で実測）。
-- 名指しで剥がしてから、authenticated にだけ配り直す。

revoke all on function public.has_unseen_results()
  from public, anon, authenticated;
grant execute on function public.has_unseen_results() to authenticated;

revoke all on function public.list_unseen_result_works(integer)
  from public, anon, authenticated;
grant execute on function public.list_unseen_result_works(integer) to authenticated;

revoke all on function public.open_my_work_result(uuid)
  from public, anon, authenticated;
grant execute on function public.open_my_work_result(uuid) to authenticated;

-- 足した列そのものを直に読み書きされないようにする。
-- 表への列単位の権限は配らない（既存の works と同じ扱い）。

-- ── 6. 当たったことを、その場で数えて確かめる ──────────────

do $check$
declare
  v_col   int;
  v_fn    int;
  v_anon  int;
  v_auth  int;
  v_touch int;
begin
  select count(*) into v_col
    from information_schema.columns
   where table_schema = 'public' and table_name = 'works'
     and column_name = 'result_seen_at';
  if v_col <> 1 then
    raise exception '列が % 個です（1個のはず）', v_col;
  end if;

  select count(*) into v_fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('has_unseen_results', 'list_unseen_result_works',
                       'open_my_work_result');
  if v_fn <> 3 then
    raise exception '関数が % 本です（3本のはず）', v_fn;
  end if;

  select count(*) into v_anon
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('has_unseen_results', 'list_unseen_result_works',
                       'open_my_work_result')
     and has_function_privilege('anon', p.oid, 'EXECUTE');
  if v_anon <> 0 then
    raise exception 'anon が呼べる関数が % 本あります（0本のはず）', v_anon;
  end if;

  select count(*) into v_auth
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public'
     and p.proname in ('has_unseen_results', 'list_unseen_result_works',
                       'open_my_work_result')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_auth <> 3 then
    raise exception 'authenticated が呼べる関数が % 本です（3本のはず）', v_auth;
  end if;

  -- **回答の側を1行も変えていないこと。**
  -- submit_answer に知らせを入れる処理を足していないので、
  -- あの関数の中に result_seen_at が現れることはない。
  select count(*) into v_touch
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prokind = 'f'
     and p.proname in ('submit_answer', 'build_quiz_for_prompt',
                       'get_next_work', 'next_work_candidates',
                       'get_work_detail', 'get_work_quiz', 'get_rankings')
     and pg_get_functiondef(p.oid) like '%result_seen_at%';
  if v_touch <> 0 then
    raise exception '回答・出題・配給・順位の関数 % 本に result_seen_at が入っています', v_touch;
  end if;

  raise notice '回答の知らせを足しました（列1つ・関数3本）。';
end
$check$;

commit;
