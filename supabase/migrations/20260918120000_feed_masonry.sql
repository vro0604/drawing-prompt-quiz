-- ============================================================================
-- 作品一覧を「絵そのものを並べる面」に変えるための DB 側（2026-09-18）
-- ============================================================================
--
-- 【この migration が足すもの】
--   1. work_uninterests           … 「興味なし」の記録（1人×1作品で1行）
--   2. set_work_uninterest(...)   … その記録を付ける／外す
--   3. count_public_works()       … 公開作品が何件あるか（0件の判定に使う）
--   4. get_feed_works(...)        … 一覧の1件を返す。既存より4列多い
--
-- 【既存を1つも書き換えない】
--   get_public_works（旧5引数版・新6引数版）には触れない。
--   列を足したくなったが、`create or replace` は**返す列を変えられない**
--   （42P13）。drop して作り直すと、旧い画面が動いている時間帯に
--   作品一覧が丸ごと落ちる。同じ事情で 20260906090000 が旧版を残したのと
--   同じ判断をここでも採る。**別の名前の関数を新しく作る。**
--
--   その結果、一覧を取る入口は3つ並ぶ。
--     get_public_works(5引数)  旧い画面のための素通し（互換期間）
--     get_public_works(6引数)  いまの画面（未回答のみ を持つ）
--     get_feed_works(6引数)    新しい一覧（ここで足すもの）
--   新しい画面は get_feed_works だけを呼ぶ。
--
-- 【なぜ4列増えるのか】
--   新しい一覧は、絵の上に「回答済みの印・保存の状態・いいねの状態・
--   作者のアイコン」を出す。これを画面から1件ずつ問い合わせると、
--   24件の一覧で24往復になる。**一覧を取るのと同じ1回で返す。**
--
--     answered_by_me      押したときクイズへ行くか結果へ行くかを決める
--     saved_by_me         保存の入り／切り
--     liked_by_me         いいね済みの枠を出すかどうか
--     author_avatar_path  作者のアイコン
--
--   いずれも**見ている本人の状態だけ**で、他人が誰を保存したかは返らない。
--   利用者が決まっていない（auth.uid() が null）ときは3つとも false になる。
--
-- 【回答前の情報を1つも足していない】
--   返す列に、お題・正解・他人の回答・回答分布・伝達率・コメントは無い。
--   増えたのは上の4列だけで、どれも**見ている本人の行動の有無**である。
--   title は既存の一覧と同じく返るが、これは
--   画像の代替文（alt）と読み上げのために要る。画面には出さない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 「興味なし」の記録
-- ----------------------------------------------------------------------------
--
-- 【何をする表か】
--   ある人が、ある作品を「もう一覧に出さなくてよい」と印を付けた記録。
--   1人×1作品で1行しか持たない（主キー）。
--
-- 【誰にも直接読ませない】
--   列の権限を配らない（遮断表）。読み書きは下の関数だけを通る。
--   「誰がどの作品を興味なしにしたか」は本人以外に見せる必要が無く、
--   作者に見せると投稿を萎縮させる。**件数も返さない。**
--
-- 【ゲストも使える】
--   user_id は auth.users ではなく profiles を指す（likes / saves と同じ）。
--   匿名ゲストにも profiles の行があるので、ゲストのまま印を付けられる。
--   ゲストが30日で片づけられると、この行も一緒に消える（CASCADE）。
--
-- 【作品が消えたら一緒に消える】
--   作品の行そのものが消えるのは掃除のときだけだが、
--   残しても誰も読まない行になるので CASCADE で消す。

create table if not exists public.work_uninterests (

  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  user_id uuid not null
    references public.profiles (id) on delete cascade on update restrict,

  created_at timestamptz not null default now(),

  constraint work_uninterests_pkey primary key (work_id, user_id)
);

comment on table public.work_uninterests is
  '「興味なし」の記録（2026-09-18）。1人×1作品で1行。'
  '一覧から外すためだけに使う。件数も一覧も外へは返さない。';

-- 一覧を引くときは「この人が興味なしにした作品」を引く。
-- 主キーは (work_id, user_id) なので、user_id を先頭に持つ索引を別に置く。
create index if not exists work_uninterests_user_idx
  on public.work_uninterests (user_id, work_id);

alter table public.work_uninterests enable row level security;

-- 遮断表。**ポリシーは1本も張らない。**張らないので、
-- 直接の select / insert はどのロールからも通らない。
revoke all on table public.work_uninterests from public;
revoke all on table public.work_uninterests from anon;
revoke all on table public.work_uninterests from authenticated;


-- ----------------------------------------------------------------------------
-- 2. 「興味なし」を付ける／外す
-- ----------------------------------------------------------------------------
--
-- 【入り切りを引数で受け取る】
--   toggle_like のように「押すたびに入れ替わる」形にしない。
--   一覧は同じ作品が画面に何度も出うるので、押した結果が
--   いま入っているのか切れているのかを、呼ぶ側が指定できるほうが安全。
--
-- 【ゲストも呼べる】
--   submit_answer と同じ扱い（spec 10 の権限表）。
--   興味なしは「見る人が自分の一覧を整える」操作で、
--   ランキングにも他人の画面にも影響しない。登録を求める理由が無い。
--
-- 【存在しない作品でも成功にする】
--   その作品が在るのか無いのかを、成功／失敗で数えられないようにする（D40）。
--   外部キーがあるので存在しない作品では insert が落ちる。落ちる前に
--   公開作品かどうかを見て、違えば何もせず false を返す。

create or replace function public.set_work_uninterest(
  p_work_id       uuid,
  p_uninterested  boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED: この操作にはサインインが必要です';
  end if;

  -- 公開されている作品にだけ印を付けられる。
  -- 非公開・削除済み・存在しないIDは、どれも同じ「何もしない」で返す。
  select true into v_ok
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    return jsonb_build_object('work_id', p_work_id, 'uninterested', false, 'applied', false);
  end if;

  if coalesce(p_uninterested, true) then
    insert into public.work_uninterests (work_id, user_id)
    values (p_work_id, v_uid)
    on conflict (work_id, user_id) do nothing;
  else
    delete from public.work_uninterests
     where work_id = p_work_id and user_id = v_uid;
  end if;

  return jsonb_build_object(
    'work_id', p_work_id,
    'uninterested', coalesce(p_uninterested, true),
    'applied', true
  );
end;
$fn$;

comment on function public.set_work_uninterest(uuid, boolean) is
  '「興味なし」を付ける／外す（2026-09-18）。'
  '押すたびに入れ替わるのではなく、どちらにするかを引数で受け取る。'
  'ゲストも呼べる。公開作品以外は何もせず applied=false を返す（D40）。';

revoke all on function public.set_work_uninterest(uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.set_work_uninterest(uuid, boolean) to authenticated;


-- ----------------------------------------------------------------------------
-- 3. 公開作品が何件あるか
-- ----------------------------------------------------------------------------
--
-- 【何のためにあるか】
--   一覧が空のとき、**本当に1件も無いのか**、それとも
--   絞り込みの結果として0件なのかを区別するために使う。
--   1件も無いときだけ、画面は見本のカードを並べる。
--
-- 【見ている人によって変わらない】
--   興味なし・未回答のみ・部門・完成度、どれも掛けない。
--   掛けると「全部を興味なしにした人」に見本が出てしまう。
--   見本は**まだ誰も投稿していないサービス**のための表示であって、
--   その人の一覧が空になったこととは別。
--
-- 【AI も数える】
--   通常の一覧に AI は出ないが、AI の作品が1件でもあれば
--   「まだ作品がありません」は事実に反する。

create or replace function public.count_public_works()
returns int
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::int
    from public.works w
   where w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;
$$;

comment on function public.count_public_works() is
  '公開作品の総数（2026-09-18）。0件のときだけ画面が見本のカードを出す。'
  '絞り込みも興味なしも掛けない。見ている人によって値が変わらない。';

revoke all on function public.count_public_works() from public, anon, authenticated;
grant execute on function public.count_public_works() to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. 新しい一覧
-- ----------------------------------------------------------------------------
--
-- 【既存の get_public_works との違いは4つだけ】
--   ・author_avatar_path / answered_by_me / liked_by_me / saved_by_me を返す
--   ・「興味なし」を付けた作品を外す
--   ・それ以外（絞り込み・並べ替え・上限・AI の分離）は1文字も変えていない
--
-- 【なぜ上限を50から100へ上げるのか】
--   一覧が縦に長い列で並ぶ形になり、1画面に入る枚数が増えた。
--   24件だと、広い画面では最初の1画面で尽きて、
--   スクロールが始まる前に読み足しが走る。
--   **既定は変えない**（渡さなければ従来と同じ件数になる）。

create or replace function public.get_feed_works(
  p_division         text,
  p_sort             text,
  p_limit            int,
  p_offset           int,
  p_completeness     text,
  p_unanswered_only  boolean
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  completeness        text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text,
  author_avatar_path  text,
  answered_by_me      boolean,
  liked_by_me         boolean,
  saved_by_me         boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.completeness,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,
    p.mode_key,
    p.was_rerolled,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at,
    pr.id,
    pr.handle,
    pr.display_name,
    pr.avatar_path,
    -- 以下3つは**見ている本人の行動の有無**だけ。誰が押したかは返さない
    exists (select 1 from public.answers a
             where a.work_id = w.id and a.user_id = (select auth.uid())),
    exists (select 1 from public.likes l
             where l.work_id = w.id and l.user_id = (select auth.uid())),
    exists (select 1 from public.saves s
             where s.work_id = w.id and s.user_id = (select auth.uid()))
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and case
          when p_division is null  then w.division <> 'ai'
          when p_division = 'all'  then true
          else w.division = p_division
        end
    and (p_completeness is null or w.completeness = p_completeness)
    -- 未回答のみ（D169 の11）。利用者が分からないときは絞らない
    and (
      not coalesce(p_unanswered_only, false)
      or (select auth.uid()) is null
      or not exists (select 1 from public.answers a
                      where a.work_id = w.id
                        and a.user_id = (select auth.uid()))
    )
    -- 興味なし。**押した本人の一覧からだけ消える。**
    -- 作品そのものは公開のままで、他の人の一覧にも、作者の画面にも残る
    and not exists (select 1 from public.work_uninterests u
                     where u.work_id = w.id
                       and u.user_id = (select auth.uid()))
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 100)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_feed_works(text, text, int, int, text, boolean) is
  '新しい作品一覧（2026-09-18）。get_public_works に4列足したもの。'
  'author_avatar_path / answered_by_me / liked_by_me / saved_by_me。'
  '「興味なし」を付けた作品は、押した本人の一覧からだけ消える。'
  'お題・正解・他人の回答・伝達率は1つも返さない（D23 / D64）。';

revoke all on function public.get_feed_works(text, text, int, int, text, boolean)
  from public, anon, authenticated;
grant execute on function public.get_feed_works(text, text, int, int, text, boolean)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_n   int;
  v_def text;
begin
  -- 5-1. 既存の入口を壊していないこと。
  --      get_public_works は旧5引数版と新6引数版の2つのままでなければならない。
  select count(*)::int into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_public_works';
  if v_n <> 2 then
    raise exception
      'get_public_works が % 個あります（2 のはずです）。'
      '既存の入口を壊すと、旧い画面が動いている時間帯に一覧が落ちます', v_n;
  end if;

  -- 5-2. 新しい入口が1つだけあること（引数違いを増やさない）
  select count(*)::int into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_feed_works';
  if v_n <> 1 then
    raise exception 'get_feed_works が % 個あります（1 のはずです）', v_n;
  end if;

  -- 5-3. 新しい入口が 25 列を返すこと（既存21列＋4列）
  select count(*)::int into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join lateral unnest(p.proargmodes) as m
   where n.nspname = 'public' and p.proname = 'get_feed_works'
     and m = 't';
  if v_n <> 25 then
    raise exception 'get_feed_works が返す列が % 個です（25 のはずです）', v_n;
  end if;

  -- 5-4. 「興味なし」の表に権限が1つも配られていないこと
  select count(*)::int into v_n
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name = 'work_uninterests'
     and grantee in ('anon', 'authenticated');
  if v_n <> 0 then
    raise exception
      'work_uninterests に anon/authenticated の権限が % 件あります（0 のはずです）', v_n;
  end if;

  -- 5-5. 「興味なし」の表に RLS ポリシーが1本も無いこと（遮断表の作法）
  select count(*)::int into v_n
    from pg_policies
   where schemaname = 'public' and tablename = 'work_uninterests';
  if v_n <> 0 then
    raise exception
      'work_uninterests に RLS ポリシーが % 本あります（0 のはずです）', v_n;
  end if;

  -- 5-6. 新しい一覧が「興味なし」を見ていること。
  --      条件が消えると、興味なしを押しても一覧に残り続ける。
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_feed_works';
  if v_def not like '%work_uninterests%' then
    raise exception 'get_feed_works が work_uninterests を見ていません';
  end if;

  -- 5-7. 新しい一覧が anon からも呼べること（未サインインでも一覧は出る）
  if not has_function_privilege('anon',
        'public.get_feed_works(text,text,int,int,text,boolean)', 'EXECUTE') then
    raise exception 'get_feed_works を anon が呼べません（一覧は未サインインでも出ます）';
  end if;

  -- 5-8. 興味なしの書き込みを anon が呼べないこと（ゲストの発行が先に要る）
  if has_function_privilege('anon',
        'public.set_work_uninterest(uuid,boolean)', 'EXECUTE') then
    raise exception 'set_work_uninterest を anon が呼べます（authenticated だけのはずです）';
  end if;
end;
$$;
