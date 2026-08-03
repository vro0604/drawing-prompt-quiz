-- ============================================================================
-- step15 ／ 旧IDの保護（P5）・通報・作品の削除
-- ============================================================================
--
-- 【このファイルがやること】
--   1. handle_history 表を作る（手放した ID の控え。12個目の遮断表）
--   2. profiles.handle_updated_at 列を足す（30日の間隔を測るため）
--   3. works.image_deleted_at 列を足す（画像を消せたかの印）
--   4. update_my_profile を差し替える（旧IDの控えと30日制限を追加）
--   5. get_handle_redirect     … 旧ID → いまの ID
--   6. create_report           … 通報＋レート制限
--   7. delete_work             … 論理削除（行は消さない）
--   8. mark_work_image_deleted … 画像を消せたことの記録
--
-- 【このファイルがやらないこと】
--   ・**既存のデータを1行も変更・削除しない**
--   ・既存ユーザーの handle に触れない（新しい列は null で始まる）
--   ・既存の関数のうち update_my_profile 以外に触れない
--   ・退会・アカウント削除を作らない（公開前必須課題 P1）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/017_step15_rollback.sql
--   （関数だけを消す。**表と列は残す**。理由はそのファイルに書いた）
--
--
-- ============================================================================
-- P5: 手放した ID を他人に渡さない
-- ============================================================================
--
--   これまで handle は何度でも変えられ、変えた瞬間に古い ID が空いた。
--   公開ページ（/u/{handle}）ができた以上、これは実害になる。
--
--     A さんが外部に /u/taro を貼る
--     A さんが ID を変える
--     B さんが taro を取る
--     **A さんのリンクを踏んだ人が B さんのページに着く**
--
--   予約語（D59）では防げない種類のなりすまし。3つで対処する。
--
--   1. 手放した ID を handle_history に控え、**他人には渡さない**
--   2. /u/{旧ID} は、いまの ID のページへ移す
--   3. ID の変更は30日に1回まで
--
--   【なぜ「原則として再利用しない」なのか】
--     期間を決めて解放する案もあるが、解放した瞬間に上の問題が戻る。
--     外部に貼られたリンクがいつ踏まれるかは分からないので、
--     「30日経ったから安全」とは言えない。**持ち主本人だけは取り戻せる**
--     形にして、それ以外へは渡さない。
--
--   【予約語とは別に持つ理由】
--     予約語は「方針」で、変えるときはマイグレーションとして記録に残したい。
--     旧IDは「利用者の行動の記録」で、日々増える。性質が違うので、
--     関数の中の配列と表に分けて持つ。
--
--   【30日をどこで測るか】
--     profiles.handle_updated_at。**初回の設定では埋めない。**
--     登録直後に打ち間違えた ID を、30日間直せないのは厳しすぎる。
--     測るのは「変更」からで、「初めて決めた」ときからではない。
--
--
-- ============================================================================
-- 作品の削除を「隠してから消す」順序にする
-- ============================================================================
--
--   delete_work がやるのは、次の1回の UPDATE だけ。
--
--     is_published = false, deleted_at = now()
--
--   画像ファイルを消すのは**そのあと**、アプリ側から行う。順序が逆だと、
--   画像が消えたのに作品が公開されたままの時間が生まれる。
--
--   **画像の削除に失敗しても、作品が公開へ戻ることはない。**
--   update_work は deleted_at が入っている作品を最初に断るため
--   （20260803025753 の検査）、消し残しは「容量の問題」に留まる。
--
--   消し残しは works.image_deleted_at が null のまま残るので、
--   Step 16 の掃除がそれを拾って再試行できる。
--
--   【行を消さない理由】
--     回答・いいね・お気に入り・通報が works を参照している。
--     行ごと消すと、それらが道連れになる（answers / likes / saves /
--     reports はすべて ON DELETE CASCADE）。
--     **通報された作品を消すと通報も消える**のでは、運営の判断材料が残らない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. handle_history ／ 手放した ID の控え
-- ----------------------------------------------------------------------------
--
-- 【権限もポリシーも与えない】（D20 / D35 と同じ）
--   「誰が昔どの ID を使っていたか」は、本人が明かすまで見せる必要が無い。
--   読むのは update_my_profile と get_handle_redirect の2本だけで、
--   どちらも security definer なので表の権限に依存しない。

create table if not exists public.handle_history (
  -- 手放された ID そのもの。小文字で入る（update_my_profile が揃える）。
  -- 主キーにしているので、同じ ID が二重に控えられることはない
  handle text primary key
    constraint handle_history_format check (
      handle ~ '^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$'
    ),

  -- 手放した人。退会したら控えも消える（そのとき ID は誰でも取れてよい）
  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  released_at timestamptz not null default now()
);

comment on table public.handle_history is
  '手放された ID の控え。他人による再取得を防ぐ（P5 / D62）。'
  '権限もポリシーも与えない。読むのは RPC 2本だけ。';

-- 「この人が手放した ID」を引く索引。取り戻せるかの判定に使う
create index if not exists handle_history_user_idx
  on public.handle_history (user_id);

alter table public.handle_history enable row level security;

-- ポリシーは作らない。RLS が有効でポリシーが無い表は、
-- security definer 以外からは1行も見えない。


-- ----------------------------------------------------------------------------
-- 2. profiles.handle_updated_at ／ ID を最後に変えた日時
-- ----------------------------------------------------------------------------
--
-- **既存の行は null のまま**。つまり「まだ一度も変えていない」扱いになり、
-- 次の1回は制限なく変えられる。既存ユーザーの handle には触れない。
--
-- 列権限は与えない（001 が配った6列に足さない）。書けるのは
-- update_my_profile だけで、利用者が直接いじれると制限の意味が無くなる。

alter table public.profiles
  add column if not exists handle_updated_at timestamptz;

comment on column public.profiles.handle_updated_at is
  'ID を最後に「変更」した日時。初回の設定では埋めない。30日制限の基準（P5）。';


-- ----------------------------------------------------------------------------
-- 3. works.image_deleted_at ／ 画像を消せたことの印
-- ----------------------------------------------------------------------------
--
-- 削除した作品の画像が Storage から消えたかどうか。
-- null のまま残っていれば消し残しで、Step 16 の掃除が拾って再試行する。
--
-- 「消したい対象」は deleted_at で分かるので、この列だけを見ればよい。

alter table public.works
  add column if not exists image_deleted_at timestamptz;

comment on column public.works.image_deleted_at is
  '削除済み作品の画像を Storage から消せた日時。'
  'null のまま残っていれば消し残し（Step 16 の掃除が再試行する）。';


-- ----------------------------------------------------------------------------
-- 4. update_my_profile ／ 旧IDの控えと30日制限を足す
-- ----------------------------------------------------------------------------
--
-- 引数と返り値は Step 14 のまま。足したのは handle を**変更する**ときの
-- 2つの検査（他人の旧ID・30日）と、控えの書き込みだけ。

create or replace function public.update_my_profile(
  p_handle       text  default null,
  p_display_name text  default null,
  p_bio          text  default null,
  p_links        jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid          uuid := (select auth.uid());
  v_handle       text;
  v_display_name text;
  v_bio          text;
  v_bad_link     text;
  v_current      text;
  v_changed_at   timestamptz;
  v_owner        uuid;
  v_next_ok      timestamptz;

  -- 配らない ID。3つの理由でまとめてある（D59）。
  --   なりすまし … 運営・公式を名乗れてしまう語
  --   ページ名   … 将来 URL を短くしたときに衝突する語
  --   予備       … 空文字や null の見た目になる語
  v_reserved constant text[] := array[
    'admin','administrator','root','system','sysadmin','superuser',
    'official','staff','support','moderator','mod','team','owner',
    'help','contact','info','news','blog','press','legal','terms','privacy',
    'api','auth','oauth','callback','login','logout','signin','signup',
    'settings','account','accounts','me','my','mypage','user','users','u',
    'new','edit','delete','remove','search','explore','feed','feeds',
    'works','work','play','draft','prompt','prompts','ranking','rankings',
    'saves','save','likes','like','answers','answer','health','dashboard',
    'static','assets','public','images','image','img','css','js','fonts',
    'favicon','robots','sitemap','manifest','well-known',
    'null','undefined','none','anonymous','guest','test','demo','example',
    'dev','develop','staging','production'
  ];

  -- ID を変えられる間隔
  v_cooldown constant interval := interval '30 days';
begin

  -- --- 1. 誰が変更しようとしているか -----------------------------------------

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_SET_PROFILE: プロフィールの設定にはアカウント登録が必要です。';
  end if;

  select p.handle, p.handle_updated_at
    into v_current, v_changed_at
    from public.profiles p
   where p.id = v_uid;


  -- --- 2. ID（handle）-------------------------------------------------------
  --
  -- 大文字で入力されることが多いので、小文字にそろえてから見る。
  -- 「Taro と taro が別人になる」状態を作らないため。

  if p_handle is not null then
    v_handle := lower(btrim(p_handle));

    if v_handle = '' then
      raise exception 'HANDLE_REQUIRED: ID を入力してください。';
    end if;

    if v_handle !~ '^[a-z0-9][a-z0-9-]{1,18}[a-z0-9]$' then
      raise exception
        'HANDLE_FORMAT: ID は3〜20字の小文字の英数字とハイフンで、'
        '先頭と末尾にハイフンは使えません（例: my-handle）。';
    end if;

    -- --- 2-b. 予約語（D59）---------------------------------------------------
    --
    -- すでに自分が持っている ID なら通す（この検査より前に取られた語を、
    -- あとから取り上げないため）。

    if v_handle = any(v_reserved) and v_handle is distinct from v_current then
      raise exception
        'HANDLE_RESERVED: その ID は使えません。運営の名前と間違えやすい語や、'
        'ページの名前と同じ語は登録できません。';
    end if;

    -- --- 2-c. 他人が手放した ID か（P5 / D62）--------------------------------
    --
    -- **他人の旧IDは渡さない。** 外部に貼られたリンクが別人に届くのを防ぐ。
    -- 自分が手放した ID なら取り戻せる。

    if v_handle is distinct from v_current then
      select h.user_id into v_owner
        from public.handle_history h
       where h.handle = v_handle;

      if v_owner is not null and v_owner <> v_uid then
        raise exception
          'HANDLE_RETIRED: その ID は以前ほかの方が使っていたため登録できません。'
          '別の ID にしてください。';
      end if;
    end if;

    -- --- 2-d. 変更の間隔（P5）-----------------------------------------------
    --
    -- 測るのは「変更」から。**初めて決めたとき**は数えない
    -- （登録直後の打ち間違いを30日直せないのは厳しすぎる）。

    if v_current is not null
       and v_handle is distinct from v_current
       and v_changed_at is not null
    then
      v_next_ok := v_changed_at + v_cooldown;

      if now() < v_next_ok then
        raise exception
          'HANDLE_TOO_SOON: ID の変更は30日に1回までです。次に変更できるのは % です。',
          to_char(v_next_ok at time zone 'Asia/Tokyo', 'YYYY年MM月DD日');
      end if;
    end if;
  end if;


  -- --- 3. 表示名 -------------------------------------------------------------

  if p_display_name is not null then
    v_display_name := btrim(p_display_name);

    if v_display_name = '' then
      raise exception 'DISPLAY_NAME_REQUIRED: 表示名は空にできません。';
    end if;

    if char_length(v_display_name) > 30 then
      raise exception 'DISPLAY_NAME_TOO_LONG: 表示名は30字までです（いま %字）。',
        char_length(v_display_name);
    end if;
  end if;


  -- --- 4. 自己紹介 -----------------------------------------------------------

  if p_bio is not null then
    v_bio := nullif(btrim(p_bio), '');

    if v_bio is not null and char_length(v_bio) > 500 then
      raise exception 'BIO_TOO_LONG: 自己紹介は500字までです（いま %字）。',
        char_length(v_bio);
    end if;
  end if;


  -- --- 5. 外部リンク ---------------------------------------------------------

  if p_links is not null then
    if jsonb_typeof(p_links) <> 'object' then
      raise exception 'LINKS_FORMAT: リンクの形式が正しくありません。';
    end if;

    select e.key
      into v_bad_link
      from jsonb_each_text(p_links) e
     where e.value !~ '^https?://'
     limit 1;

    if v_bad_link is not null then
      raise exception
        'LINK_NOT_HTTP: リンク「%」は http:// または https:// で始まる必要があります。',
        v_bad_link;
    end if;

    if octet_length(p_links::text) > 4096 then
      raise exception 'LINKS_TOO_LARGE: リンクの内容が大きすぎます。';
    end if;
  end if;


  -- --- 6. 反映する -----------------------------------------------------------

  begin
    update public.profiles p
       set handle       = coalesce(v_handle, p.handle),
           display_name = coalesce(v_display_name, p.display_name),
           bio          = case when p_bio is null then p.bio else v_bio end,
           links        = coalesce(p_links, p.links),
           -- 「変更」したときだけ日時を進める。初回の設定では触らない
           handle_updated_at = case
             when v_handle is not null
                  and v_current is not null
                  and v_handle is distinct from v_current
             then now()
             else p.handle_updated_at
           end
     where p.id = v_uid;
  exception
    when unique_violation then
      raise exception 'HANDLE_TAKEN: その ID はすでに使われています。別の ID にしてください。';
  end;


  -- --- 7. 手放した ID を控える（P5）------------------------------------------
  --
  -- 更新のあとに行う。更新が失敗したら控えも残らない（同じトランザクション）。
  --
  -- 取り戻した ID の控えは消す。控えたまま現役にすると、
  -- 「いまの ID なのに旧IDでもある」という二重の状態になる。

  if v_handle is not null
     and v_current is not null
     and v_handle is distinct from v_current
  then
    insert into public.handle_history (handle, user_id)
    values (v_current, v_uid)
    on conflict (handle) do update
       set user_id     = excluded.user_id,
           released_at = now();

    delete from public.handle_history h
     where h.handle = v_handle;
  end if;

  return (
    select jsonb_build_object(
      'id',           p.id,
      'handle',       p.handle,
      'display_name', p.display_name,
      'bio',          p.bio,
      'links',        p.links
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$fn$;

comment on function public.update_my_profile(text, text, text, jsonb) is
  '自分のプロフィールを更新する。null は「変更しない」。'
  'handle を設定できる唯一の経路（001 の設計）。予約語は配らない（D59）。'
  '手放した ID は控えて他人へ渡さず、変更は30日に1回まで（P5 / D62）。';

revoke all on function public.update_my_profile(text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.update_my_profile(text, text, text, jsonb)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 5. get_handle_redirect ／ 旧ID → いまの ID
-- ----------------------------------------------------------------------------
--
-- 旧IDでなければ null。**存在しない ID と、公開されていない人を区別しない**
-- （D40）。「その ID は存在するが見せない」という反応を返すと、
-- ID の総当たりで誰が登録しているかを調べられる。
--
-- 移す先は「いま公開されているプロフィール」だけ。控えは残っているが
-- 持ち主のプロフィールが公開条件を満たさない場合は null にする。

create function public.get_handle_redirect(p_handle text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.handle
    from public.handle_history h
    join public.profiles p on p.id = h.user_id
   where h.handle = lower(btrim(p_handle))
     and p.is_anonymous = false
     and p.handle is not null;
$$;

comment on function public.get_handle_redirect(text) is
  '旧ID を渡すと、いまの ID を返す。旧ID でなければ null（不在と非公開を区別しない）。';

revoke all on function public.get_handle_redirect(text)
  from public, anon, authenticated;

grant execute on function public.get_handle_redirect(text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. create_report ／ 通報
-- ----------------------------------------------------------------------------
--
-- 【誰が通報できるか】
--   未サインイン … できない（この関数に anon の実行権限を与えない）
--   ゲスト       … **できる**（spec 8-4 の「匿名も可」）
--   登録ユーザー … できる
--
--   いいね・投稿と違ってゲストにも許すのは、通報が「権利の主張」ではなく
--   「見つけた人が知らせる」行為だから。登録を求めると、いちばん多くの
--   作品を見ている層（ゲストの閲覧者）からの報告が届かなくなる。
--
-- 【存在を漏らさない】
--   非公開・審査中・削除済み・存在しない、のどれであっても
--   **同じ文言**で断る。文言を分けると、作品IDの総当たりで
--   下書きの存在を調べられる（D40）。
--
-- 【連続通報の制限】
--   同じ作品への2回目は表の UNIQUE が拒む。それとは別に、
--   24時間で10件までにする。1人が短時間に大量の通報を作れると、
--   運営が見るべき列がすぐ埋まってしまう。
--
-- 【CAPTCHA は未導入】
--   ゲストはブラウザのデータを消せば作り直せるので、この制限だけでは
--   大量投稿を止めきれない。公開前の必須課題として残す（P6）。

create function public.create_report(
  p_work_id uuid,
  p_reason  text,
  p_detail  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
  v_detail text;
  v_recent int;
  v_id     bigint;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- 対象は「いま公開されている作品」だけ。
  -- 見つからない理由（非公開／削除済み／存在しない）は区別しない
  if not exists (
    select 1 from public.works w
     where w.id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ) then
    raise exception 'REPORT_TARGET_NOT_FOUND: その作品は見つかりません。';
  end if;

  if p_reason is null
     or p_reason not in ('copyright', 'inappropriate', 'spam', 'ai_undeclared', 'other')
  then
    raise exception 'REPORT_REASON_INVALID: 理由を選んでください。';
  end if;

  v_detail := nullif(btrim(coalesce(p_detail, '')), '');

  if p_reason = 'other' and v_detail is null then
    raise exception
      'REPORT_DETAIL_REQUIRED: 「その他」を選んだ場合は、内容を書いてください。';
  end if;

  if v_detail is not null and char_length(v_detail) > 1000 then
    raise exception 'REPORT_DETAIL_TOO_LONG: 内容は1000字までです（いま %字）。',
      char_length(v_detail);
  end if;

  -- 短時間に大量の通報を作らせない
  select count(*)::int into v_recent
    from public.reports r
   where r.reporter_id = v_uid
     and r.created_at > now() - interval '24 hours';

  if v_recent >= 10 then
    raise exception
      'REPORT_RATE_LIMITED: 24時間に通報できるのは10件までです。'
      '時間をおいてからお試しください。';
  end if;

  begin
    insert into public.reports (work_id, reporter_id, reason, detail)
    values (p_work_id, v_uid, p_reason, v_detail)
    returning id into v_id;
  exception
    when unique_violation then
      raise exception
        'REPORT_ALREADY_SENT: この作品はすでに報告済みです。'
        '重ねて送る必要はありません。';
  end;

  -- 返すのは受け付けたことだけ。**通報の総数や、ほかの人の通報は返さない**
  -- （何件集まると何が起きるかを外から測らせない）
  return jsonb_build_object('report_id', v_id, 'accepted', true);
end;
$fn$;

comment on function public.create_report(uuid, text, text) is
  '作品を通報する。ゲストも可（spec 8-4）。公開中の作品以外は同じ文言で断る（D40）。'
  '同一作品への2回目は表の UNIQUE、24時間10件はこの関数が拒む。';

revoke all on function public.create_report(uuid, text, text)
  from public, anon, authenticated;

grant execute on function public.create_report(uuid, text, text)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 7. delete_work ／ 作品の削除（論理削除）
-- ----------------------------------------------------------------------------
--
-- **行は消さない。** 回答・いいね・お気に入り・通報が works を参照していて、
-- どれも ON DELETE CASCADE。行ごと消すと、通報された作品を消すと通報も
-- 消えるという、運営の判断材料が残らない形になる。
--
-- **公開から外すのが先、画像を消すのは後。** 逆にすると、画像が消えたのに
-- 作品が公開されたままの時間が生まれる。この関数は画像に触れず、
-- 消すべきパスを返すだけ。実際に消すのはアプリ側。
--
-- 消せたら mark_work_image_deleted を呼ぶ。呼ばれないまま終わっても
-- 作品は削除済みのままで、公開へは戻らない（update_work が deleted_at を
-- 見て断る）。残るのは容量の問題だけで、Step 16 の掃除が拾う。

create function public.delete_work(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_work record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception 'GUEST_CANNOT_POST: この操作にはアカウント登録が必要です。';
  end if;

  -- 自分の作品でなければ、存在しないのと同じ扱いにする（D40）
  select w.id, w.image_path, w.deleted_at
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  -- すでに削除済みなら、もう一度消したことにはしない。
  -- ただし画像のパスは返す（掃除の再試行に使えるようにするため）
  if v_work.deleted_at is not null then
    return jsonb_build_object(
      'work_id',    v_work.id,
      'image_path', v_work.image_path,
      'deleted_at', v_work.deleted_at,
      'already',    true
    );
  end if;

  update public.works w
     set is_published = false,   -- 先に公開から外す
         deleted_at   = now()
   where w.id = p_work_id;

  return jsonb_build_object(
    'work_id',    v_work.id,
    'image_path', v_work.image_path,
    'deleted_at', now(),
    'already',    false
  );
end;
$fn$;

comment on function public.delete_work(uuid) is
  '作品の論理削除。行は消さず is_published=false と deleted_at を立てる。'
  '画像は消さず、消すべきパスを返すだけ（消すのはアプリ側）。本人のみ。';

revoke all on function public.delete_work(uuid)
  from public, anon, authenticated;

grant execute on function public.delete_work(uuid)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 8. mark_work_image_deleted ／ 画像を消せたことの記録
-- ----------------------------------------------------------------------------
--
-- 削除済みの作品にだけ印を付ける。まだ削除していない作品の画像を
-- 「消した」ことにはできない（消えていない画像を掃除対象から外さないため）。

create function public.mark_work_image_deleted(p_work_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_at  timestamptz;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  update public.works w
     set image_deleted_at = coalesce(w.image_deleted_at, now())
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is not null
  returning w.image_deleted_at into v_at;

  if v_at is null then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  return jsonb_build_object('work_id', p_work_id, 'image_deleted_at', v_at);
end;
$fn$;

comment on function public.mark_work_image_deleted(uuid) is
  '削除済み作品の画像を Storage から消せたことを記録する。'
  'null のまま残っていれば消し残しで、Step 16 の掃除が再試行する。';

revoke all on function public.mark_work_image_deleted(uuid)
  from public, anon, authenticated;

grant execute on function public.mark_work_image_deleted(uuid)
  to authenticated;
