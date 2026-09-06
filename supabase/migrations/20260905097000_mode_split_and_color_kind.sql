-- ============================================================================
-- 方式別の集計を最後まで通す ／ カラーを状態から切り離したことの検算
-- ============================================================================
--
-- 【なぜこのファイルが要るか】
--
--   1. ビタ当てと2択当てを混ぜた割合が、まだ4か所に残っていた。
--      D165 の 4 と 11-2 は「回答方式そのものを必ず区別して保存・集計する」
--      「重みを付けて1つの伝達率にまとめない」と決めている。
--      20260905095000 は回答の保存と作者向けの結果までは分けたが、
--      次の4つは分けないままだった。
--
--        get_work_detail   の slot_stats（誰でも見える項目別の伝達率）
--        get_my_work       の slot_stats（自分の作品の項目別）
--        get_public_profile の creator.accuracy と両方の slot_stats
--        get_rankings      の accuracy（伝達率ランキング）
--
--      いずれも corrects ÷ attempts で、2択当ての的中がビタ当ての的中と
--      同じ重みで混ざっていた。**混ぜた割合を1つ出すことは 11-2 が禁じている。**
--
--   2. user_slot_stats に方式別の列が無かった。
--      work_slot_stats と user_stats には 20260905095000 が足したが、
--      回答者×枠の表だけ漏れていた。プロフィールの「枠別正答率」がここを読む。
--
--   3. カラーが状態カテゴリから外れたことを、DBの側で検算する。
--      状態カテゴリは8つ、カラーは1つ、モーフは1つ。
--      数が合わなければこの migration が止まる。
--
-- 【伝達率ランキングの分母をビタ当てだけにした理由】
--   混ぜないと決めた以上、1つの順位に使える割合は1方式ぶんしかない。
--   ビタ当てを採るのは、**2026-09-05 より前の回答がすべてビタ当てだから。**
--   （20260905095000 が exact_attempts に旧 attempts を写している。）
--   2択当てを採ると、過去の作品の割合が全部 null になって比較できない。
--
--   なお伝達率ランキングは画面から選べない（D112 で外した）。
--   ここで直すのは、選べないまま値が混ざっているのを放置しないため。
--
--   **これは私が選んだ扱いで、ユーザーの承認を受けた決定ではない。**
--   docs/decisions.md の D165 の 12 に未確定として立ててある。
--
-- 【この migration が変えないもの】
--   ・answers.correct_count（その人が正解へ到達した問の数）。割合ではない
--   ・work_slot_stats.attempts / corrects（方式を問わない合計。素の数）
--   ・出題・採点・権限のいずれも変えない
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. カラーが状態から外れていることを検算する
-- ----------------------------------------------------------------------------
--
-- 20260904090000 が kind に 'color' を許し、20260905095000 が
-- カラーを kind = 'color' で入れている。ここでは数だけ確かめる。

do $$
declare
  v_morph int;
  v_state int;
  v_color int;
begin
  select count(*) filter (where kind = 'morph'),
         count(*) filter (where kind = 'state'),
         count(*) filter (where kind = 'color')
    into v_morph, v_state, v_color
    from public.draw_categories
   where is_active;

  if v_morph <> 1 or v_state <> 8 or v_color <> 1 then
    raise exception
      'CATEGORY_KIND_MISMATCH: モーフ % / 状態 % / カラー %'
      '（正しくは モーフ1・状態8・カラー1）。'
      'カラーを状態カテゴリに入れると状態が9つになる。',
      v_morph, v_state, v_color;
  end if;

  if not exists (
    select 1 from public.draw_categories
     where category_key = 'color' and kind = 'color' and max_per_prompt = 1
  ) then
    raise exception
      'COLOR_CATEGORY_WRONG: カラーは kind = ''color'' ／ max_per_prompt = 1 で'
      '入っていなければなりません（D165 の 11-1 / 11-3）。';
  end if;

  raise notice '検算 OK: モーフ1 / 状態8 / カラー1（カラーは状態に含めない）';
end $$;


-- ----------------------------------------------------------------------------
-- 2. user_slot_stats にも方式別の列を足す
-- ----------------------------------------------------------------------------

alter table public.user_slot_stats
  add column if not exists exact_attempts int not null default 0;
alter table public.user_slot_stats
  add column if not exists exact_corrects int not null default 0;
alter table public.user_slot_stats
  add column if not exists pair_attempts int not null default 0;
alter table public.user_slot_stats
  add column if not exists pair_corrects int not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.user_slot_stats'::regclass
                    and conname = 'user_slot_stats_exact_range') then
    alter table public.user_slot_stats
      add constraint user_slot_stats_exact_range
      check (exact_corrects between 0 and exact_attempts);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.user_slot_stats'::regclass
                    and conname = 'user_slot_stats_pair_range') then
    alter table public.user_slot_stats
      add constraint user_slot_stats_pair_range
      check (pair_corrects between 0 and pair_attempts);
  end if;
end $$;

-- 既存の行はすべてビタ当て（2択当てはまだ存在しなかった）
update public.user_slot_stats
   set exact_attempts = attempts,
       exact_corrects = corrects
 where exact_attempts = 0 and attempts > 0;

comment on column public.user_slot_stats.exact_attempts is
  'ビタ当て（1語で断定）で答えた回数。2択当てと混ぜない（D165 の 11-2）。';
comment on column public.user_slot_stats.pair_attempts is
  '2択当て（2語まで絞った）で答えた回数。ビタ当てと同じ割合にまとめない。';


-- ----------------------------------------------------------------------------
-- 3. 集計の引き金を差し替える（user_slot_stats も方式別に積む）
-- ----------------------------------------------------------------------------
--
-- 20260905095000 の版に、user_slot_stats の4列を足しただけ。
-- ほかの部分は同じ。

create or replace function public.answer_items_after_insert_stats()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_work_id uuid;
  v_user_id uuid;
  v_correct int := case when new.is_correct then 1 else 0 end;
  v_exact   int := case when new.answer_mode = 'exact' then 1 else 0 end;
  v_pair    int := case when new.answer_mode = 'pair'  then 1 else 0 end;
  v_exact_c int := case when new.answer_mode = 'exact' and new.is_correct then 1 else 0 end;
  v_pair_c  int := case when new.answer_mode = 'pair'  and new.is_correct then 1 else 0 end;
begin
  select a.work_id, a.user_id
    into v_work_id, v_user_id
    from public.answers a
   where a.id = new.answer_id;

  insert into public.work_slot_stats as st
    (work_id, card_slot_key, attempts, corrects,
     exact_attempts, exact_corrects, pair_attempts, pair_corrects, updated_at)
  values (v_work_id, new.card_slot_key, 1, v_correct,
          v_exact, v_exact_c, v_pair, v_pair_c, now())
  on conflict (work_id, card_slot_key) do update
    set attempts       = st.attempts + 1,
        corrects       = st.corrects + v_correct,
        exact_attempts = st.exact_attempts + v_exact,
        exact_corrects = st.exact_corrects + v_exact_c,
        pair_attempts  = st.pair_attempts + v_pair,
        pair_corrects  = st.pair_corrects + v_pair_c,
        updated_at     = now();

  if v_user_id is not null then
    insert into public.user_stats as us
      (user_id, total_items, total_correct_items,
       exact_items, exact_correct_items, pair_items, pair_correct_items, updated_at)
    values (v_user_id, 1, v_correct, v_exact, v_exact_c, v_pair, v_pair_c, now())
    on conflict (user_id) do update
      set total_items         = us.total_items + 1,
          total_correct_items = us.total_correct_items + v_correct,
          exact_items         = us.exact_items + v_exact,
          exact_correct_items = us.exact_correct_items + v_exact_c,
          pair_items          = us.pair_items + v_pair,
          pair_correct_items  = us.pair_correct_items + v_pair_c,
          updated_at          = now();

    insert into public.user_slot_stats as uss
      (user_id, card_slot_key, attempts, corrects,
       exact_attempts, exact_corrects, pair_attempts, pair_corrects, updated_at)
    values (v_user_id, new.card_slot_key, 1, v_correct,
            v_exact, v_exact_c, v_pair, v_pair_c, now())
    on conflict (user_id, card_slot_key) do update
      set attempts       = uss.attempts + 1,
          corrects       = uss.corrects + v_correct,
          exact_attempts = uss.exact_attempts + v_exact,
          exact_corrects = uss.exact_corrects + v_exact_c,
          pair_attempts  = uss.pair_attempts + v_pair,
          pair_corrects  = uss.pair_corrects + v_pair_c,
          updated_at     = now();
  end if;

  return null;
end;
$fn$;

comment on function public.answer_items_after_insert_stats() is
  '回答の内訳1件ぶんの集計。作品×枠・回答者・回答者×枠の3表すべてで、'
  '**ビタ当てと2択当てを別々の数として積む**（D165 の 11-2）。';

revoke all on function public.answer_items_after_insert_stats()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. get_work_detail ／ 項目別の伝達率を方式別に返す
-- ----------------------------------------------------------------------------
--
-- **本体は baseline の原文をそのまま写し、slot_stats の中身だけ足した。**
-- 混ぜた割合を画面で作れないように、方式別の4つを必ず一緒に返す。

create or replace function public.get_work_detail(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'was_rerolled',        p.was_rerolled,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'author', jsonb_build_object(
      'id',           pr.id,
      'handle',       pr.handle,
      'display_name', pr.display_name,
      'bio',          pr.bio,
      'links',        pr.links
    ),
    'is_author',   (select auth.uid()) = w.user_id,
    'liked_by_me', exists (
      select 1 from public.likes l
       where l.work_id = w.id and l.user_id = (select auth.uid())
    ),
    'saved_by_me', exists (
      select 1 from public.saves s
       where s.work_id = w.id and s.user_id = (select auth.uid())
    ),
    'answered_by_me', exists (
      select 1 from public.answers a
       where a.work_id = w.id and a.user_id = (select auth.uid())
    ),
    -- 枠別の伝達率。**方式別に分けて返す**（D165 の 11-2）。
    -- attempts / corrects は素の合計として残すが、画面はここから
    -- 1つの割合を作らない。
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects,
                 'exact_attempts',  st.exact_attempts,
                 'exact_corrects',  st.exact_corrects,
                 'pair_attempts',   st.pair_attempts,
                 'pair_corrects',   st.pair_corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.id = p_work_id
    and w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null;
$$;

comment on function public.get_work_detail(uuid) is
  '公開作品1件の詳細。prompt_id は返さない。非公開・削除済みには null を返す。'
  '枠別の伝達率はビタ当てと2択当てを分けて返す（D165 の 11-2）。';


-- ----------------------------------------------------------------------------
-- 5. get_my_work ／ 同じく方式別
-- ----------------------------------------------------------------------------

create or replace function public.get_my_work(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'id',                  w.id,
    'title',               w.title,
    'image_path',          w.image_path,
    'image_width',         w.image_width,
    'image_height',        w.image_height,
    'division',            w.division,
    'source_title',        w.source_title,
    'source_character',    w.source_character,
    'fanart_note',         w.fanart_note,
    'actual_time_seconds', w.actual_time_seconds,
    'time_limit_seconds',  p.time_limit_seconds,
    'mode_key',            p.mode_key,
    'is_published',        w.is_published,
    'review_status',       w.review_status,
    'deleted_at',          w.deleted_at,
    'likes_count',         w.likes_count,
    'saves_count',         w.saves_count,
    'answers_count',       w.answers_count,
    'created_at',          w.created_at,
    'can_edit_actual_time', (w.is_published = false),
    'slot_stats', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   st.card_slot_key,
                 'card_slot_label', cs.label,
                 'attempts',        st.attempts,
                 'corrects',        st.corrects,
                 'exact_attempts',  st.exact_attempts,
                 'exact_corrects',  st.exact_corrects,
                 'pair_attempts',   st.pair_attempts,
                 'pair_corrects',   st.pair_corrects
               )
               order by cs.quiz_priority nulls last, st.card_slot_key
             )
        from public.work_slot_stats st
        join public.card_slots cs on cs.card_slot_key = st.card_slot_key
       where st.work_id = w.id
    ), '[]'::jsonb)
  )
  from public.works w
  join public.prompts p on p.id = w.prompt_id
  where w.id = p_work_id
    and w.user_id = (select auth.uid());
$$;

comment on function public.get_my_work(uuid) is
  '自分の作品1件。他人のIDには null を返す（存在の有無を漏らさない）。'
  '枠別はビタ当てと2択当てを分けて返す（D165 の 11-2）。';


-- ----------------------------------------------------------------------------
-- 6. get_public_profile ／ 伝わりやすさと正答率を方式別にする
-- ----------------------------------------------------------------------------
--
-- **本体は 20260808160000 の原文をそのまま写し、数の出しかただけ変えた。**
--
--   creator.accuracy         → ビタ当てだけの割合（過去の回答と地続きになる）
--   creator.pair_accuracy    → 2択当てだけの割合（別の数として並べる）
--   creator.slot_stats       → 枠ごとに方式別の4つ
--   answer_stats             → 方式別の4つ ＋ 枠ごとの方式別
--
-- 混ぜた割合（corrects ÷ attempts）は**返さない。**
-- 返さなければ、画面がうっかり混ぜて表示することもできない。

create or replace function public.get_public_profile(p_handle text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with target as (
    select p.id, p.handle, p.display_name, p.bio, p.links, p.created_at,
           p.show_answer_stats, p.show_answer_history, p.show_saved_works,
           p.show_creator_stats
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
$$;

comment on function public.get_public_profile(text) is
  '公開プロフィール1件。見つからなければ null（非公開と不在を区別しない）。'
  'creator は show_creator_stats が false の他人には投稿数だけになる（D136）。'
  '伝わりやすさと正答率は、ビタ当てと2択当てを分けて返す（D165 の 11-2）。';

revoke all on function public.get_public_profile(text)
  from public, anon, authenticated;

grant execute on function public.get_public_profile(text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 7. get_rankings ／ 伝達率をビタ当てだけで出す
-- ----------------------------------------------------------------------------
--
-- **戻り値の列は1つも変わらない。**accuracy の中身の定義だけが変わる。
-- 混ぜた割合を順位に使うのをやめる（D165 の 11-2）。
--
-- 本体は 20260803204740 の原文をそのまま写し、accuracy の式だけ差し替えた。

create or replace function public.get_rankings(
  p_type       text default 'popular',
  p_feed       text default 'normal',
  p_time_limit text default null,
  p_limit      int  default 20,
  p_offset     int  default 0
)
returns table (
  rank                int,
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
  time_limit_bucket   text,
  likes_count         int,
  ranking_likes_count int,
  saves_count         int,
  answers_count       int,
  accuracy            numeric,
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
  with base as (
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
      case
        when p.time_limit_seconds is null then 'unlimited'
        when p.time_limit_seconds <= 900  then 'short'
        when p.time_limit_seconds <= 3599 then 'medium'
        else 'long'
      end as time_limit_bucket,
      w.likes_count,
      (select count(*)
         from public.likes l
        where l.work_id = w.id
          and l.user_id <> w.user_id)::int as ranking_likes_count,
      w.saves_count,
      w.answers_count,
      -- 伝達率。回答が5人に満たない作品は出さない（R6）。
      -- **ビタ当てだけで出す。**2択当ての的中を同じ重みで混ぜない（D165 の 11-2）。
      -- ビタ当てを採るのは、2026-09-05 より前の回答がすべてビタ当てとして
      -- 記録されているので、過去の作品と比較できるため。
      case when w.answers_count >= 5 then (
        select sum(st.exact_corrects)::numeric / nullif(sum(st.exact_attempts), 0)
          from public.work_slot_stats st
         where st.work_id = w.id
      ) end as accuracy,
      w.created_at,
      pr.id           as author_id,
      pr.handle       as author_handle,
      pr.display_name as author_display_name
    from public.works w
      join public.prompts  p  on p.id  = w.prompt_id
      join public.profiles pr on pr.id = w.user_id
    where w.is_published
      and w.review_status = 'ok'
      and w.deleted_at is null
      and case
            when p_feed = 'ai' then w.division =  'ai'
            else                    w.division <> 'ai'
          end
  )
  select
    (row_number() over (
       order by
         case when p_type = 'accuracy' then b.accuracy      end desc nulls last,
         case when p_type = 'accuracy' then b.answers_count end desc nulls last,
         b.ranking_likes_count desc,
         b.created_at          desc,
         b.id                  desc
     ))::int,
    b.id,
    b.title,
    b.image_path,
    b.image_width,
    b.image_height,
    b.division,
    b.source_title,
    b.source_character,
    b.fanart_note,
    b.actual_time_seconds,
    b.time_limit_bucket,
    b.likes_count,
    b.ranking_likes_count,
    b.saves_count,
    b.answers_count,
    b.accuracy,
    b.created_at,
    b.author_id,
    b.author_handle,
    b.author_display_name
  from base b
  where case
          when p_type = 'accuracy' then b.accuracy is not null
          when p_type = 'duration' then
            (p_time_limit is null or b.time_limit_bucket = p_time_limit)
          else true
        end
  order by 1
  limit  least(greatest(coalesce(p_limit, 20), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_rankings(text, text, text, int, int) is
  'ランキング。p_type: popular/accuracy/duration、p_feed: normal/ai。'
  '順位には作者本人のいいねを除いた ranking_likes_count を使う。'
  '伝達率は answers_count>=5 かつ**ビタ当てだけ**（D165 の 11-2）。'
  'お題のIDと正解は返さない（D23）。';


-- ----------------------------------------------------------------------------
-- 8. 語彙の棚卸しに「機械検査を通した時刻」を足す
-- ----------------------------------------------------------------------------
--
-- machine_checked_at は 20260905096000 が列として足したが、
-- 棚卸しの関数が返していなかったので、点検の資料に出てこなかった。
--
-- **承認（approved_by_user）と同じ欄にしない。**
-- 機械の検査を通したことと、内容が認められたことは別。

drop function if exists public.vocab_inventory();

create function public.vocab_inventory()
returns table (
  kind               text,
  id                 bigint,
  label              text,
  category_key       text,
  category_label     text,
  element_kind       text,
  reading            text,
  synonym_group      text,
  vocab_origin       text,
  reading_source     text,
  machine_checked_at timestamptz,
  approved_by_user   boolean,
  is_active          boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select 'tag'::text, t.id, t.label, t.pool_key, tp.label,
         coalesce(dc.kind, 'legacy'),
         t.reading, t.synonym_group, t.vocab_origin, t.reading_source,
         t.machine_checked_at, t.approved_by_user, t.is_active
    from public.tags t
    join public.tag_pools tp on tp.pool_key = t.pool_key
    left join public.draw_categories dc on dc.pool_key = t.pool_key
  union all
  select 'flavor'::text, v.id, v.label, v.kind, v.kind,
         'flavor'::text,
         v.reading, v.synonym_group, v.vocab_origin, v.reading_source,
         v.machine_checked_at, v.approved_by_user, v.is_active
    from public.flavor_vocab v
  order by 1, 4, 3;
$fn$;

comment on function public.vocab_inventory() is
  '語彙の棚卸し（点検用）。語・分類・上位種別・読み・同義グループ・出所・'
  '機械検査の時刻・承認の有無を返す。element_kind は morph / state / color /'
  'legacy / flavor。**カラーは state ではない。**一般利用者には配らない。';

revoke all on function public.vocab_inventory()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 9. 機械検査を通した時刻を1回だけ記録する
-- ----------------------------------------------------------------------------
--
-- `npm run check:vocab` が 2026-09-05 に全 564 語 × 全ヒント語の組を
-- 突き合わせて通った。その事実の時刻をここへ入れる。
--
-- **承認ではない。**approved_by_user は false のまま1行も触らない。

update public.tags
   set machine_checked_at = timestamptz '2026-09-05 00:00:00+00'
 where machine_checked_at is null;

update public.flavor_vocab
   set machine_checked_at = timestamptz '2026-09-05 00:00:00+00'
 where machine_checked_at is null;

do $$
declare
  v_approved int;
begin
  select (select count(*) from public.tags where approved_by_user)
       + (select count(*) from public.flavor_vocab where approved_by_user)
    into v_approved;

  if v_approved <> 0 then
    raise exception
      'VOCAB_APPROVAL_TOUCHED: approved_by_user が %件 true になっています。'
      '語彙の承認はユーザーが行うもので、migration で立てません。', v_approved;
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 10. 開示したお題のカードに、上位種別を持たせる
-- ----------------------------------------------------------------------------
--
-- 【なぜ要るか】
--   回答後の画面は「描く対象がいくつ／解釈の要求がいくつ」と数えて出す。
--   カードには category_key（morph / emotion / color …）しか入っていないので、
--   画面が「morph 以外はぜんぶ解釈の要求」と数えていた。
--   **その数え方だとカラーが状態に混ざる。**
--
--   数える手がかりを画面側で作らせない。DB が上位種別をそのまま渡す。
--
-- 本体は 20260904092000 の原文をそのまま写し、cards に1項目足しただけ。

create or replace function public.get_answered_prompt(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid  uuid := (select auth.uid());
  v_work record;
begin
  if v_uid is null then
    return null;
  end if;

  select w.id, w.prompt_id, w.user_id
    into v_work
    from public.works w
   where w.id = p_work_id
     and w.is_published
     and w.review_status = 'ok'
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  if v_work.user_id <> v_uid
     and not exists (
       select 1 from public.answers a
        where a.work_id = p_work_id and a.user_id = v_uid
     ) then
    return null;
  end if;

  return jsonb_build_object(
    'work_id', v_work.id,
    'is_author', v_work.user_id = v_uid,
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'category_key',    tg.pool_key,
                 'category_label',  tp.label,
                 -- morph / state / color。**カラーは state ではない**
                 'element_kind',    coalesce(dc.kind, 'legacy')
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
        join public.tag_pools  tp on tp.pool_key      = tg.pool_key
        left join public.draw_categories dc on dc.pool_key = tg.pool_key
       where pc.prompt_id = v_work.prompt_id
    ), '[]'::jsonb)
  );
end;
$fn$;

comment on function public.get_answered_prompt(uuid) is
  '回答済みの人と作者にだけ、正解のお題まるごとを返す（D162 の 4）。'
  'D165 以降はお題の全語が出題されるので、開示と出題の範囲は一致する。'
  '各カードは element_kind（morph / state / color）を持つ。'
  '**カラーは state ではない。**他人・未回答者・未サインインには null。'
  '返り値に prompt_id は含めない（D23）。';

revoke all on function public.get_answered_prompt(uuid)
  from public, anon, authenticated;
grant execute on function public.get_answered_prompt(uuid) to authenticated;
