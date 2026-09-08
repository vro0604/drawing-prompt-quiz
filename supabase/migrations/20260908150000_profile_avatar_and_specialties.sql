-- ============================================================================
-- 20260908150000_profile_avatar_and_specialties.sql
--   プロフィールの拡張（D176）
--     ・プロフィールアイコンを1枚持てるようにする
--     ・「描くのが得意」「見るのが得意」を、正式語彙から0〜5件ずつ登録できる
-- ============================================================================
--
-- 【なぜこれを足すか】
--   出所: ユーザー指示（2026-09-08）「この人が何を描く人で、何を見る人なのかが
--   分かるプロフィールへ拡張する」。いまのアカウント画面は
--   ID・表示名・自己紹介・外部リンク・公開設定・アカウント操作の設定画面で、
--   その人の作風が読み取れる欄が1つも無い。
--
-- 【得意分野は自己申告であって、成績ではない】
--   出所: ユーザー指示（2026-09-08）「今回の得意分野は完全な自己申告プロフィール
--   情報」「システムが自動的に『あなたは狐を見るのが得意です』等と認定しない」。
--   実際の正答率・ビタ当て率・投稿数・よく使うタグとは別物で、
--   **この表の値から成績を作らないし、成績からこの表を書かない。**
--
-- 【次の作品の配り方（D169）に使わない】
--   出所: ユーザー指示（2026-09-08）「『見るのが得意』をD169の次作品配給へ
--   使用しない」。使うと「一般の回答者にどう伝わったか」ではなく
--   「その表現を得意とする回答者にどう伝わったか」へ回答が偏る。
--   この migration は get_next_work / D169 の関数に一切触れない。
--
-- 【表を増やす／増やさないの判断】
--   得意分野は、固定列（draw_specialty_1 … ）にしない。
--   出所: ユーザー指示（2026-09-08）「固定列方式にはしない」「ユーザー × tag ×
--   specialty type の関連として正規化する」。
--   アイコンは1人1枚なので、profiles に列を1つ足すだけにする。
--
-- 【置き場所は既存のバケットを使う】
--   works バケットをそのまま使い、<利用者ID>/avatar/<乱数>.<拡張子> に置く。
--   新しいバケットを作らないのは、いまの works バケットに付いている守りが
--   そのまま効くため。実測（2026-09-08 の下調べ）:
--     ・書き込みのポリシー3本が「先頭のフォルダ名 = 自分の利用者ID」を見ている
--     ・読み取りは公開、受け付ける形式は png / jpeg / webp、上限 5MiB
--     ・退会の第1段階が「bucket='works' かつ <利用者ID>/ で始まる」を控えて消す
--   新しいバケットを作ると、この4つを全部書き直すことになる。
--
-- 逆にする手順（rollback）はファイルの末尾に置く。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. プロフィールアイコンの置き場所
-- ----------------------------------------------------------------------------
--
-- **URL ではなく置き場所（path）を持つ。**作品画像（works.image_path）と同じ。
-- URL を持つと、配信元が変わったときに過去の行が全部壊れる。

alter table public.profiles
  add column if not exists avatar_path text;

comment on column public.profiles.avatar_path is
  'プロフィールアイコンの置き場所。works バケットの <利用者ID>/avatar/<乱数>.<拡張子>。'
  '未設定なら null。**直接更新できない**（列権限を配らず、set_my_avatar だけが書く）。';

-- 形を DB 側でも縛る。画面や受け口の書き間違いで、
-- 他人のフォルダを指す値が入らないようにする。
alter table public.profiles drop constraint if exists profiles_avatar_path_format;
alter table public.profiles
  add constraint profiles_avatar_path_format check (
    avatar_path is null
    or (
      char_length(avatar_path) <= 200
      and avatar_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/avatar/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$'
    )
  );


-- ----------------------------------------------------------------------------
-- 2. 得意分野の表
-- ----------------------------------------------------------------------------
--
-- 主キーが (利用者, 種類, 語) なので、**同じ種類の中で同じ語を2回登録できない。**
-- 種類が違えば同じ語を登録できる（描く：狐／見る：狐 は許す。ユーザー指示 P5）。

create table if not exists public.profile_specialties (
  user_id        uuid        not null references public.profiles(id) on delete cascade,
  -- 'drawing' = 描くのが得意 / 'viewing' = 見るのが得意
  specialty_type text        not null,
  tag_id         bigint      not null references public.tags(id) on delete restrict,
  -- 並び順。本人が選んだ順に出す（1〜5）
  sort_order     int         not null default 1,
  created_at     timestamptz not null default now(),
  constraint profile_specialties_pkey primary key (user_id, specialty_type, tag_id),
  constraint profile_specialties_type_valid
    check (specialty_type in ('drawing', 'viewing')),
  constraint profile_specialties_sort_range
    check (sort_order between 1 and 5)
);

comment on table public.profile_specialties is
  '自己申告の得意分野（D176）。drawing=描くのが得意 / viewing=見るのが得意。'
  '**成績ではない。**実測の正答率とは無関係で、次の作品の配り方（D169）にも使わない。';

-- 遮断表にする。読み書きは security definer の RPC と service_role だけ。
-- **新しい表には Supabase が権限を配ることがある**ので、明示的に剥がす（D65）。
revoke all on table public.profile_specialties from public, anon, authenticated;
alter table public.profile_specialties enable row level security;


-- ----------------------------------------------------------------------------
-- 3. 5件の上限を、画面ではなく DB で保証する
-- ----------------------------------------------------------------------------
--
-- 出所: ユーザー指示（2026-09-08）「上限5件もUIだけでなくサーバー側で保証する」。
-- 受け口（set_my_specialties）でも数えるが、そこだけに置かない。
-- **数えている場所が1つだと、別の入口が増えた瞬間に上限が消える。**

create or replace function public.app_limit_profile_specialties()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.profile_specialties s
   where s.user_id = new.user_id
     and s.specialty_type = new.specialty_type;

  if v_n > 5 then
    raise exception 'SPECIALTY_LIMIT' using errcode = '23514';
  end if;

  return null;
end $$;

comment on function public.app_limit_profile_specialties() is
  '得意分野が1種類あたり5件を超えないことを、入った直後に数えて保証する。';

drop trigger if exists specialties_limit on public.profile_specialties;
create trigger specialties_limit
  after insert on public.profile_specialties
  for each row execute function public.app_limit_profile_specialties();

-- 退会処理中の書き込みを止める門番。既存の8表と同じものを付ける（D71）。
drop trigger if exists guard_account_active on public.profile_specialties;
create trigger guard_account_active
  before insert or update or delete on public.profile_specialties
  for each row execute function public.app_guard_account_active();


-- ----------------------------------------------------------------------------
-- 4. 得意分野を読む（内部用）
-- ----------------------------------------------------------------------------
--
-- 語の表示名と分類名を添えて返す。**外からは呼べない。**
-- 呼ぶのは、この下の get_my_specialties と get_public_profile だけ。

create or replace function public.app_specialty_rows(p_user_id uuid)
returns table (
  specialty_type text,
  sort_order     int,
  tag_id         bigint,
  label          text,
  category_key   text,
  category_label text
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.specialty_type, s.sort_order, t.id, t.label,
         dc.category_key, dc.label
    from public.profile_specialties s
    join public.tags t on t.id = s.tag_id
    left join public.draw_categories dc on dc.pool_key = t.pool_key
   where s.user_id = p_user_id
$$;

comment on function public.app_specialty_rows(uuid) is
  '得意分野の行を、語と分類の表示名つきで返す内部用。外へは配らない。';

revoke all on function public.app_specialty_rows(uuid) from public;
revoke all on function public.app_specialty_rows(uuid) from anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. 本人が自分の得意分野を読む
-- ----------------------------------------------------------------------------

create or replace function public.get_my_specialties()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'drawing', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tag_id', r.tag_id, 'label', r.label,
               'category_key', r.category_key, 'category_label', r.category_label)
             order by r.sort_order)
        from public.app_specialty_rows((select auth.uid())) r
       where r.specialty_type = 'drawing'), '[]'::jsonb),
    'viewing', coalesce((
      select jsonb_agg(jsonb_build_object(
               'tag_id', r.tag_id, 'label', r.label,
               'category_key', r.category_key, 'category_label', r.category_label)
             order by r.sort_order)
        from public.app_specialty_rows((select auth.uid())) r
       where r.specialty_type = 'viewing'), '[]'::jsonb)
  )
$$;

comment on function public.get_my_specialties() is
  '本人の得意分野。アカウント画面の初期値に使う。他人のものは返らない。';

revoke all on function public.get_my_specialties() from public;
grant execute on function public.get_my_specialties() to authenticated;


-- ----------------------------------------------------------------------------
-- 6. 得意分野を保存する
-- ----------------------------------------------------------------------------
--
-- 【まとめて置き換える】
--   1件ずつ足す・消すのではなく、渡された2つの並びで丸ごと置き換える。
--   画面のフォームが1つなので、途中で失敗して片方だけ変わる状態を作らない
--   （update_my_profile と同じ考え方）。
--
-- 【選べる語の範囲】
--   有効な語で、かつ**いまお題に出る分類**（draw_categories）に属するものだけ。
--   旧語彙（genre / motif / species）は選べない。持ち込み（art_first）で
--   選べる語と同じ範囲にしてある。

create or replace function public.set_my_specialties(
  p_drawing bigint[],
  p_viewing bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_d   bigint[] := coalesce(p_drawing, '{}'::bigint[]);
  v_v   bigint[] := coalesce(p_viewing, '{}'::bigint[]);
  v_bad int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- ゲストのプロフィールは他人から見えない。設定できても出ないので受けない
  -- （update_my_visibility と同じ理由）。
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  if array_length(v_d, 1) > 5 or array_length(v_v, 1) > 5 then
    raise exception 'SPECIALTY_LIMIT' using errcode = '23514';
  end if;

  -- 空の値が混ざっていたら、そこで断る。**「重複」として断らない。**
  -- 数え方（distinct）は null を数に入れないので、先に見ておかないと
  -- 「重複している」という別の理由で断ることになる（2026-09-08 の試験で実際に起きた）。
  if exists (select 1 from unnest(v_d || v_v) x where x is null) then
    raise exception 'SPECIALTY_TAG_INVALID' using errcode = '23503';
  end if;

  -- 同じ並びの中に同じ語が2回あるのを断る。
  -- **黙って1つにまとめない。**選んだ数と保存された数が食い違う。
  if (select count(distinct x) from unnest(v_d) x) <> coalesce(array_length(v_d, 1), 0)
     or (select count(distinct x) from unnest(v_v) x) <> coalesce(array_length(v_v, 1), 0) then
    raise exception 'SPECIALTY_DUPLICATE' using errcode = '23505';
  end if;

  -- 選べない語が混ざっていないか。無効な語・旧語彙・存在しない ID を断る。
  select count(*) into v_bad
    from unnest(v_d || v_v) as x(tag_id)
   where not exists (
     select 1 from public.tags t
       join public.draw_categories dc
         on dc.pool_key = t.pool_key and dc.is_active
      where t.id = x.tag_id and t.is_active
   );

  if v_bad > 0 then
    raise exception 'SPECIALTY_TAG_INVALID' using errcode = '23503';
  end if;

  delete from public.profile_specialties s where s.user_id = v_uid;

  insert into public.profile_specialties (user_id, specialty_type, tag_id, sort_order)
  select v_uid, 'drawing', x.tag_id, x.ord::int
    from unnest(v_d) with ordinality as x(tag_id, ord);

  insert into public.profile_specialties (user_id, specialty_type, tag_id, sort_order)
  select v_uid, 'viewing', x.tag_id, x.ord::int
    from unnest(v_v) with ordinality as x(tag_id, ord);

  return public.get_my_specialties();
end $$;

comment on function public.set_my_specialties(bigint[], bigint[]) is
  '自己申告の得意分野を、描く側・見る側それぞれ0〜5件で置き換える。'
  '**成績とは無関係。**登録ユーザーだけが呼べる。';

revoke all on function public.set_my_specialties(bigint[], bigint[]) from public;
grant execute on function public.set_my_specialties(bigint[], bigint[]) to authenticated;


-- ----------------------------------------------------------------------------
-- 7. アイコンの置き場所を保存する
-- ----------------------------------------------------------------------------
--
-- ファイルそのものは画面側が Storage へ置く（作品画像と同じ）。
-- ここが受けるのは「どこへ置いたか」だけ。
-- **他人のフォルダを指す値を受け取らない。**先頭が自分の利用者IDであることを見る。

create or replace function public.set_my_avatar(p_path text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_old text;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  if p_path is not null
     and p_path not like v_uid::text || '/avatar/%' then
    raise exception 'AVATAR_PATH_FOREIGN' using errcode = '42501';
  end if;

  select p.avatar_path into v_old from public.profiles p where p.id = v_uid;

  update public.profiles p
     set avatar_path = p_path
   where p.id = v_uid;

  -- 前の画像の置き場所も返す。呼び出し側がそれを消す（消し残しを作らない）。
  return jsonb_build_object('avatar_path', p_path, 'previous_path', v_old);
end $$;

comment on function public.set_my_avatar(text) is
  'プロフィールアイコンの置き場所を設定する。null を渡すと外す。'
  '**戻り値に前の置き場所を入れる**ので、呼び出し側はそれを Storage から消せる。';

revoke all on function public.set_my_avatar(text) from public;
grant execute on function public.set_my_avatar(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 7-b. 消しそこねたアイコンを、掃除の待ち行列へ入れる
-- ----------------------------------------------------------------------------
--
-- 【なぜ要るか】
--   Storage（画像の置き場）と DB は別の仕組みなので、まとめて巻き戻せない。
--   差し替えや取り外しのときに、DB は書けたのに古いファイルだけ消せない、
--   ということが起こりうる。そのファイルは誰からも辿れないのに残り続ける。
--
--   放っておくと、失敗のたびに増える。既に「消し残しを拾って消す」仕組みが
--   あるので（storage_cleanup_queue と Step 16 の掃除）、そこへ渡す。
--
-- 【受け取る範囲】
--   自分のフォルダのアイコンだけ。他人のファイルを掃除の対象にできない。

create or replace function public.enqueue_my_avatar_cleanup(p_path text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  if p_path is null or p_path not like v_uid::text || '/avatar/%' then
    raise exception 'AVATAR_PATH_FOREIGN' using errcode = '42501';
  end if;

  insert into public.storage_cleanup_queue (bucket, path)
  values ('works', p_path)
  on conflict (bucket, path) do nothing;
end $$;

comment on function public.enqueue_my_avatar_cleanup(text) is
  '消せなかった自分のアイコンを、掃除の待ち行列へ入れる。'
  '**孤児になったファイルを、増えっぱなしにしないための出口。**';

revoke all on function public.enqueue_my_avatar_cleanup(text) from public;
grant execute on function public.enqueue_my_avatar_cleanup(text) to authenticated;


-- ----------------------------------------------------------------------------
-- 8. 公開プロフィールに、アイコンと得意分野を足す
-- ----------------------------------------------------------------------------
--
-- 引数も戻り値の型も変えない。**鍵を2つ増やすだけ。**
-- 既存の鍵は1つも消していないので、古い画面が壊れることはない。

CREATE OR REPLACE FUNCTION public.get_public_profile(p_handle text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with target as (
    select p.id, p.handle, p.display_name, p.bio, p.links, p.created_at,
           p.show_answer_stats, p.show_answer_history, p.show_saved_works,
           p.show_creator_stats, p.avatar_path
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
  ),
  creator_totals as (
    -- 方式別の合計を**1回の走査で**出す。
    -- 割合ごとに別々の副問い合わせを書くと、同じ表を4回走査することになり、
    -- 集計が育つほど遅くなる（実測: 5周目のスモークで profile が数分かかった）。
    select coalesce(sum(st.exact_attempts), 0)::int as exact_attempts,
           coalesce(sum(st.exact_corrects), 0)::int as exact_corrects,
           coalesce(sum(st.pair_attempts),  0)::int as pair_attempts,
           coalesce(sum(st.pair_corrects),  0)::int as pair_corrects
      from public.work_slot_stats st
      join eligible e on e.id = st.work_id
  )
  select jsonb_build_object(
    'id',           t.id,
    'handle',       t.handle,
    'display_name', t.display_name,
    'bio',          t.bio,
    'links',        t.links,
    'created_at',   t.created_at,
    -- プロフィールアイコンの置き場所（2026-09-08）。未設定なら null。
    -- **URL ではなく置き場所を返す。**組み立ては画面側が行う（作品画像と同じ）。
    'avatar_path',  t.avatar_path,
    -- 自己申告の得意分野（2026-09-08）。0件なら空の配列。
    -- **実測の成績ではない。**本人が選んだ語をそのまま返す。
    'specialties', (
      select jsonb_build_object(
        'drawing', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'tag_id', sp.tag_id, 'label', sp.label,
                   'category_key', sp.category_key, 'category_label', sp.category_label)
                 order by sp.sort_order)
            from public.app_specialty_rows(t.id) sp
           where sp.specialty_type = 'drawing'), '[]'::jsonb),
        'viewing', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'tag_id', sp.tag_id, 'label', sp.label,
                   'category_key', sp.category_key, 'category_label', sp.category_label)
                 order by sp.sort_order)
            from public.app_specialty_rows(t.id) sp
           where sp.specialty_type = 'viewing'), '[]'::jsonb)
      )
    ),
    'is_self',      coalesce((select auth.uid()) = t.id, false),

    'show_answer_stats',   t.show_answer_stats,
    'show_answer_history', t.show_answer_history,
    'show_saved_works',    t.show_saved_works,
    'show_creator_stats',  t.show_creator_stats,

    'creator', public.mask_creator_stats(jsonb_build_object(
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
      -- **ビタ当てだけの割合。**2択当てと混ぜない（D165 の 11-2）
      'accuracy',
        (select ct.exact_corrects::numeric / nullif(ct.exact_attempts, 0) from creator_totals ct),
      'exact_attempts', (select ct.exact_attempts from creator_totals ct),
      'pair_accuracy',
        (select ct.pair_corrects::numeric / nullif(ct.pair_attempts, 0) from creator_totals ct),
      'pair_attempts', (select ct.pair_attempts from creator_totals ct),
      'slot_stats', coalesce((
        select jsonb_agg(x.obj order by x.priority nulls last)
          from (
            select cs.quiz_priority as priority,
                   jsonb_build_object(
                     'card_slot_key',  cs.card_slot_key,
                     'label',          cs.label,
                     'attempts',       sum(st.attempts),
                     'corrects',       sum(st.corrects),
                     'exact_attempts', sum(st.exact_attempts),
                     'exact_corrects', sum(st.exact_corrects),
                     'pair_attempts',  sum(st.pair_attempts),
                     'pair_corrects',  sum(st.pair_corrects)
                   ) as obj
              from public.work_slot_stats st
              join eligible e on e.id = st.work_id
              join public.card_slots cs on cs.card_slot_key = st.card_slot_key
             group by cs.card_slot_key, cs.label, cs.quiz_priority
          ) x
      ), '[]'::jsonb)
    ), t.show_creator_stats, t.id = (select auth.uid())),

    'answer_stats', case
      when t.show_answer_stats or (select auth.uid()) = t.id then (
        select jsonb_build_object(
          'total_answers',       us.total_answers,
          'total_items',         us.total_items,
          'total_correct_items', us.total_correct_items,
          -- 方式別。画面はここから1つの正答率を作らない
          'exact_items',         us.exact_items,
          'exact_correct_items', us.exact_correct_items,
          'pair_items',          us.pair_items,
          'pair_correct_items',  us.pair_correct_items,
          'slot_stats', coalesce((
            select jsonb_agg(y.obj order by y.priority nulls last)
              from (
                select cs.quiz_priority as priority,
                       jsonb_build_object(
                         'card_slot_key',  cs.card_slot_key,
                         'label',          cs.label,
                         'attempts',       uss.attempts,
                         'corrects',       uss.corrects,
                         'exact_attempts', uss.exact_attempts,
                         'exact_corrects', uss.exact_corrects,
                         'pair_attempts',  uss.pair_attempts,
                         'pair_corrects',  uss.pair_corrects
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
$function$
;


-- ----------------------------------------------------------------------------
-- 9. 退会のときに、アイコンも消す対象へ入れる
-- ----------------------------------------------------------------------------
--
-- 変えたのは3か所だけ（アイコンの控え・得意分野の削除・avatar_path を空にする）。
-- 他の手順は1行も変えていない。

CREATE OR REPLACE FUNCTION public.start_account_deletion(p_confirm text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid     uuid := (select auth.uid());
  v_status  text;
  v_expected text;
  v_objects jsonb;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  -- ゲストは退会の対象にしない。メールもプロフィールも持たず、
  -- 30日で掃除される（Step 16）。
  if coalesce(((select auth.jwt()) ->> 'is_anonymous')::boolean, true) then
    raise exception 'ANONYMOUS_NOT_ALLOWED' using errcode = '42501';
  end if;

  select p.account_status, coalesce(p.handle, p.display_name)
    into v_status, v_expected
    from public.profiles p where p.id = v_uid;

  if v_status is null then
    raise exception 'NOT_SIGNED_IN' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'ALREADY_PENDING' using errcode = '42501';
  end if;

  -- 誤操作の防止。画面でも見るが、DB 側でも確かめる。
  if btrim(coalesce(p_confirm, '')) <> v_expected then
    raise exception 'CONFIRM_MISMATCH' using errcode = '22023';
  end if;

  -- ここから先は自分で書き込むので、門番を通す合図を立てる
  perform set_config('app.account_deletion', 'on', true);

  -- (1) 画像の場所を控える。**works.image_path を消す前に行う。**
  --     先に消すと、どのファイルを消せばよいか分からなくなる。
  insert into public.storage_cleanup_queue (bucket, path)
  select 'works', w.image_path
    from public.works w
   where w.user_id = v_uid and w.image_path is not null
  on conflict (bucket, path) do nothing;

  --     プロフィールアイコンも同じバケットに置いてある（2026-09-08）。
  --     置き場所は <利用者ID>/avatar/... なので、下の objects の
  --     絞り込み（bucket='works' かつ <利用者ID>/ で始まる）にそのまま入る。
  --     **(7) で avatar_path を消す前に控える。**
  insert into public.storage_cleanup_queue (bucket, path)
  select 'works', p.avatar_path
    from public.profiles p
   where p.id = v_uid and p.avatar_path is not null
  on conflict (bucket, path) do nothing;

  -- (2) 作品：即座に公開から外し、削除済みにし、持ち主と作者由来の情報を消す。
  --     **行は消さない。**消すと他人の回答と集計が道連れになる。
  update public.works w
     set is_published     = false,
         deleted_at       = coalesce(w.deleted_at, now()),
         user_id          = null,
         title            = null,
         image_path       = null,
         image_width      = null,
         image_height     = null,
         source_title     = null,
         source_character = null,
         fanart_note      = null
   where w.user_id = v_uid;

  -- (3) 他人の記録は残し、本人への線だけを切る
  update public.answers a set user_id     = null where a.user_id     = v_uid;
  update public.reports r set reporter_id = null where r.reporter_id = v_uid;
  update public.prompts p set created_by  = null where p.created_by  = v_uid;

  -- (4) 本人だけのものは消す
  delete from public.likes            where user_id = v_uid;
  delete from public.saves            where user_id = v_uid;
  delete from public.user_stats       where user_id = v_uid;
  delete from public.user_slot_stats  where user_id = v_uid;
  delete from public.draft_sessions   where user_id = v_uid;
  -- 自己申告の得意分野。本人のプロフィールにしか出ないので、本人と一緒に消す
  delete from public.profile_specialties where user_id = v_uid;

  -- (5) ID を押さえる。平文は残さず、鍵付きハッシュだけにする。
  insert into public.handle_reservations (handle_hash)
  select public.app_handle_hash(h.handle)
    from (
      select p.handle from public.profiles p
       where p.id = v_uid and p.handle is not null
      union
      select hh.handle from public.handle_history hh where hh.user_id = v_uid
    ) h
  on conflict (handle_hash) do nothing;

  delete from public.handle_history where user_id = v_uid;

  -- (6) 同意の記録は残すが、個人との結び付きを切る
  update public.terms_agreements t set user_id = null where t.user_id = v_uid;

  -- (7) プロフィールを空にし、退会処理中にする
  update public.profiles p
     set handle                = null,
         display_name          = '退会したユーザー',
         bio                   = null,
         links                 = '{}'::jsonb,
         avatar_path           = null,
         show_answer_stats     = false,
         show_answer_history   = false,
         show_saved_works      = false,
         account_status        = 'deletion_pending',
         deletion_requested_at = now()
   where p.id = v_uid;

  -- (8) 続きを行うための記録。auth.users を消せたら行ごと消す。
  insert into public.account_deletions (user_id) values (v_uid)
  on conflict (user_id) do nothing;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', q.id, 'bucket', q.bucket, 'path', q.path)), '[]'::jsonb)
    into v_objects
    from public.storage_cleanup_queue q
   where q.deleted_at is null
     and q.bucket = 'works'
     and q.path like v_uid::text || '/%';

  return jsonb_build_object('user_id', v_uid, 'objects', v_objects);
end $function$
;


-- ----------------------------------------------------------------------------
-- 10. 投入の検証
-- ----------------------------------------------------------------------------
--
-- ここで落ちれば、この migration ごと巻き戻る（1つのトランザクションで流すため）。

do $$
declare
  v_n int;
begin
  -- 列が足りているか
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'profiles'
       and column_name = 'avatar_path'
  ) then
    raise exception 'AVATAR_COLUMN_MISSING';
  end if;

  -- **アイコンの列に直接の更新権限を配っていないこと。**
  -- 配ってしまうと、他人のフォルダを指す値を誰でも入れられる。
  -- **null の attacl を aclexplode へ渡さない。**渡す前に行ごと落とす
  -- （docs/db-workflow.md の「空配列を渡さない」と同じ理由）。
  select count(*) into v_n
    from (
      select a.attacl
        from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'avatar_path'
       where c.relname = 'profiles'
         and c.relnamespace = 'public'::regnamespace
         and a.attacl is not null
    ) src
    cross join lateral aclexplode(src.attacl) x
   where x.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid);
  if v_n <> 0 then
    raise exception 'AVATAR_COLUMN_GRANTED: %', v_n;
  end if;

  -- 得意分野の表が遮断できているか
  select count(*) into v_n
    from (
      select c.relacl from pg_class c
       where c.relname = 'profile_specialties'
         and c.relnamespace = 'public'::regnamespace
         and c.relacl is not null
    ) src
    cross join lateral aclexplode(src.relacl) x
   where x.grantee in (0, 'anon'::regrole::oid, 'authenticated'::regrole::oid);
  if v_n <> 0 then
    raise exception 'SPECIALTIES_TABLE_GRANTED: %', v_n;
  end if;

  if not exists (
    select 1 from pg_class where relname = 'profile_specialties'
      and relnamespace = 'public'::regnamespace and relrowsecurity
  ) then
    raise exception 'SPECIALTIES_RLS_OFF';
  end if;

  -- 門番と上限のトリガーが付いているか
  select count(*) into v_n
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
   where c.relname = 'profile_specialties'
     and not t.tgisinternal
     and t.tgname in ('guard_account_active', 'specialties_limit');
  if v_n <> 2 then
    raise exception 'SPECIALTIES_TRIGGERS: %', v_n;
  end if;

  -- 関数が3本（＋内部用1本）あるか
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('get_my_specialties', 'set_my_specialties',
                       'set_my_avatar', 'app_specialty_rows',
                       'enqueue_my_avatar_cleanup');
  if v_n <> 5 then
    raise exception 'SPECIALTY_FUNCS: %', v_n;
  end if;

  -- 公開プロフィールが新しい鍵を返すか（存在しない handle でも形は返らないので、
  -- ここでは定義文に鍵の名前が入っていることだけを見る）
  if (select pg_get_functiondef(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'get_public_profile')
     not like '%avatar_path%' then
    raise exception 'PUBLIC_PROFILE_NO_AVATAR';
  end if;

  -- 退会がアイコンを控えるようになっているか
  if (select pg_get_functiondef(p.oid) from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'start_account_deletion')
     not like '%avatar_path%' then
    raise exception 'DELETION_NO_AVATAR';
  end if;

  raise notice 'プロフィール拡張 完了: 列・表・トリガー2本・関数5本・公開プロフィール・退会処理を確かめました';
end $$;


-- ============================================================================
-- 逆にする手順（rollback）
-- ============================================================================
--
-- この migration は既存の関数を2本作り替えている。戻すときは、
-- 20260908090000 までを当てた状態から get_public_profile と
-- start_account_deletion を作り直すこと。**下の drop だけでは戻らない。**
--
--   drop trigger if exists specialties_limit      on public.profile_specialties;
--   drop trigger if exists guard_account_active   on public.profile_specialties;
--   drop table if exists public.profile_specialties;
--   drop function if exists public.set_my_specialties(bigint[], bigint[]);
--   drop function if exists public.get_my_specialties();
--   drop function if exists public.set_my_avatar(text);
--   drop function if exists public.enqueue_my_avatar_cleanup(text);
--   drop function if exists public.app_specialty_rows(uuid);
--   drop function if exists public.app_limit_profile_specialties();
--   alter table public.profiles drop constraint if exists profiles_avatar_path_format;
--   alter table public.profiles drop column if exists avatar_path;
--
-- **アイコンの実体（Storage のファイル）は消えない。**
-- 消すなら storage_cleanup_queue へ入れてから掃除に回す。
