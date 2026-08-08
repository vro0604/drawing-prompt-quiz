-- ============================================================================
-- 20260808140000_work_completeness.sql
--   L ／ 完成度の軸（落書き / 線画 / 仕上げ）
-- ============================================================================
--
-- 【なぜ要るか】
--   いま **10分の落書きと数十時間の作品が、同じ棚に並ぶ。**
--   並ぶ場所が1つしかないと、「これを出したら見劣りする」が働いて、
--   気軽に出せなくなる。
--
--   調査 8-7 が言っているのはこれ。
--     「上手くないといけない」という恐怖が、描く喜びを殺している
--   そして取り戻し方も出ている。
--     「上手くなくてもいい」と認識すると、プレッシャーが完全になくなる
--
--   **完成度の軸は、その「上手くなくていい」を目に見える形にするもの。**
--   落書きの棚があれば、落書きは落書きとして出せる。
--
-- 【division とは別の列にする】
--   division は「オリジナル／ファンアート／AI」で、**何を描いたか**の区分。
--   完成度は**どこまで描いたか**。まったく別の軸なので、混ぜない。
--   混ぜると「オリジナルの落書き」が表現できなくなる。
--
-- 【3段にする理由（D135）】
--   2段（落書き / 仕上げ）だと
--   **「線画まで描いたが色は塗っていない」がどちらにも入らない。**
--   入れる場所が無いと、上に寄せて出しづらくなる。
--   出しづらさを消すための機能なので、そこで詰まっては意味がない。
--
-- 【既定値は 'finished'】
--   いま生きている作品は全部検査データで、本物は0件（D130）。
--   だから既定値が何であっても、既存の意味は壊れない。
--
--   そのうえで `finished` を選ぶ。**未指定は「ふつうに描いたもの」**と
--   読むのが自然で、`sketch` を既定にすると
--   「選ばなかった人の作品が全部落書き扱い」になってしまう。
--
-- 【戻しかた】
--   末尾に rollback を書いてある。列を落とすだけで、既存の読み書きは壊れない。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. works.completeness
-- ----------------------------------------------------------------------------

alter table public.works
  add column if not exists completeness text not null default 'finished';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.works'::regclass
       and conname  = 'works_completeness_check'
  ) then
    alter table public.works
      add constraint works_completeness_check
      check (completeness in ('sketch', 'lineart', 'finished'));
  end if;
end $$;

comment on column public.works.completeness is
  'どこまで描いたか。sketch=落書き / lineart=線画 / finished=仕上げ。'
  'division（何を描いたか）とは別の軸。'
  '「下手なまま出していい」を目に見える形にするための棚（D135）。';


-- ----------------------------------------------------------------------------
-- 2. 索引
-- ----------------------------------------------------------------------------
--
-- 一覧で絞り込むので、部門と同じ扱いにする。
-- 公開されている作品だけを見るので、そこまで含めた部分索引にする。

create index if not exists works_completeness_idx
  on public.works (completeness, created_at desc)
  where is_published and deleted_at is null;


-- ----------------------------------------------------------------------------
-- 3. create_work には触らない
-- ----------------------------------------------------------------------------
--
-- **最初は create_work に p_completeness を足そうとして、やめた。**
--
--   create or replace は引数の数を変えられないので、13引数版を足すことになる。
--   すると 12引数版と 13引数版が両方存在し、
--   **12個を名前付きで渡す呼び出しがどちらにも当てはまる。**
--   Postgres は「function is not unique」で断るか、
--   13引数版が自分自身を呼んで無限に回る。
--
--   避けるには 12引数版を drop して本体を書き写すことになるが、
--   **D27 の6検査・お題の持ち主確認・未選択カードの開示**を写すと、
--   片方だけ直る事故が起きる。写す価値がない。
--
-- **代わりに、作ったあとで update_work_completeness を呼ぶ。**
--   呼び出しが1回増えるだけで、失敗しても作品は既定の 'finished' で残る。
--   落書きが仕上げとして並ぶだけなので、**壊れかたが軽い。**

-- ----------------------------------------------------------------------------
-- 4. update_work で完成度を変えられるようにする
-- ----------------------------------------------------------------------------
--
-- 投稿したあとで「やっぱり線画だった」と直せるようにする。
-- **後から直せないと、迷ったときに上へ寄せる。**それでは棚を作った意味がない。

create or replace function public.update_work_completeness(
  p_work_id      uuid,
  p_completeness text
)
returns void
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

  if p_completeness not in ('sketch', 'lineart', 'finished') then
    raise exception 'INVALID_COMPLETENESS: 完成度の指定が正しくありません。';
  end if;

  update public.works w
     set completeness = p_completeness
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  -- 他人の作品・存在しないIDは、区別せず「見つからない」にする（D40）
  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;
end;
$fn$;

comment on function public.update_work_completeness(uuid, text) is
  '完成度だけを変える。本人のみ。後から直せないと、迷ったとき上へ寄せるため。';

revoke all on function public.update_work_completeness(uuid, text)
  from public, anon, authenticated;

grant execute on function public.update_work_completeness(uuid, text)
  to authenticated;


-- ----------------------------------------------------------------------------
-- 5. get_public_works に完成度を返させ、絞り込めるようにする
-- ----------------------------------------------------------------------------
--
-- **create or replace では置き換えられない。**
-- 返す列に completeness を足すので戻り値の形が変わり、
-- しかも引数を1つ増やすと**4引数版と5引数版が並んでしまう。**
-- そうなると既存の4引数の呼び出しがどちらにも当てはまり、
-- Postgres が「function is not unique」で断る。
--
-- **先に drop する。**同じトランザクションの中なので、
-- 途中で失敗すれば一覧が消えたまま残ることはない。

drop function if exists public.get_public_works(text, text, int, int);

create function public.get_public_works(
  p_division     text default null,
  p_sort         text default 'new',
  p_limit        int  default 24,
  p_offset       int  default 0,
  p_completeness text default null
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
    pr.display_name
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
    -- 知らない値が来たら0件になって終わる。部門と同じ扱い
    and (p_completeness is null or w.completeness = p_completeness)
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int, text) is
  '公開作品の一覧。prompt_id は返さない（D23）。'
  'p_division: null=通常（AI以外）／original／fanart／ai／all。'
  'p_completeness: null=すべて／sketch／lineart／finished。';

revoke all on function public.get_public_works(text, text, int, int, text)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int, text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------

do $$
declare
  v_works    int;
  v_finished int;
  v_bad      int;
begin
  select count(*) into v_works    from public.works;
  select count(*) into v_finished from public.works where completeness = 'finished';

  if v_finished <> v_works then
    raise exception
      'completeness の既定値が効いていません（全%件のうち finished は%件）',
      v_works, v_finished;
  end if;

  select count(*) into v_bad
    from public.works
   where completeness not in ('sketch', 'lineart', 'finished');

  if v_bad > 0 then
    raise exception 'completeness に決めた3つ以外の値が%件あります', v_bad;
  end if;

  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and indexname = 'works_completeness_idx'
  ) then
    raise exception '索引 works_completeness_idx がありません';
  end if;

  raise notice 'L 完了: 作品%件に completeness を入れました', v_works;
end $$;


-- ============================================================================
-- rollback（手で流す用）
-- ============================================================================
--
--   drop function if exists public.update_work_completeness(uuid, text);
--   drop function if exists public.get_public_works(text, text, int, int, text);
--   -- そのあと 20260803041246_feed_ai_separation.sql の4引数版を流し直す
--   drop index if exists public.works_completeness_idx;
--   alter table public.works drop constraint if exists works_completeness_check;
--   alter table public.works drop column if exists completeness;
-- ============================================================================
