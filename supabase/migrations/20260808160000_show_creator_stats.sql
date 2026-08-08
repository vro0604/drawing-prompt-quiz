-- ============================================================================
-- 20260808160000_show_creator_stats.sql
--   M ／ 描き手としての成績も、公開するかどうかを選べるようにする（D113 / D136）
-- ============================================================================
--
-- 【直すもの】
--   いまの公開設定は非対称になっている。
--
--     回答者としての成績  → show_answer_stats で選べる（D11）
--     描き手としての成績  → **常時公開。選べない**（spec 12-0）
--
--   **この非対称は説明できない。**回答者の成績は隠せるのに描き手の成績は
--   隠せず、しかも**描き手の方が晒される痛みは大きい**はずである。
--
-- 【既定は false（D136）】
--   D11 が show_answer_stats を既定 false にしているので揃える。
--   初期は誰の記録も見えない状態になるが、それでよい。
--   **既定は、いちばん弱い立場に合わせる。**
--
-- 【対象（spec 12-0 の「描き手としての記録」）】
--   投稿数／獲得いいね／総制作時間／伝わりやすさ／スロット別正答率。
--
--   **works_count は隠さない。**作品グリッドが見えている以上、
--   数えれば分かる。数えれば分かるものを隠すと、
--   「隠している」という事実のほうが目立つ（spec 12-1 と同じ考えかた）。
--
-- 【本人には常に見せる】
--   自分の設定が切れていても、自分のページでは見える。
--   自分の持ち物は常に見られる、という既存のタブの扱いと揃える。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. profiles.show_creator_stats
-- ----------------------------------------------------------------------------

alter table public.profiles
  add column if not exists show_creator_stats boolean not null default false;

comment on column public.profiles.show_creator_stats is
  '描き手としての成績（獲得いいね／総制作時間／伝わりやすさ／枠別正答率）を'
  '他人に見せるか。既定 false。show_answer_stats と揃える（D113 / D136）。'
  '投稿数だけは対象外（作品グリッドから数えられるため）。';


-- ----------------------------------------------------------------------------
-- 2. 描き手の成績を伏せる関数
-- ----------------------------------------------------------------------------
--
-- **画面で捨てる形にしない。**捨てると、通信の中身には数字が乗ったまま残る。
-- spec 12-1 が「非公開のタブは件数も返さない」と決めているのと同じ理由。
--
-- **投稿数だけは残す。**作品グリッドが見えている以上、数えれば分かる。
-- 数えれば分かるものを伏せると、伏せている事実のほうが目立つ。

create or replace function public.mask_creator_stats(
  p_creator jsonb,
  p_show    boolean,
  p_is_self boolean
)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_show, false) or coalesce(p_is_self, false) then p_creator
    else jsonb_build_object(
      'works_count', p_creator -> 'works_count',
      'hidden',      true
    )
  end;
$$;

comment on function public.mask_creator_stats(jsonb, boolean, boolean) is
  '描き手の成績を、公開設定と本人かどうかで伏せる。'
  '投稿数だけ残すのは、作品グリッドから数えられるため（D113 / D136）。';

revoke all on function public.mask_creator_stats(jsonb, boolean, boolean)
  from public, anon, authenticated;

grant execute on function public.mask_creator_stats(jsonb, boolean, boolean)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. update_my_visibility に4つ目を足す
-- ----------------------------------------------------------------------------
--
-- **create or replace では足せない。**引数を1つ増やすと3引数版と4引数版が
-- 並び、既存の「3つを名前で渡す呼び出し」がどちらにも当てはまって
-- Postgres が「function is not unique」で断る。
--
-- **先に drop する。**同じトランザクションの中なので、
-- 途中で失敗すれば設定変更が壊れたまま残ることはない。

drop function if exists public.update_my_visibility(boolean, boolean, boolean);

create function public.update_my_visibility(
  p_show_answer_stats   boolean default null,
  p_show_answer_history boolean default null,
  p_show_saved_works    boolean default null,
  p_show_creator_stats  boolean default null
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
         show_saved_works    = coalesce(p_show_saved_works,    p.show_saved_works),
         show_creator_stats  = coalesce(p_show_creator_stats,  p.show_creator_stats)
   where p.id = v_uid;

  return (
    select jsonb_build_object(
      'show_answer_stats',   p.show_answer_stats,
      'show_answer_history', p.show_answer_history,
      'show_saved_works',    p.show_saved_works,
      'show_creator_stats',  p.show_creator_stats
    )
    from public.profiles p
    where p.id = v_uid
  );
end;
$fn$;

comment on function public.update_my_visibility(boolean, boolean, boolean, boolean) is
  '公開設定4つを更新する。null は「変更しない」。登録ユーザーのみ。';

revoke all on function public.update_my_visibility(boolean, boolean, boolean, boolean)
  from public, anon, authenticated;

grant execute on function public.update_my_visibility(boolean, boolean, boolean, boolean)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 3-b. get_public_profile に反映する
-- ----------------------------------------------------------------------------
--
-- **本体は 20260803210859 の原文から機械的に生成した。**手で書き写していない。
-- 変えたのは3か所だけ。
--   ・target CTE に show_creator_stats を足す
--   ・返す JSON に 'show_creator_stats' を足す
--   ・creator を mask_creator_stats で包む
--
-- 引数も戻り値も変わらないので create or replace でよい。

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
    ), t.show_creator_stats, t.id = (select auth.uid())),

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
  'creator は show_creator_stats が false の他人には投稿数だけになる（D136）。';

revoke all on function public.get_public_profile(text)
  from public, anon, authenticated;

grant execute on function public.get_public_profile(text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_profiles int;
  v_false    int;
begin
  select count(*) into v_profiles from public.profiles;
  select count(*) into v_false
    from public.profiles where show_creator_stats = false;

  if v_false <> v_profiles then
    raise exception
      'show_creator_stats の既定値が効いていません（全%件のうち false は%件）',
      v_profiles, v_false;
  end if;

  -- 伏せる側が本当に伏せること
  if (public.mask_creator_stats(
        jsonb_build_object('works_count', 3, 'likes_received', 99),
        false, false) ? 'likes_received') then
    raise exception 'mask_creator_stats が獲得いいねを伏せていません';
  end if;

  -- 本人には出ること
  if not (public.mask_creator_stats(
        jsonb_build_object('works_count', 3, 'likes_received', 99),
        false, true) ? 'likes_received') then
    raise exception 'mask_creator_stats が本人にも伏せています';
  end if;

  -- 投稿数は残ること
  if not (public.mask_creator_stats(
        jsonb_build_object('works_count', 3, 'likes_received', 99),
        false, false) ? 'works_count') then
    raise exception 'mask_creator_stats が投稿数まで消しています';
  end if;

  raise notice 'M 完了: プロフィール%件に show_creator_stats を入れました', v_profiles;
end $$;


-- ============================================================================
-- rollback（手で流す用）
-- ============================================================================
--
--   drop function if exists public.mask_creator_stats(jsonb, boolean, boolean);
--   alter table public.profiles drop column if exists show_creator_stats;
-- ============================================================================
