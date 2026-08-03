-- ============================================================================
-- works_write_rpcs ／ Step 7: 作品投稿（書き込みRPC 2本 ＋ Storage）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. Storage バケット works を作る（公開読み取り・5MB・画像3種のみ）
--   2. storage.objects に works バケット用のポリシーを4本張る
--   3. create_work を作る（D27 の6検査 → 作品作成 → 未選択カードを開示）
--   4. update_work を作る（変更してよい列だけを更新する）
--   5. 実行権限を設定する
--
--   これで「お題確定 → 画像を選ぶ → アップロード → 作品情報を入れる →
--   create_work → 作品詳細」までブラウザで通る。
--
-- 【このファイルがやらないこと】
--   ・**既存21表の列・制約・権限を一切変更しない**
--   ・データを1行も消さない・書き換えない
--   ・取得系RPC 13本に手を入れない（作品の取得は既存の
--     get_work_detail / get_my_work / get_public_works / get_my_works を使う）
--   ・delete_work（論理削除＋画像削除）を作らない。Step 15
--   ・回答・いいね・保存の処理を作らない。Step 9 以降
--   ・フィード画面用のRPCを足さない。Step 8
--
-- 【実行方法】
--   npm run db:deploy （dry-run のあと push される）
--   CLI がファイル全体を1トランザクションで実行するため、
--   途中で失敗すれば何も残らない。
--
-- 【前提】
--   harden_function_privileges まで適用済みであること。
--   そのマイグレーションで
--     alter default privileges in schema public revoke execute on functions from public;
--   を入れてあるため、**このファイルで作る2本には PUBLIC の EXECUTE が
--   自動で付かない**。それでも第5節で明示的に revoke してから grant する
--   （既存3ファイルと同じ書き方に揃え、設定が外れても穴が開かないようにする）。
--
-- 【取り消し】
--   supabase/rollback/009_works_write_rpcs_rollback.sql を SQL Editor で実行する。
--
--
-- 【いちばん大事な安全設計：投稿は登録ユーザーだけ】
--
--   spec C3 / D27 検査1。匿名ゲストは投稿できない。
--   判定に profiles.is_anonymous は**使わない**。あの列は表の値なので、
--   将来どこかの経路で書き換えられる余地がある。
--   偽造できない JWT の中身だけを見る（spec 9-1 の共通式）。
--
--     coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
--
--   同じ判定を Storage 側のポリシーにも書く。RPC だけを守っても、
--   バケットへ直接アップロードできてしまえば意味がないため。
--
--
-- 【2番目に大事：image_path を自己申告させない】
--
--   image_path は「Storage のどこにあるか」を指す文字列で、クライアントから
--   渡される。ここを検査しないと、他人の画像のパスを書いた作品を作れてしまう。
--
--   そこで **正規表現で完全一致**を要求する（D27 検査6を強めた形）。
--
--     {自分のuser_id}/{これから作る作品のid}.{jpg|jpeg|png|webp}
--
--   spec 8-6 のパス規約そのものなので、規約を破ると作品が作れない。
--   前方一致だけにすると「自分の領域の別ファイル」を指せてしまい、
--   1つの画像を複数作品で使い回す・他人の作品の画像を差し替えるといった
--   ずれが生まれる。完全一致ならその余地が無い。
--
--   このため create_work は **作品のIDを引数で受け取る**。
--   アップロード先のパスを決めるにはIDが先に要るが、
--   IDを決めるには行を作らねばならない、という順番の問題を解くため。
--
--     アプリ側: id = crypto.randomUUID()
--            → {uid}/{id}.png へアップロード
--            → create_work(p_work_id => id, ...)
--            → 失敗したらアップロードした画像を消す（R10）
--
--   IDを外から渡せることによる危険は無い。uuid が衝突すれば主キー違反で
--   失敗するだけで、他人の行には触れない。
--
--
-- 【未選択カードの開示（D8 / §9-4）】
--
--   作品ができた時点で prompts を次のように進める。
--
--     status                 = 'submitted'
--     submitted_at           = 今
--     candidates_revealed_at = 今
--     reveal_reason          = 'work_submitted'
--
--   **下書き（is_published = false）でも開示する。**
--   開示してよいかどうかの基準は「そのお題で描き終えたか」であって、
--   公開したかどうかではない。描き終えた本人が自分の引かなかった
--   カードを見るだけで、クイズの答え（prompt_cards）は漏れない。
--
--
-- 【DB の制約では防げず、この RPC が保証すること】
--
--   ・投稿者が匿名ゲストでないこと（JWT を見る必要がある）
--   ・お題の作成者本人であること（別の表を見る必要がある）
--   ・お題がまだ使われていないこと（works.prompt_id の UNIQUE と二重に見る。
--     索引違反のメッセージは利用者に意味が通じないため、先に自分で見る）
--   ・image_path が自分の領域の、この作品のためのファイルであること
--   ・actual_time_seconds を公開後に変えないこと（D25）
--
-- ============================================================================




-- ============================================================================
-- 1. Storage バケット works
-- ============================================================================
--
-- spec 8-6 のとおり。
--
--   公開読み取り  … 作品画像は誰でも見られる必要がある
--   5MB 上限      … R17（無料枠 1GB）
--   画像3種のみ   … それ以外を置かせない
--
-- on conflict を付けているのは、バケットが既にある環境でも
-- このマイグレーションが通るようにするため。
-- 【注意】この文はバケットの**設定**だけを書き換える。
--   中のファイルには一切触れない（storage.objects を更新しない）。

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'works',
  'works',
  true,
  5242880,                                          -- 5 MiB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;


-- ----------------------------------------------------------------------------
-- 2. storage.objects のポリシー
-- ----------------------------------------------------------------------------
--
-- storage.objects は Supabase が用意する表で、RLS は最初から有効。
-- ポリシーが無ければ何もできない。バケットごとに bucket_id で絞って書く。
--
-- 【読み取りについて】
--   バケットを public = true にしてあるので、
--   https://<project>.supabase.co/storage/v1/object/public/works/... は
--   ポリシーと無関係に配信される。下の select ポリシーが効くのは
--   「一覧を取る」「認証つきで取る」経路。両方の入口で同じ結論になるよう
--   明示的に張っておく。
--
-- 【パスの先頭が本人であること】
--   storage.foldername(name) はパスをスラッシュで分けた配列を返す。
--   その1つめが自分の user_id であることを求める。
--   spec 8-6 の {user_id}/{work_id}.{ext} という規約そのもの。
--
-- 【(select auth.uid()) と書く理由】
--   括弧つきの副問い合わせにすると1行ごとではなく1回だけ評価される。
--   既存の RLS ポリシー（001〜006）と同じ書き方に揃えている。
--
-- drop policy if exists を先に置くのは、何度実行しても同じ結果になるようにするため。

drop policy if exists works_objects_read_public on storage.objects;
drop policy if exists works_objects_insert_own  on storage.objects;
drop policy if exists works_objects_update_own  on storage.objects;
drop policy if exists works_objects_delete_own  on storage.objects;


-- --- 2-a. 読み取り：誰でも -----------------------------------------------------

create policy works_objects_read_public
  on storage.objects
  for select
  to anon, authenticated
  using (bucket_id = 'works');


-- --- 2-b. 追加：登録ユーザーが、自分の領域にだけ -------------------------------
--
-- **匿名ゲストは弾く。** RPC 側の検査1と同じ条件をここにも書く。
-- 片方だけだと、バケットへ直接アップロードする経路が空いてしまう。

create policy works_objects_insert_own
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  );


-- --- 2-c. 差し替え：自分の領域だけ ---------------------------------------------
--
-- 画像の差し替えそのものは MVP の画面から行わないが、
-- upsert 相当の操作や再アップロードで使われる。
-- using（今の行）と with check（更新後の行）の両方に同じ条件を書く。
-- 片方だけだと、自分の領域から他人の領域へ移せてしまう。

create policy works_objects_update_own
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) = false
  )
  with check (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );


-- --- 2-d. 削除：自分の領域だけ -------------------------------------------------
--
-- 作品作成に失敗したときの後始末（R10）で使う。
-- アップロードは成功したが create_work が失敗した、という中途半端な状態を
-- 残さないため、アプリ側がここを呼んで消す。

create policy works_objects_delete_own
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'works'
    and (storage.foldername(name))[1] = (select auth.uid())::text
  );




-- ============================================================================
-- 3. create_work ／ 作品を作る
-- ============================================================================
--
-- 引数の順番は「必須 → 任意」。任意には既定値を付けてあるので、
-- オリジナル部門の投稿はファンアート3項目を渡さずに呼べる。
--
-- 返り値に **prompt_id を含めない**（D23）。含めると作品からお題へ
-- 辿る足がかりになる。返すのは作品IDと公開状態だけ。

create function public.create_work(
  p_work_id             uuid,
  p_prompt_id           uuid,
  p_title               text,
  p_image_path          text,
  p_image_width         int,
  p_image_height        int,
  p_division            text,
  p_source_title        text    default null,
  p_source_character    text    default null,
  p_fanart_note         text    default null,
  p_actual_time_seconds int     default null,
  p_is_published        boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid              uuid := (select auth.uid());
  v_is_anonymous     boolean;
  v_prompt           record;
  v_title            text;
  v_source_title     text;
  v_source_character text;
  v_fanart_note      text;
  v_now              timestamptz := clock_timestamp();
begin

  -- --- 検査1: 登録済みユーザーであること（D27-1）----------------------------
  --
  -- 未サインインと匿名ゲストを分けて知らせる。画面側で
  -- 「サインインしてください」と「登録してください」を出し分けるため。

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  v_is_anonymous := coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false);

  if v_is_anonymous then
    raise exception
      'GUEST_CANNOT_POST: 作品の投稿にはアカウント登録が必要です。'
      'ゲストのままお題は引けますが、投稿はできません。';
  end if;


  -- --- 検査2: そのお題の作成者本人であること（D27-2）------------------------
  --
  -- 他人のお題IDでも「権限がありません」とは言わない。
  -- 存在しないIDと同じ扱いにする（D40。IDの実在を教えないため）。

  select p.id, p.status, p.created_at
    into v_prompt
    from public.prompts p
   where p.id = p_prompt_id
     and p.created_by = v_uid;

  if not found then
    raise exception 'PROMPT_NOT_FOUND: そのお題は見つかりません。';
  end if;


  -- --- 検査3: お題がまだ使われていない状態であること（D27-3）----------------

  if v_prompt.status <> 'active' then
    raise exception
      'PROMPT_NOT_ACTIVE: そのお題はもう使えません（状態: %）。', v_prompt.status;
  end if;


  -- --- 検査4: そのお題にまだ作品が無いこと（D27-4）--------------------------
  --
  -- works.prompt_id の UNIQUE でも守られているが、
  -- 索引違反のメッセージは利用者に意味が通じないので先に自分で見る。

  if exists (select 1 from public.works w where w.prompt_id = p_prompt_id) then
    raise exception 'WORK_ALREADY_EXISTS: そのお題ではもう作品を投稿しています。';
  end if;


  -- --- 検査5: 部門とファンアート項目の整合（D27-5）--------------------------
  --
  -- 空文字は null に寄せてから見る。
  -- フォームの未入力は空文字で届くため、そのまま入れると
  -- 「ファンアート以外は3項目とも null」という CHECK に引っかかる。

  if p_division not in ('original', 'fanart', 'ai') then
    raise exception 'BAD_DIVISION: 部門 % は使えません。', p_division;
  end if;

  v_source_title     := nullif(btrim(coalesce(p_source_title, '')), '');
  v_source_character := nullif(btrim(coalesce(p_source_character, '')), '');
  v_fanart_note      := nullif(btrim(coalesce(p_fanart_note, '')), '');

  if p_division = 'fanart' and v_source_title is null then
    raise exception
      'FANART_NEEDS_SOURCE_TITLE: ファンアート部門では元作品名が必須です。';
  end if;

  if p_division <> 'fanart'
     and (v_source_title is not null
       or v_source_character is not null
       or v_fanart_note is not null) then
    raise exception
      'NON_FANART_HAS_SOURCE: ファンアート以外の部門に元作品の情報は入れられません。';
  end if;


  -- --- 検査6: image_path が自分の領域のこの作品のファイルであること（D27-6）--
  --
  -- spec 8-6 のパス規約 {user_id}/{work_id}.{ext} への完全一致を求める。
  -- 前方一致にしないのは、自分の領域の別ファイル（＝他の作品の画像）を
  -- 指せてしまうため。

  if p_image_path is null
     or p_image_path !~ ('^' || v_uid::text || '/' || p_work_id::text
                             || '\.(jpg|jpeg|png|webp)$') then
    raise exception
      'BAD_IMAGE_PATH: 画像の置き場所が規約と違います（{自分のID}/{作品ID}.拡張子）。';
  end if;


  -- --- 入力の整え ------------------------------------------------------------
  --
  -- 長さの上限は works の CHECK 制約が持っている。
  -- ここで見るのは、制約違反のメッセージが利用者に通じない項目だけ。

  v_title := nullif(btrim(coalesce(p_title, '')), '');

  if v_title is null then
    raise exception 'TITLE_REQUIRED: タイトルを入力してください。';
  end if;

  if char_length(v_title) > 60 then
    raise exception 'TITLE_TOO_LONG: タイトルは60字までです（いま %字）。',
      char_length(v_title);
  end if;

  if p_actual_time_seconds is not null
     and (p_actual_time_seconds < 1 or p_actual_time_seconds > 600000) then
    raise exception
      'BAD_ACTUAL_TIME: 実制作時間は1〜600000秒の範囲で指定してください。';
  end if;

  if p_image_width is null or p_image_height is null
     or p_image_width  not between 1 and 20000
     or p_image_height not between 1 and 20000 then
    raise exception 'BAD_IMAGE_SIZE: 画像の大きさを読み取れませんでした。';
  end if;


  -- --- 作品を作る ------------------------------------------------------------

  insert into public.works (
    id, prompt_id, user_id,
    title, image_path, image_width, image_height,
    division, source_title, source_character, fanart_note,
    actual_time_seconds, is_published
  )
  values (
    p_work_id, p_prompt_id, v_uid,
    v_title, p_image_path, p_image_width, p_image_height,
    p_division, v_source_title, v_source_character, v_fanart_note,
    p_actual_time_seconds, coalesce(p_is_published, true)
  );


  -- --- お題を「投稿済み」にし、未選択カードを開示する（D8 / §9-4）----------
  --
  -- 下書きでも開示する。基準は「描き終えたか」であって公開の有無ではない。
  --
  -- coalesce で包むのは、既に開示済みの場合に日時を上書きしないため
  -- （開示は不可逆。最初に開示した時刻を正としたい）。
  -- greatest(...) は prompts_revealed_after_created 制約への保険。

  update public.prompts p
     set status                 = 'submitted',
         submitted_at           = coalesce(p.submitted_at, greatest(v_now, p.created_at)),
         candidates_revealed_at = coalesce(p.candidates_revealed_at,
                                           greatest(v_now, p.created_at)),
         reveal_reason          = coalesce(p.reveal_reason, 'work_submitted')
   where p.id = p_prompt_id;


  return jsonb_build_object(
    'work_id',      p_work_id,
    'is_published', coalesce(p_is_published, true)
  );
end;
$fn$;

comment on function public.create_work(uuid, uuid, text, text, int, int, text,
                                       text, text, text, int, boolean) is
  '作品を作る。D27 の6検査を通してから works へ1行入れ、未選択カードを開示する。'
  '返り値に prompt_id は含めない（D23）。';




-- ============================================================================
-- 4. update_work ／ 変更してよい列だけを更新する
-- ============================================================================
--
-- spec 8-4「変更可否」の表そのもの。
--
--   本人が変更できる  title / source_title / source_character / fanart_note /
--                     is_published / actual_time_seconds（未公開の間のみ。D25）
--   誰も変更できない  id / prompt_id / user_id / image_path / image_width /
--                     image_height / division / 各カウンタ / review_status /
--                     deleted_at / created_at
--
-- **null は「変更しない」という意味にする。**
--   そのため「入っている値を空へ戻す」操作はこの関数ではできない。
--   MVP の画面に消す操作が無いので割り切る。必要になったら
--   「空文字を渡したら null にする」ではなく専用の引数を足して区別する
--   （空文字と未指定を同じ記号に載せると、あとで必ず取り違える）。
--
-- 下書き（is_published = false）から公開へ進めるのもこの関数。

create function public.update_work(
  p_work_id             uuid,
  p_title               text    default null,
  p_source_title        text    default null,
  p_source_character    text    default null,
  p_fanart_note         text    default null,
  p_actual_time_seconds int     default null,
  p_is_published        boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_work  record;
  v_title text;
begin

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'GUEST_CANNOT_POST: この操作にはアカウント登録が必要です。';
  end if;

  -- 他人の作品IDには「見つかりません」を返す（D40）。
  select w.id, w.division, w.is_published, w.deleted_at
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  if v_work.deleted_at is not null then
    raise exception 'WORK_DELETED: 削除済みの作品は変更できません。';
  end if;


  -- --- タイトル --------------------------------------------------------------

  if p_title is not null then
    v_title := nullif(btrim(p_title), '');
    if v_title is null then
      raise exception 'TITLE_REQUIRED: タイトルは空にできません。';
    end if;
    if char_length(v_title) > 60 then
      raise exception 'TITLE_TOO_LONG: タイトルは60字までです（いま %字）。',
        char_length(v_title);
    end if;
  end if;


  -- --- ファンアート3項目 ------------------------------------------------------
  --
  -- 部門は投稿後に変えられない。だから「いまの部門」だけを見れば足りる。
  -- ファンアート以外に入れさせないのは works の CHECK 制約と同じ意図で、
  -- 制約違反にする前に意味の通じるメッセージで止める。

  if v_work.division <> 'fanart'
     and (p_source_title is not null
       or p_source_character is not null
       or p_fanart_note is not null) then
    raise exception
      'NON_FANART_HAS_SOURCE: ファンアート以外の部門に元作品の情報は入れられません。';
  end if;

  if p_source_title is not null and nullif(btrim(p_source_title), '') is null then
    raise exception 'FANART_NEEDS_SOURCE_TITLE: 元作品名は空にできません。';
  end if;


  -- --- 実制作時間（D25）------------------------------------------------------
  --
  -- 公開したら変更できない。判定に使うのは**更新前**の is_published。
  -- 「未公開のまま時間を直しつつ公開する」は1回の呼び出しで通してよい。

  if p_actual_time_seconds is not null then
    if v_work.is_published then
      raise exception
        'ACTUAL_TIME_LOCKED: 公開済みの作品は実制作時間を変更できません（D25）。';
    end if;
    if p_actual_time_seconds < 1 or p_actual_time_seconds > 600000 then
      raise exception
        'BAD_ACTUAL_TIME: 実制作時間は1〜600000秒の範囲で指定してください。';
    end if;
  end if;


  update public.works w
     set title               = coalesce(v_title, w.title),
         source_title        = coalesce(nullif(btrim(p_source_title), ''), w.source_title),
         source_character    = coalesce(nullif(btrim(p_source_character), ''),
                                        w.source_character),
         fanart_note         = coalesce(nullif(btrim(p_fanart_note), ''), w.fanart_note),
         actual_time_seconds = coalesce(p_actual_time_seconds, w.actual_time_seconds),
         is_published        = coalesce(p_is_published, w.is_published)
   where w.id = p_work_id
     and w.user_id = v_uid;

  return jsonb_build_object(
    'work_id',      p_work_id,
    'is_published', coalesce(p_is_published, v_work.is_published)
  );
end;
$fn$;

comment on function public.update_work(uuid, text, text, text, text, int, boolean) is
  '作品のうち本人が変更してよい列だけを更新する。null は「変更しない」。'
  'actual_time_seconds は未公開の間だけ変更できる（D25）。';




-- ============================================================================
-- 5. 実行権限
-- ============================================================================
--
-- どちらも authenticated だけ。anon（未サインイン）には与えない。
--
-- 【なぜ「登録ユーザーだけに grant」ができないか】
--   Postgres 側のロールは anon / authenticated / service_role の3つで、
--   匿名ゲストも登録ユーザーもどちらも authenticated になる。
--   両者の区別は JWT の中にしか無いため、権限ではなく
--   関数の中の検査1で分ける。

revoke all on function public.create_work(uuid, uuid, text, text, int, int, text,
                                          text, text, text, int, boolean)
  from public, anon, authenticated;
revoke all on function public.update_work(uuid, text, text, text, text, int, boolean)
  from public, anon, authenticated;

grant execute on function public.create_work(uuid, uuid, text, text, int, int, text,
                                             text, text, text, int, boolean)
  to authenticated;
grant execute on function public.update_work(uuid, text, text, text, text, int, boolean)
  to authenticated;
