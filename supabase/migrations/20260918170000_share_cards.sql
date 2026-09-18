-- ============================================================================
-- 共有カードと共有記録 ／ SNS へ「作品＋問い」を出し、戻ってきた人を数える
-- ============================================================================
--
-- 【何をする移行か】
--   1. 共有カードの「そのときの見た目」を控える表を1つ足す
--      （share_card_revisions）
--   2. 共有操作そのものを1行ずつ残す表を1つ足す（share_events）
--   3. 既存の計測表 usage_events に、共有の道すじ6つを足す
--
-- 【なぜ表を2つに分けるか】
--   控え（revision）は**中身**である。作品の絵・問いの文・作者の表示名が
--   その瞬間どうだったか。同じ中身なら1行を使い回す。
--
--   共有記録（share_events）は**出来事**である。誰が・いつ・どこへ出したか。
--   同じ人が同じ作品を2回出したら2行になる。使い回さない。
--
--   1つの表にまとめると、「同じ中身だから1行でいい」と
--   「毎回べつの行がいる」が同じ列に同居する。分ける。
--
-- 【なぜ usage_events をそのまま使わないのか】
--   usage_events は event_key と user_id と work_id しか持たない。
--   共有は「どの問いを」「どこへ」出したかを分けて数えたい（利用者の指示 36）。
--   列が足りないので、共有の出来事だけ share_events に置き、
--   そこから先の道すじ（開いた・選んだ・入ってきた・答えた・見た・進んだ）を
--   usage_events に足す。**計測の入れ物を2つ目に作るのではなく、
--   既存の入れ物に列と種類を足して、共有記録と突き合わせる形にする。**
--
-- 【この移行が壊さないもの】
--   既存の表は1つも作り替えない。列の削除も型の変更もしない。
--   usage_events への追加はすべて null を許す列と、種類の許可リストの拡張だけ。
--   既にある2種類（share_opened / next_work_opened）は許可リストに残る。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 共有カードの控え
-- ----------------------------------------------------------------------------
--
-- 【なぜ控えるのか】
--   共有したあとに作者が問いの文や表示名を変えても、**すでに流れた
--   投稿のカードは共有した時点の内容のまま**にしたい（利用者の指示 26 / 27）。
--   そのためには、共有した瞬間の中身をこちらで持っておくしかない。
--
-- 【控えないもの】
--   回答数・正答率・伝達率・結果の分布は1つも入れない。
--   カードに載せないので、変わっても新しい控えを作る理由にならない。
--
-- 【安全に関わる状態は控えを信じない】
--   非公開・削除・匿名・センシティブは、控えではなく**そのときの現況**が
--   勝つ（利用者の指示 27）。だから控えにも欄はあるが、
--   カードを描く関数は必ず現況を読み直して上書きする。
--   控えの欄は「共有した時点はこうだった」という記録にすぎない。

create table if not exists public.share_card_revisions (
  id uuid primary key default gen_random_uuid(),

  -- どの作品の控えか。作品が本当に消えたら控えも消す。
  -- **これは cascade でよい。**控えは作品の中身の写しなので、
  -- 作品が消えたあとに写しだけ残すと、消したはずの絵の題材が残る。
  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  -- どの問いを載せたか。問いはお題ごとに作り直されるので、
  -- 消えても控えは残す（共有の履歴を消さない）
  question_id bigint
    references public.quiz_questions (id) on delete set null on update restrict,

  -- 載せた文そのもの。「モーフ はどれ？」のような1行
  question_text_snapshot text
    constraint share_card_revisions_question_text_len
      check (question_text_snapshot is null
             or char_length(question_text_snapshot) between 1 and 200),

  -- 作者の表示名。匿名のときは null
  author_display_name_snapshot text
    constraint share_card_revisions_author_len
      check (author_display_name_snapshot is null
             or char_length(author_display_name_snapshot) between 1 and 30),

  -- 作者を伏せる作品か。**いまのサービスにこの状態は無い。**
  -- 欄だけ先に置くのは、匿名の作品が現れたときに
  -- 控えの形を変えずに扱えるようにするため
  anonymous_snapshot boolean not null default false,

  -- AI生成の部門か（works.division = 'ai'）
  ai_flag boolean not null default false,

  -- 運営が伏せた作品か（works.review_status <> 'ok'）
  sensitive_flag boolean not null default false,

  -- 絵の場所と大きさ。**切り取り方はこの3つから決まる**ので、
  -- 別に切り取りの欄を持たない（このサービスは作品ごとの
  -- 切り取り情報を保存していない。表示のたびに縦横比から決めている）
  image_path_snapshot text not null
    constraint share_card_revisions_image_path_len
      check (char_length(image_path_snapshot) between 1 and 512),
  image_width_snapshot int not null
    constraint share_card_revisions_image_width_range
      check (image_width_snapshot between 1 and 20000),
  image_height_snapshot int not null
    constraint share_card_revisions_image_height_range
      check (image_height_snapshot between 1 and 20000),

  -- カードの型の版。型を大きく変えたらここを上げる。
  -- 上げると同じ作品でも別の控えになる（利用者の指示 26）
  template_version int not null default 1
    constraint share_card_revisions_template_version_range
      check (template_version between 1 and 10000),

  -- 同じ中身かどうかを1つの文字列で見分ける鍵。
  -- **同じ中身なら控えを作り直さない**（利用者の指示 29）
  content_key text not null
    constraint share_card_revisions_content_key_len
      check (char_length(content_key) between 1 and 512),

  created_at timestamptz not null default now(),

  -- 同じ作品・同じ中身の控えは1行だけ
  constraint share_card_revisions_content_unique unique (work_id, content_key)
);

comment on table public.share_card_revisions is
  'SNS共有カードの「そのときの見た目」の控え。'
  '同じ中身なら1行を使い回す。回答数・正答率・伝達率は載せないので控えない。'
  '非公開・削除・匿名・センシティブは控えではなく現況が勝つ。';

create index if not exists share_card_revisions_work_idx
  on public.share_card_revisions (work_id, created_at desc);

alter table public.share_card_revisions enable row level security;

-- 遮断表。ポリシーを1本も張らないので、直接の select / insert は
-- どのロールからも通らない（D65）
revoke all on table public.share_card_revisions from public;
revoke all on table public.share_card_revisions from anon;
revoke all on table public.share_card_revisions from authenticated;


-- ----------------------------------------------------------------------------
-- 2. 共有の出来事
-- ----------------------------------------------------------------------------
--
-- 【1行 ＝ 1回の共有操作】
--   同じ人が同じ作品・同じ問い・同じ共有先へ2回出したら2行になる。
--   投稿ごとに、そこから戻ってきた人を分けて数えるため（利用者の指示 14）。
--
-- 【id は合言葉ではない】
--   この id（shareId）は共有URLに載るが、**見る権利とは何の関係も無い**
--   （利用者の指示 18）。非公開の作品は、id を知っていても開かない。
--   判定は今までどおり get_work_detail の3条件だけが行う。
--
-- 【未サインインでも共有できる】
--   sharer_user_id は null を許す。ここを登録者だけにすると、
--   いちばん人数の多い層の共有が数から消える（usage_events と同じ考え方）。

create table if not exists public.share_events (
  -- これが共有URLに載る shareId
  id uuid primary key default gen_random_uuid(),

  -- 作品が本当に消えても、共有の履歴は消さない（利用者の指示 30）
  work_id uuid
    references public.works (id) on delete set null on update restrict,

  question_id bigint
    references public.quiz_questions (id) on delete set null on update restrict,

  -- 退会したら null になる。行そのものは残す
  sharer_user_id uuid
    references public.profiles (id) on delete set null on update restrict,

  channel text not null
    constraint share_events_channel_valid
      check (channel in ('x', 'bluesky', 'native', 'copy')),

  -- 控えが消えても出来事は残す
  card_revision_id uuid
    references public.share_card_revisions (id) on delete set null on update restrict,

  -- 共有したのが登録者か、ゲスト（匿名サインイン）か。
  -- **誰かを特定する値ではない。**流入の質を分けて数えるためだけ
  is_guest boolean,

  created_at timestamptz not null default now()
);

comment on table public.share_events is
  '共有操作を1回につき1行。id が共有URLに載る shareId。'
  'shareId は見る権利ではない（非公開作品は id を知っていても開かない）。'
  '未サインインでも共有できるので sharer_user_id は null を許す。';

create index if not exists share_events_work_created_idx
  on public.share_events (work_id, created_at desc);
create index if not exists share_events_channel_created_idx
  on public.share_events (channel, created_at desc);

alter table public.share_events enable row level security;

revoke all on table public.share_events from public;
revoke all on table public.share_events from anon;
revoke all on table public.share_events from authenticated;


-- ----------------------------------------------------------------------------
-- 3. 既存の計測表を広げる
-- ----------------------------------------------------------------------------
--
-- 【新しい計測の入れ物を作らない】
--   usage_events は「汎用のイベントログにしない」と決めて作られている
--   （20260904096000_usage_events.sql の頭のコメント）。その決まりは
--   「種類を CHECK で固定し、増やすときは移行を書かせる」という形で
--   守られている。いまがその移行にあたる。
--
-- 【足す種類は6つ。共有操作そのものは足さない】
--   共有操作は share_events の行がそのまま記録になっているので、
--   同じことを2か所に書かない。
--
-- 【足す列は4つ。どれも null を許す】
--   既に入っている行は null のままで、何も壊れない。

alter table public.usage_events
  drop constraint if exists usage_events_key_valid;

alter table public.usage_events
  add constraint usage_events_key_valid
    check (event_key in (
      -- もとからある2つ
      'share_opened',
      'next_work_opened',
      -- 共有の道すじ（2026-09-18）
      'share_modal_open',        -- 共有の面が実際に開いた
      'share_question_select',   -- 共有する問いを変えた
      'share_landing',           -- 共有URLから人が作品ページへ入った
      'share_answer_submit',     -- 共有された問いを含む回答を送った
      'share_result_view',       -- その回答の結果を見た
      'share_continue'           -- 結果のあと次へ進んだ
    ));

alter table public.usage_events
  add column if not exists share_id uuid
    references public.share_events (id) on delete set null on update restrict;

alter table public.usage_events
  add column if not exists question_id bigint
    references public.quiz_questions (id) on delete set null on update restrict;

alter table public.usage_events
  add column if not exists channel text;

alter table public.usage_events
  add column if not exists is_guest boolean;

alter table public.usage_events
  drop constraint if exists usage_events_channel_valid;

alter table public.usage_events
  add constraint usage_events_channel_valid
    check (channel is null or channel in ('x', 'bluesky', 'native', 'copy'));

comment on column public.usage_events.share_id is
  'どの共有からの動きか。share_events.id。共有と関係ない行では null。';
comment on column public.usage_events.question_id is
  'どの問いについての動きか。問いが作り直されたら null になる。';
comment on column public.usage_events.channel is
  '共有先（x / bluesky / native / copy）。流入元を分けて数えるため。';
comment on column public.usage_events.is_guest is
  '登録者かゲストか。誰かを特定する値ではない。';

create index if not exists usage_events_share_idx
  on public.usage_events (share_id, event_key)
  where share_id is not null;


-- ----------------------------------------------------------------------------
-- 4. 控えを作る（または使い回す）
-- ----------------------------------------------------------------------------
--
-- 内部用。外からは呼べない。共有を記録する関数だけが使う。

create or replace function public.ensure_share_card_revision(
  p_work_id     uuid,
  p_question_id bigint
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_work        record;
  v_author      text;
  v_q_text      text;
  v_anonymous   boolean := false;
  v_sensitive   boolean;
  v_ai          boolean;
  v_template    int := 1;
  v_content_key text;
  v_id          uuid;
begin
  -- 公開条件を満たす作品だけ。満たさなければ控えを作らない
  select w.id,
         w.image_path,
         w.image_width,
         w.image_height,
         w.division,
         w.review_status,
         pr.display_name
    into v_work
    from public.works w
    join public.profiles pr on pr.id = w.user_id
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  -- 問いの文。**画面と同じ言い回しにする**（features/share/card.ts と対）。
  -- 問いが指定されていない、またはこの作品の問いでないときは null
  if p_question_id is not null then
    select cs.label || ' はどれ？'
      into v_q_text
      from public.quiz_questions qq
      join public.works w2       on w2.prompt_id = qq.prompt_id
      join public.card_slots cs  on cs.card_slot_key = qq.card_slot_key
     where qq.id = p_question_id
       and w2.id = p_work_id;

    if v_q_text is null then
      -- この作品の問いではない。問い無しの共有として扱う（利用者の指示 23）
      p_question_id := null;
    end if;
  end if;

  v_ai        := (v_work.division = 'ai');
  v_sensitive := (v_work.review_status <> 'ok');
  v_author    := case when v_anonymous then null else v_work.display_name end;

  -- 同じ中身かどうかの鍵。載せるものだけを並べる。
  -- **回答数・正答率・伝達率は入れない**ので、それらが動いても控えは増えない
  v_content_key := concat_ws('|',
    v_template::text,
    coalesce(p_question_id::text, '-'),
    coalesce(v_q_text, '-'),
    coalesce(v_author, '-'),
    v_anonymous::text,
    v_ai::text,
    v_sensitive::text,
    v_work.image_path,
    v_work.image_width::text,
    v_work.image_height::text
  );

  select r.id into v_id
    from public.share_card_revisions r
   where r.work_id = p_work_id
     and r.content_key = v_content_key;

  if v_id is not null then
    return v_id;
  end if;

  insert into public.share_card_revisions (
    work_id, question_id, question_text_snapshot,
    author_display_name_snapshot, anonymous_snapshot,
    ai_flag, sensitive_flag,
    image_path_snapshot, image_width_snapshot, image_height_snapshot,
    template_version, content_key
  )
  values (
    p_work_id, p_question_id, v_q_text,
    v_author, v_anonymous,
    v_ai, v_sensitive,
    v_work.image_path, v_work.image_width, v_work.image_height,
    v_template, v_content_key
  )
  on conflict (work_id, content_key) do update
    set work_id = excluded.work_id
  returning id into v_id;

  return v_id;
end;
$fn$;

comment on function public.ensure_share_card_revision(uuid, bigint) is
  '共有カードの控えを作る。同じ中身なら既存の控えを返す。内部用。';

revoke all on function public.ensure_share_card_revision(uuid, bigint)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. 共有を記録して shareId を発行する
-- ----------------------------------------------------------------------------
--
-- 【呼ばれるのは、実際に共有操作を実行した瞬間だけ】
--   面を開いただけ・問いを選び直しただけ・下見の絵を作っただけでは
--   呼ばれない（利用者の指示 14）。呼ぶ場所は画面側に1か所しかない。
--
-- 【同じ操作を2回押しても2行になる】
--   連打を止めるのは画面側（押している間ボタンを止める）。
--   DB は「2回押した」を「2回」として正直に記録する。
--   ここで1つにまとめると、本当に2回共有した人も1回に潰れる。

create or replace function public.create_share(
  p_work_id     uuid,
  p_question_id bigint,
  p_channel     text,
  p_share_id    uuid default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_guest    boolean;
  v_revision uuid;
  v_share    uuid;
  v_question bigint;
begin
  if p_channel not in ('x', 'bluesky', 'native', 'copy') then
    raise exception 'BAD_CHANNEL: 共有先が不正です。';
  end if;

  -- 【なぜ shareId をブラウザから受け取るのか】
  --   ブラウザの共有機能（navigator.share）とコピーは、**押した操作の中で
  --   その場で呼ばないと断られる**（W3C Web Share の仕様が
  --   「transient activation が無ければ NotAllowedError で拒否する」と定めており、
  --   有効時間は「せいぜい数秒」としか書かれていない。Safari のコピーも同じ）。
  --   ここでサーバーの返事を待ってから呼ぶと、待ち時間しだいで失敗する。
  --
  --   そこで、押した瞬間にブラウザ側で id を作って共有を実行し、
  --   記録はその直後に送る。**作る時点は変わらない**（面を開いただけ・
  --   問いを選び直しただけでは作られない）。
  --
  -- 【この id は合言葉ではない】
  --   外から好きな値を送れるが、それで見られるものは1つも増えない。
  --   下の公開判定を通らなければ行すら作らないし、shareId は
  --   見る権利の判定に一度も使われない（利用者の指示 18）。
  --   すでにある id が送られてきたら断る（作り直させる）。
  if p_share_id is not null
     and exists (select 1 from public.share_events e where e.id = p_share_id) then
    raise exception 'SHARE_ID_TAKEN: その共有IDはすでに使われています。';
  end if;

  -- 公開されていない作品は共有できない。**shareId も作らない**
  if not exists (
    select 1 from public.works w
     where w.id = p_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ) then
    raise exception 'WORK_NOT_SHAREABLE: この作品は共有できません。';
  end if;

  v_revision := public.ensure_share_card_revision(p_work_id, p_question_id);

  if v_revision is null then
    raise exception 'WORK_NOT_SHAREABLE: この作品は共有できません。';
  end if;

  -- 控えが問いを落としていたら（作品の問いでなかった）、記録も落とす
  select r.question_id into v_question
    from public.share_card_revisions r
   where r.id = v_revision;

  v_guest := case
               when v_uid is null then true
               else coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
             end;

  insert into public.share_events (
    id, work_id, question_id, sharer_user_id, channel, card_revision_id, is_guest
  )
  values (
    coalesce(p_share_id, gen_random_uuid()),
    p_work_id, v_question, v_uid, p_channel, v_revision, v_guest
  )
  returning id into v_share;

  return jsonb_build_object(
    'share_id',    v_share,
    'revision_id', v_revision,
    'question_id', v_question
  );
end;
$fn$;

comment on function public.create_share(uuid, bigint, text, uuid) is
  '共有操作を1件記録し、shareId を返す。実際に共有したときだけ呼ぶ。'
  '公開条件を満たさない作品では shareId を作らない。'
  'shareId はブラウザが作った値も受け取る（押した操作の中で共有を実行するため）。';

revoke all on function public.create_share(uuid, bigint, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_share(uuid, bigint, text, uuid)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. カードを描くための材料を返す
-- ----------------------------------------------------------------------------
--
-- 【中身は控え、安全は現況】
--   p_share_id が渡されたときは、その共有の控えから**文と表示名と絵**を出す。
--   共有したあとに問いの文が変わっても、流れた投稿のカードは変わらない
--   （利用者の指示 27）。
--
--   ただし、公開／非公開・削除・匿名・センシティブは必ず現況を読む。
--   いま非公開なら、控えがあっても中身を1文字も返さない。
--
-- 【誰でも呼べる】
--   SNS のクローラーが取りに来る経路なので、サインインの概念が無い。
--   返すのは公開作品の、画面に既に出ている情報だけ（お題の答えは含まない）。

create or replace function public.get_share_card(
  p_work_id     uuid,
  p_question_id bigint default null,
  p_share_id    uuid   default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_work     record;
  v_rev      record;
  v_q_text   text;
  v_question bigint;
  v_author   text;

  -- ── 現況の安全状態。控えではなくこちらが勝つ（利用者の指示 27） ──
  --
  -- 作者を伏せる状態は、いまのこのサービスに存在しない。
  -- 作品の表は「誰の作品か」を必ず持ち、伏せる列を持っていない。
  -- だから常に false になる。**欄を消さずに残す**のは、
  -- 伏せる仕組みができたときに、ここ1行を書き換えれば
  -- 過去の共有からも名前が出なくなるようにするため。
  v_anon_now boolean := false;

  -- 運営が伏せた作品（review_status <> 'ok'）は、そもそも下の照会に
  -- 引っかからない＝ state=unavailable になる。ここへ来た時点で
  -- 伏せられていないことが確定しているので false。
  -- 「ぼかして出す」段階の区分は、いまのサービスに無い。
  v_sensitive_now boolean := false;
begin
  -- ── 現況を読む。ここが唯一の公開判定 ──
  select w.id,
         w.image_path,
         w.image_width,
         w.image_height,
         w.division,
         w.review_status,
         pr.display_name
    into v_work
    from public.works w
    join public.profiles pr on pr.id = w.user_id
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    -- 非公開・削除・伏せた作品。**中身を1文字も出さない**（利用者の指示 25）
    return jsonb_build_object('state', 'unavailable');
  end if;

  v_question := p_question_id;

  -- ── 中身。控えがあれば控えから ──
  if p_share_id is not null then
    select r.question_id,
           r.question_text_snapshot,
           r.author_display_name_snapshot,
           r.anonymous_snapshot,
           r.image_path_snapshot,
           r.image_width_snapshot,
           r.image_height_snapshot
      into v_rev
      from public.share_events e
      join public.share_card_revisions r on r.id = e.card_revision_id
     where e.id = p_share_id
       and e.work_id = p_work_id;

    if found then
      v_question := v_rev.question_id;
      v_q_text   := v_rev.question_text_snapshot;
      v_author   := v_rev.author_display_name_snapshot;

      -- 匿名は**現況が勝つ**（利用者の指示 27）。控えの anonymous_snapshot は
      -- 「共有した時点はこうだった」という記録で、いま出してよいかの根拠にしない。
      -- いまのサービスに作者を伏せる状態そのものが無いので v_anon_now は常に false。
      -- それでも控えの値を素通ししないのは、あとで匿名の作品ができたときに
      -- **古い共有から作者名が出ないようにする**ため
      if v_anon_now then
        v_author := null;
      end if;

      return jsonb_build_object(
        'state',        'ok',
        'work_id',      v_work.id,
        'question_id',  v_question,
        'question_text', v_q_text,
        'author_name',  v_author,
        'anonymous',    v_anon_now,
        'ai',           (v_work.division = 'ai'),
        'sensitive',    v_sensitive_now,
        'image_path',   v_rev.image_path_snapshot,
        'image_width',  v_rev.image_width_snapshot,
        'image_height', v_rev.image_height_snapshot
      );
    end if;
  end if;

  -- ── 控えが無い（下見・共有IDなしの取得）。いまの中身で作る ──
  if v_question is not null then
    select cs.label || ' はどれ？'
      into v_q_text
      from public.quiz_questions qq
      join public.works w2      on w2.prompt_id = qq.prompt_id
      join public.card_slots cs on cs.card_slot_key = qq.card_slot_key
     where qq.id = v_question
       and w2.id = p_work_id;

    if v_q_text is null then
      -- 問いが消えた・別の作品の問いだった。通常の作品カードへ落とす
      v_question := null;
    end if;
  end if;

  return jsonb_build_object(
    'state',        'ok',
    'work_id',      v_work.id,
    'question_id',  v_question,
    'question_text', v_q_text,
    'author_name',  case when v_anon_now then null else v_work.display_name end,
    'anonymous',    v_anon_now,
    'ai',           (v_work.division = 'ai'),
    'sensitive',    v_sensitive_now,
    'image_path',   v_work.image_path,
    'image_width',  v_work.image_width,
    'image_height', v_work.image_height
  );
end;
$fn$;

comment on function public.get_share_card(uuid, bigint, uuid) is
  '共有カードの材料。中身は控えから、公開可否は現況から。'
  '公開条件を満たさない作品には state=unavailable だけを返す。お題の答えは返さない。';

revoke all on function public.get_share_card(uuid, bigint, uuid)
  from public, anon, authenticated;
grant execute on function public.get_share_card(uuid, bigint, uuid)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. 共有の道すじを記録する
-- ----------------------------------------------------------------------------
--
-- 既存の record_usage_event は種類しか受け取れないので、
-- 共有の属性（どの問い・どの共有・どの共有先）を渡せる入口を別に作る。
-- **入れ物は同じ usage_events。**
--
-- 【クローラーはここへ来ない】
--   share_landing を呼ぶのはブラウザで画面が描かれたあとの
--   JavaScript だけ（利用者の指示 34）。クローラーは JavaScript を
--   実行しないので、この関数に届かない。

create or replace function public.record_share_event(
  p_event_key   text,
  p_work_id     uuid   default null,
  p_question_id bigint default null,
  p_share_id    uuid   default null,
  p_channel     text   default null
)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  v_uid   uuid := (select auth.uid());
  v_guest boolean;
begin
  if p_event_key not in (
    'share_modal_open', 'share_question_select', 'share_landing',
    'share_answer_submit', 'share_result_view', 'share_continue'
  ) then
    raise exception 'BAD_EVENT_KEY: 記録できない種類です。';
  end if;

  if p_channel is not null and p_channel not in ('x', 'bluesky', 'native', 'copy') then
    raise exception 'BAD_CHANNEL: 共有先が不正です。';
  end if;

  -- 知らない shareId は落として記録する。**そこで失敗にしない。**
  -- 共有URLは人の手で書き換えられるので、壊れた値で計測が止まるほうが困る
  if p_share_id is not null
     and not exists (select 1 from public.share_events e where e.id = p_share_id) then
    p_share_id := null;
  end if;

  if p_question_id is not null
     and not exists (select 1 from public.quiz_questions q where q.id = p_question_id) then
    p_question_id := null;
  end if;

  v_guest := case
               when v_uid is null then true
               else coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false)
             end;

  insert into public.usage_events (
    event_key, user_id, work_id, share_id, question_id, channel, is_guest
  )
  values (
    p_event_key, v_uid, p_work_id, p_share_id, p_question_id, p_channel, v_guest
  );
end;
$fn$;

comment on function public.record_share_event(text, uuid, bigint, uuid, text) is
  '共有の道すじ6種を usage_events に記録する。共有操作そのものは share_events が持つ。';

revoke all on function public.record_share_event(text, uuid, bigint, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_share_event(text, uuid, bigint, uuid, text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 8. 共有の道すじをまとめて数える（運営用）
-- ----------------------------------------------------------------------------
--
-- 利用者の指示 36 の9項目を、後から出せる形にしておく。
-- 画面は作らない。数えられることだけを保証する。

create or replace function public.get_share_funnel(p_days int default 30)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with span as (
    select now() - make_interval(days => greatest(1, coalesce(p_days, 30))) as since
  ),
  shares as (
    select e.* from public.share_events e, span s where e.created_at > s.since
  ),
  moves as (
    select u.* from public.usage_events u, span s
     where u.created_at > s.since
       and u.event_key in ('share_landing', 'share_answer_submit',
                           'share_result_view', 'share_continue')
  )
  select jsonb_build_object(
    'since_days',    greatest(1, coalesce(p_days, 30)),
    -- 共有操作数
    'share_actions', (select count(*) from shares),
    -- 共有流入数（人がブラウザで開いた回数だけ。クローラーは入らない）
    'share_landings', (select count(*) from moves where event_key = 'share_landing'),
    'share_answers',  (select count(*) from moves where event_key = 'share_answer_submit'),
    'share_results',  (select count(*) from moves where event_key = 'share_result_view'),
    'share_continues',(select count(*) from moves where event_key = 'share_continue'),
    -- 共有先ごと
    'by_channel', (
      select coalesce(jsonb_object_agg(c.channel, c.row), '{}'::jsonb)
        from (
          select s.channel,
                 jsonb_build_object(
                   'actions',  count(*),
                   'landings', (select count(*) from moves m
                                 where m.event_key = 'share_landing'
                                   and m.channel = s.channel),
                   'answers',  (select count(*) from moves m
                                 where m.event_key = 'share_answer_submit'
                                   and m.channel = s.channel)
                 ) as row
            from shares s group by s.channel
        ) c
    ),
    -- 問いごと
    'by_question', (
      select coalesce(jsonb_object_agg(q.question_id::text, q.row), '{}'::jsonb)
        from (
          select m.question_id,
                 jsonb_build_object(
                   'landings', count(*) filter (where m.event_key = 'share_landing'),
                   'answers',  count(*) filter (where m.event_key = 'share_answer_submit')
                 ) as row
            from moves m where m.question_id is not null group by m.question_id
        ) q
    )
  );
$fn$;

comment on function public.get_share_funnel(int) is
  '共有操作数・流入数・回答数・結果到達数・回遊数と、共有先別／問い別の内訳。運営用。';

revoke all on function public.get_share_funnel(int)
  from public, anon, authenticated;
grant execute on function public.get_share_funnel(int) to service_role;


-- ----------------------------------------------------------------------------
-- 9. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_n   int;
  v_def text;
begin
  -- 9-1. 表が2つ増えたこと
  select count(*)::int into v_n
    from pg_tables
   where schemaname = 'public'
     and tablename in ('share_card_revisions', 'share_events');
  if v_n <> 2 then
    raise exception '共有の表が % 個です（2 のはずです）', v_n;
  end if;

  -- 9-2. 2表とも RLS が有効であること
  select count(*)::int into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('share_card_revisions', 'share_events')
     and c.relrowsecurity;
  if v_n <> 2 then
    raise exception '共有の表で RLS が有効なのは % 個です（2 のはずです）', v_n;
  end if;

  -- 9-3. 2表に anon / authenticated の列権限が1つも無いこと（遮断表の作法）
  select count(*)::int into v_n
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name in ('share_card_revisions', 'share_events')
     and grantee in ('anon', 'authenticated');
  if v_n <> 0 then
    raise exception '共有の表に anon/authenticated の権限が % 件あります（0 のはずです）', v_n;
  end if;

  -- 9-4. 2表に RLS ポリシーが1本も無いこと
  select count(*)::int into v_n
    from pg_policies
   where schemaname = 'public'
     and tablename in ('share_card_revisions', 'share_events');
  if v_n <> 0 then
    raise exception '共有の表に RLS ポリシーが % 本あります（0 のはずです）', v_n;
  end if;

  -- 9-5. usage_events が8種類を受け付けること
  select count(*)::int into v_n
    from pg_constraint
   where conrelid = 'public.usage_events'::regclass
     and conname = 'usage_events_key_valid';
  if v_n <> 1 then
    raise exception 'usage_events_key_valid が % 件です（1 のはずです）', v_n;
  end if;

  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conrelid = 'public.usage_events'::regclass
     and conname = 'usage_events_key_valid';
  if v_def not like '%share_landing%' or v_def not like '%share_opened%' then
    raise exception
      'usage_events の種類に共有の道すじか既存の2種類が入っていません: %', v_def;
  end if;

  -- 9-6. usage_events に4列が足されたこと
  select count(*)::int into v_n
    from information_schema.columns
   where table_schema = 'public' and table_name = 'usage_events'
     and column_name in ('share_id', 'question_id', 'channel', 'is_guest');
  if v_n <> 4 then
    raise exception 'usage_events に足した列が % 個です（4 のはずです）', v_n;
  end if;

  -- 9-7. カードを描く関数が「答え」に触れていないこと。
  --      正解は quiz_choices.is_correct にしか無い。触れていたら漏れる
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_share_card';
  if v_def like '%is_correct%' or v_def like '%prompt_cards%' then
    raise exception 'get_share_card が答えの経路に触れています';
  end if;

  -- 9-8. 公開判定の3条件が、カードを描く関数に入っていること
  if v_def not like '%is_published%'
     or v_def not like '%review_status%'
     or v_def not like '%deleted_at%' then
    raise exception 'get_share_card に公開判定の3条件が揃っていません';
  end if;

  -- 9-9. anon が呼べるのは3本だけ（create_share / get_share_card /
  --      record_share_event）。集計は呼べない
  if not has_function_privilege('anon',
        'public.get_share_card(uuid, bigint, uuid)', 'execute') then
    raise exception 'anon が get_share_card を呼べません';
  end if;
  if not has_function_privilege('anon',
        'public.create_share(uuid, bigint, text, uuid)', 'execute') then
    raise exception 'anon が create_share を呼べません';
  end if;
  if has_function_privilege('anon', 'public.get_share_funnel(int)', 'execute') then
    raise exception 'anon が get_share_funnel を呼べます（呼べてはいけません）';
  end if;
  if has_function_privilege('anon',
        'public.ensure_share_card_revision(uuid, bigint)', 'execute') then
    raise exception 'anon が ensure_share_card_revision を呼べます（内部用です）';
  end if;
end;
$$;
