-- ============================================================================
-- profile_public_rpcs ／ Step 14: 公開プロフィール・公開設定・お気に入り一覧
-- ============================================================================
--
-- 【このファイルがやること】
--   1. update_my_profile を差し替える（予約語の検査を足すだけ）
--   2. update_my_visibility  … 公開設定3つをまとめて更新する
--   3. get_public_profile    … 公開プロフィール1件（描き手の記録つき）
--   4. get_user_works        … その人の公開作品一覧（部門タブ用）
--   5. get_saved_works       … お気に入り一覧（本人用と他人用を兼ねる）
--   6. get_public_answers    … 回答履歴（作品・日時・正答数だけ）
--
-- 【このファイルがやらないこと】
--   ・表・列・制約・データに一切触れない
--   ・既存の権限を取り上げない
--   ・退会・アカウント削除を作らない（公開前必須課題 P1）
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/016_profile_public_rpcs_rollback.sql
--
--
-- ============================================================================
-- 公開プロフィールの URL と、ID の予約語（D55 で Step 14 へ送った宿題）
-- ============================================================================
--
-- 【URL は /u/{handle} に確定する】
--
--   `/{handle}` のように直下へ置かない。直下にすると、ID がアプリの
--   ページ名（/works /play /rankings …）と同じ空間に並ぶ。あとから
--   ページを1つ増やすたびに「その名前の ID を持つ人」と衝突する可能性が出て、
--   **既存の利用者の URL を壊さないと新機能を出せなくなる**。
--
--   /u/ を挟んでおけば、ページ名と ID はぶつかりようがない。
--   URL が1階層長くなるのと引き換えに、この先ずっと衝突を考えずに済む。
--
-- 【予約語を禁じる】
--
--   /u/ を挟んだのでページ名との衝突は起きないが、**なりすまし**は別問題。
--   admin / official / support のような ID は、それだけで運営を名乗れる。
--   通報や問い合わせの案内と見分けがつかない相手を作らせない。
--
--   将来 URL を短くしたくなったときの保険も兼ねて、アプリのページ名も
--   まとめて押さえておく。取り返すより、最初から配らないほうが安い。
--
--   検査は update_my_profile の中で行う（handle を設定できる唯一の経路。D55）。
--   表にしないのは、語の追加が「データ投入」ではなく「方針の変更」であり、
--   マイグレーションとして記録に残ったほうがよいため。
--
-- 【変更回数は当面制限しない】
--
--   変えた瞬間に古い ID が空き、他人が取れる。公開ページができた以上、
--   これは実害になりうる（外部に貼られたリンクが別人に届く）。
--   ただし対策には「手放した ID を寝かせる」ための保存先が要り、
--   表の追加を伴う。**公開前の必須課題として決着させる**（P5）。
--
--
-- ============================================================================
-- show_saved_works が false のとき、何を返すか
-- ============================================================================
--
--   **0件を返すのではなく、タブそのものを出さない。**
--
--   0件で返すと「この人はお気に入りを公開していない」のか
--   「公開しているが1件も無い」のかを画面が区別できず、どちらとも取れる
--   表示になる。件数を隠すだけでも「使っているかどうか」は伝わってしまう。
--
--   そこで get_public_profile が show_saved_works をそのまま返し、
--   **画面がタブを出すかどうかを決める**。false の人のページには
--   タブも件数も現れない。
--
--   get_saved_works 側も二重に守る（設定が false の他人には0件を返す）。
--   画面の作りを間違えても、DB からは出ない。
--
--   なお **本人には常に見える**。自分が保存したものが、自分の設定しだいで
--   見られなくなるのは道理に合わない。
--
--
-- ============================================================================
-- お気に入り一覧に「お題の答え」を載せる条件
-- ============================================================================
--
--   **その閲覧者がその作品へ回答済みのときだけ。**
--
--   お気に入りに入れただけで答えが見えるなら、クイズは成り立たない。
--   保存 → 一覧を開く、の2手で答えに辿り着けてしまう。
--
--   条件は作品ページ（get_my_answer）とまったく同じ
--   「その閲覧者の answers 行があるか」。したがってこの関数は、
--   **閲覧者がすでに知っていること以上を何も返さない**。
--
--   これで prompt_cards（＝答え）に触れる関数は3本から4本になる。
--   db:verify はその本数を数えていて、増えたら止まる。今回は意図した増加なので
--   4本に更新し、代わりに「回答済み判定なしに prompt_cards を読んでいないか」を
--   見る項目を足す。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. update_my_profile ／ 予約語の検査を足す
-- ----------------------------------------------------------------------------
--
-- 引数と返り値は Step 6 本体のまま。中身だけを差し替える。
-- 足したのは「--- 2-b. 予約語」の1ブロックだけで、ほかの行は変えていない。

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

  -- 配らない ID。3つの理由でまとめてある。
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
begin

  -- --- 1. 誰が変更しようとしているか -----------------------------------------

  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_SET_PROFILE: プロフィールの設定にはアカウント登録が必要です。';
  end if;


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

    -- --- 2-b. 予約語 ---------------------------------------------------------
    --
    -- なりすましを防ぐのが主目的。すでに自分が持っている ID なら通す
    -- （この検査より前に取られた語を、あとから取り上げないため）。

    if v_handle = any(v_reserved)
       and v_handle is distinct from (select p.handle from public.profiles p where p.id = v_uid)
    then
      raise exception
        'HANDLE_RESERVED: その ID は使えません。運営の名前と間違えやすい語や、'
        'ページの名前と同じ語は登録できません。';
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
           links        = coalesce(p_links, p.links)
     where p.id = v_uid;
  exception
    when unique_violation then
      raise exception 'HANDLE_TAKEN: その ID はすでに使われています。別の ID にしてください。';
  end;

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
  'handle を設定できる唯一の経路（列権限では更新できない。001 の設計）。'
  '予約語は配らない。登録ユーザーのみ。';

revoke all on function public.update_my_profile(text, text, text, jsonb)
  from public, anon, authenticated;

grant execute on function public.update_my_profile(text, text, text, jsonb)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 2. update_my_visibility ／ 公開設定
-- ----------------------------------------------------------------------------
--
-- 001 は show_* 3列に直接の更新権限を与えている。それでも関数を置くのは、
-- **ゲストに公開設定を持たせないため**。ゲストのプロフィールはそもそも
-- 他人から見えない（001 の SELECT ポリシー）ので、設定できても意味が無く、
-- 「設定したのに公開されない」という分かりにくい状態だけが残る。
--
-- 001 の列権限は取り上げない。取り上げると 001 の設計そのものを
-- 書き換えることになり、この工程の範囲を越える。

create function public.update_my_visibility(
  p_show_answer_stats   boolean default null,
  p_show_answer_history boolean default null,
  p_show_saved_works    boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, false) then
    raise exception
      'GUEST_CANNOT_SET_VISIBILITY: 公開設定にはアカウント登録が必要です。';
  end if;

  -- null は「変更しない」（D49 と同じ）
  update public.profiles p
     set show_answer_stats   = coalesce(p_show_answer_stats,   p.show_answer_stats),
         show_answer_history = coalesce(p_show_answer_history, p.show_answer_history),
         show_saved_works    = coalesce(p_show_saved_works,    p.show_saved_works)
   where p.id = v_uid;

  return (
    select jsonb_build_object(
      'show_answer_stats',   p.show_answer_stats,
      'show_answer_history', p.show_answer_history,
      'show_saved_works',    p.show_saved_works
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$fn$;

comment on function public.update_my_visibility(boolean, boolean, boolean) is
  '公開設定3つを更新する。null は「変更しない」。登録ユーザーのみ。';

revoke all on function public.update_my_visibility(boolean, boolean, boolean)
  from public, anon, authenticated;

grant execute on function public.update_my_visibility(boolean, boolean, boolean)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 3. get_public_profile ／ 公開プロフィール1件
-- ----------------------------------------------------------------------------
--
-- 見つからないときは null。存在しない handle と、非公開の handle を
-- 区別しない（D40）。
--
-- 【描き手としての記録は常に公開】（spec 12-0）
--   投稿した作品そのものが公開なので、その集計を隠しても意味が無い。
--
-- 【獲得いいねは作者本人のぶんを除く】
--   「獲得」は他人から受け取った数のこと。自作へのいいねを足すと、
--   自分で押すだけで数字が増える（D57 と同じ考え方）。
--
-- 【伝わりやすさは回答5人以上の作品だけ】（R6 / 12-2 と同じ下限）

create function public.get_public_profile(p_handle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select p.id, p.handle, p.display_name, p.bio, p.links, p.created_at,
           p.show_answer_stats, p.show_answer_history, p.show_saved_works
      from public.profiles p
     where p.handle = lower(btrim(p_handle))
       and p.is_anonymous = false
  ),
  pub as (
    select w.id, w.actual_time_seconds, w.answers_count, w.user_id
      from public.works w
      join target t on t.id = w.user_id
     where w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
  ),
  eligible as (
    -- 伝わりやすさの対象。回答が5人に満たない作品は平均に入れない
    select pb.id from pub pb where pb.answers_count >= 5
  )
  select jsonb_build_object(
    'id',           t.id,
    'handle',       t.handle,
    'display_name', t.display_name,
    'bio',          t.bio,
    'links',        t.links,
    'created_at',   t.created_at,
    -- coalesce を挟むのは、未サインインだと比較が null になり
    -- 「自分かどうか不明」という3つ目の状態が画面へ届いてしまうため
    'is_self',      coalesce((select auth.uid()) = t.id, false),

    -- 画面がタブを出すかどうかを決めるための値。
    -- false の人のページには、お気に入りのタブも件数も現れない
    'show_answer_stats',   t.show_answer_stats,
    'show_answer_history', t.show_answer_history,
    'show_saved_works',    t.show_saved_works,

    'creator', jsonb_build_object(
      'works_count',   (select count(*) from pub),
      'answers_count', (select coalesce(sum(pb.answers_count), 0) from pub pb),
      'likes_received', (
        select count(*)
          from public.likes l
          join pub pb on pb.id = l.work_id
         where l.user_id <> t.id
      ),
      'total_actual_seconds', (
        select coalesce(sum(pb.actual_time_seconds), 0) from pub pb
      ),
      'accuracy', (
        select sum(st.corrects)::numeric / nullif(sum(st.attempts), 0)
          from public.work_slot_stats st
          join eligible e on e.id = st.work_id
      ),
      'slot_stats', coalesce((
        select jsonb_agg(x.obj order by x.priority nulls last)
          from (
            select cs.quiz_priority as priority,
                   jsonb_build_object(
                     'card_slot_key', cs.card_slot_key,
                     'label',         cs.label,
                     'attempts',      sum(st.attempts),
                     'corrects',      sum(st.corrects)
                   ) as obj
              from public.work_slot_stats st
              join eligible e on e.id = st.work_id
              join public.card_slots cs on cs.card_slot_key = st.card_slot_key
             group by cs.card_slot_key, cs.label, cs.quiz_priority
          ) x
      ), '[]'::jsonb)
    ),

    -- 回答者としての記録は show_answer_stats に従う（本人は常に見える）
    'answer_stats', case
      when t.show_answer_stats or (select auth.uid()) = t.id then (
        select jsonb_build_object(
          'total_answers',       us.total_answers,
          'total_items',         us.total_items,
          'total_correct_items', us.total_correct_items,
          'slot_stats', coalesce((
            select jsonb_agg(y.obj order by y.priority nulls last)
              from (
                select cs.quiz_priority as priority,
                       jsonb_build_object(
                         'card_slot_key', cs.card_slot_key,
                         'label',         cs.label,
                         'attempts',      uss.attempts,
                         'corrects',      uss.corrects
                       ) as obj
                  from public.user_slot_stats uss
                  join public.card_slots cs on cs.card_slot_key = uss.card_slot_key
                 where uss.user_id = t.id
              ) y
          ), '[]'::jsonb)
        )
        from public.user_stats us
        where us.user_id = t.id
      )
    end
  )
  from target t;
$$;

comment on function public.get_public_profile(text) is
  '公開プロフィール1件。見つからなければ null（非公開と不在を区別しない）。'
  '描き手の記録は常に公開、回答者の記録は show_answer_stats に従う。';

revoke all on function public.get_public_profile(text)
  from public, anon, authenticated;

grant execute on function public.get_public_profile(text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_user_works ／ その人の公開作品
-- ----------------------------------------------------------------------------
--
-- 返す列は get_public_works と同じにしてある。画面のカードをそのまま
-- 使い回せるようにするため（型が違うと、同じ見た目を2回書くことになる）。
--
-- p_division の意味も get_public_works に合わせる（D51）。
--   null 通常（AI以外）／ original ／ fanart ／ ai ／ all
-- ポートフォリオでは AI を独立したタブにする（spec 12-0）ので、
-- 画面からは必ず値を明示して呼ぶ。

create function public.get_user_works(
  p_user_id  uuid,
  p_division text default null,
  p_sort     text default 'new',
  p_limit    int  default 24,
  p_offset   int  default 0
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
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
  author_display_name text
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
    pr.display_name
  from public.works w
    join public.prompts  p  on p.id  = w.prompt_id
    join public.profiles pr on pr.id = w.user_id
  where w.user_id = p_user_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and case
          when p_division is null  then w.division <> 'ai'
          when p_division = 'all'  then true
          else w.division = p_division
        end
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_user_works(uuid, text, text, int, int) is
  'その人の公開作品一覧。列は get_public_works と同じ。prompt_id は返さない（D23）。';

revoke all on function public.get_user_works(uuid, text, text, int, int)
  from public, anon, authenticated;

grant execute on function public.get_user_works(uuid, text, text, int, int)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. get_saved_works ／ お気に入り一覧
-- ----------------------------------------------------------------------------
--
-- 本人用と他人用を1本で兼ねる。分けると「どちらの条件で絞ったか」が
-- 呼び出し側の選択に委ねられ、間違えたときに他人の非公開作品が出る。
-- **誰が見ているかは関数の中で決める。**
--
-- 【いいねを一切読まない】
--   お気に入りといいねは別の機能として扱う（spec 12-1）。
--   この関数は likes に触れず、いいね件数も返さない。
--   逆に get_rankings は saves に触れない。
--
-- 【返す状態（work_status）】
--   public   公開中
--   private  作者が非公開にした
--   review   審査中・非表示
--   deleted  作者が削除した
--
--   **他人向けには public しか返らない**（where で落としている）。
--   本人向けにだけ、保存したものが消えた理由が分かるように出す。
--
-- 【お題の答え（prompt_answer）】
--   閲覧者がその作品へ回答済みのときだけ入る。それ以外は null。
--   条件は get_my_answer と同じなので、この関数は
--   **閲覧者がすでに知っていること以上を返さない**。

create function public.get_saved_works(
  p_user_id uuid,
  p_limit   int default 24,
  p_offset  int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  source_title        text,
  saved_at            timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text,
  work_status         text,
  answered_by_viewer  boolean,
  prompt_answer       jsonb
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
    w.source_title,
    sv.created_at,
    pr.id,
    pr.handle,
    pr.display_name,
    case
      when w.deleted_at is not null   then 'deleted'
      when not w.is_published         then 'private'
      when w.review_status <> 'ok'    then 'review'
      else 'public'
    end,
    exists (
      select 1 from public.answers a
       where a.work_id = w.id
         and a.user_id = (select auth.uid())
    ),
    case when exists (
      select 1 from public.answers a
       where a.work_id = w.id
         and a.user_id = (select auth.uid())
    ) then (
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key', pc.card_slot_key,
                 'slot_label',    cs.label,
                 'tag_label',     tg.label
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
       where pc.prompt_id = w.prompt_id
    ) end
  from public.saves sv
    join public.works    w  on w.id  = sv.work_id
    join public.profiles pr on pr.id = w.user_id
  where sv.user_id = p_user_id
    -- 本人なら常に。他人なら、その人が公開を許可しているときだけ
    and (
      p_user_id = (select auth.uid())
      or exists (
        select 1 from public.profiles o
         where o.id = p_user_id
           and o.is_anonymous = false
           and o.handle is not null
           and o.show_saved_works
      )
    )
    -- 他人には公開中の作品だけ。本人には状態つきで全部
    and (
      p_user_id = (select auth.uid())
      or (w.is_published and w.review_status = 'ok' and w.deleted_at is null)
    )
  order by sv.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_saved_works(uuid, int, int) is
  'お気に入り一覧。本人は常に全部（状態つき）、他人は show_saved_works が true のときだけ公開作品。'
  'お題の答えは閲覧者が回答済みのときだけ返す。likes には触れない。';

revoke all on function public.get_saved_works(uuid, int, int)
  from public, anon, authenticated;

grant execute on function public.get_saved_works(uuid, int, int)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. get_public_answers ／ 回答履歴
-- ----------------------------------------------------------------------------
--
-- 返すのは「作品・日時・正答数」だけ（spec 12-0）。
-- **選んだタグは返さない。** selected_tag_id と is_correct を突き合わせると
-- 正解が割れるため、answer_items は他人へ一切出さない（spec 8-4）。
--
-- show_answer_history が false なら0件。本人は常に見える。

create function public.get_public_answers(
  p_user_id uuid,
  p_limit   int default 24,
  p_offset  int default 0
)
returns table (
  work_id             uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  correct_count       int,
  item_count          int,
  answered_at         timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
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
    a.correct_count,
    (select count(*)::int from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.answers a
    join public.works    w  on w.id  = a.work_id
    join public.profiles pr on pr.id = w.user_id
  where a.user_id = p_user_id
    and (
      p_user_id = (select auth.uid())
      or exists (
        select 1 from public.profiles o
         where o.id = p_user_id
           and o.is_anonymous = false
           and o.handle is not null
           and o.show_answer_history
      )
    )
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
  order by a.created_at desc, w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_answers(uuid, int, int) is
  '回答履歴。作品・日時・正答数だけを返し、選んだタグは返さない。'
  'show_answer_history が false なら0件（本人は常に見える）。';

revoke all on function public.get_public_answers(uuid, int, int)
  from public, anon, authenticated;

grant execute on function public.get_public_answers(uuid, int, int)
  to anon, authenticated;
