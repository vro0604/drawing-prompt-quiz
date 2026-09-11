-- ============================================================================
-- 20260911090000_answer_source.sql
--   回答に「何が答えたか」を持たせ、人間の回答だけが統計を動かすようにする
-- ============================================================================
--
-- 【何のためか】
--   将来、新規利用者の最初の作品へ「システム回答」を付けたい（オンボーディング）。
--   そのとき、システムの回答が伝達率・順位・配給・成績を動かしてしまうと、
--   このサービスの数字の意味が崩れる。
--
--   だから**回答を保存する前に、区別する土台を先に作る。**
--   この migration が入っても、システム回答はまだ1件も作られない。
--   既存の挙動は1つも変わらない。
--
-- 【「誰が」ではなく「何が」】
--   足す列は、回答した人を指すものではない。**その回答が何によって
--   作られたか**を指す。人が答えたのか、仕組みが答えたのか。
--   出所: ユーザー指示（2026-09-10）「answersには、『誰が答えたか』ではなく
--   『何によって生成された回答か』を表す種別を持たせる。」
--
--   だから名前も actor ではなく source にしてある。
--   既にある answer_mode（ビタ当て／2択当て）の隣に並ぶ形。
--
-- 【いまは2種類だけ】
--   human と system。増やす余地は残すが、いまは増やさない。
--   出所: ユーザー指示（2026-09-10）「初期値は2種類だけ：human / system。
--   勝手に bot / tutorial 固有名へ狭めない。」
--
-- 【利用者はシステムを名乗れない】
--   回答を出す窓口（submit_answer）は、この列を引数に取らない。
--   列を書かずに insert するので、既定の human が必ず入る。
--   表そのものへの権限は anon にも authenticated にも0件（実測 2026-09-10）。
--   さらに、あとから種別を書き換えることも引き金で断る。
--
-- 【1作品につきシステム回答は1つまで】
--   既存の UNIQUE(work_id, user_id) は、user_id が null だと効かない
--   （Postgres は null 同士を重複と見なさない）。
--   システム回答の user_id を将来どう決めるかに関係なく効くよう、
--   種別で絞った索引を別に置く。
--
-- 【触っていないもの】
--   出所: ユーザー指示（2026-09-10）「以下へは触らない：draft_state_json /
--   draft_sessions / draft_session_slots / prompt_cards / shape_assist /
--   sub_directive / draw/redo系 / P0〜P5 migration / 別作業線のmigration」。
--   この migration はそのどれにも1文字も触れていない。
--   触るのは answers と、その集計と、配給の band 判定だけ。
--
-- 【版番号の選び方】
--   全作業木6つ・全ブランチ・本番の履歴を数えて、使われている最大は
--   20260910190000 だった（別作業線の未コミット分を含む。実測 2026-09-10）。
--   それより後ろから取ってある。

begin;

-- ── 1. 回答に種別を足す ──────────────────────────────────
--
-- 既存の670件はすべて human になる（既定値が入る）。
-- null を許さない。「分からない回答」を作らないため。

alter table public.answers
  add column if not exists answer_source text not null default 'human';

comment on column public.answers.answer_source is
  '回答の出所（D194）。human＝人が答えた／system＝仕組みが答えた。誰が答えたかではなく、何が答えたか。';

alter table public.answers
  drop constraint if exists answers_answer_source_valid;
alter table public.answers
  add constraint answers_answer_source_valid
  check (answer_source in ('human', 'system'));

-- 1作品につきシステム回答は1つまで。
-- **人間の側の UNIQUE(work_id, user_id) には触らない。**
drop index if exists public.answers_one_system_per_work;
create unique index answers_one_system_per_work
  on public.answers (work_id)
  where answer_source = 'system';

-- ── 2. 種別は後から書き換えられない ──────────────────────
--
-- 【なぜ引き金で止めるか】
--   利用者は表を直接触れない（権限0件）。だからこれは利用者向けの守りではなく、
--   **将来の自分たち向け**の守り。集計は insert のときに1回だけ数えるので、
--   あとから種別を変えると、数え直されないまま数字だけが食い違う。
--   出所: ユーザー指示（2026-09-10）「種別は実質immutableとして扱う方向。」

create or replace function public.answers_guard_source_immutable()
  returns trigger
  language plpgsql
  set search_path to ''
as $function$
begin
  if new.answer_source is distinct from old.answer_source then
    raise exception
      'ANSWER_SOURCE_IMMUTABLE: 回答の出所はあとから変えられません。';
  end if;
  return new;
end;
$function$;

drop trigger if exists answers_guard_source_immutable on public.answers;
create trigger answers_guard_source_immutable
  before update on public.answers
  for each row execute function public.answers_guard_source_immutable();

-- ── 3. 集計と配給を、人間の回答だけで数える ────────────────
--
-- ここから下は、本番の定義を機械的に取り出して、目印1か所へ
-- 差し込んだもの（scripts の gen 手順と同じやり方）。手で書き写していない。
--
--   answers_after_insert_stats            works.answers_count / user_stats
--   answers_after_insert_hint_stats       work_hint_stats
--   answer_items_after_insert_stats       work_slot_stats / user_stats / user_slot_stats
--   answer_items_after_insert_hint_stats  work_hint_stats
--   next_work_candidates                  D169 の band 判定
--   get_my_work_result                    作者へ返す集計
--   get_public_answers                    公開の回答履歴
--   get_my_answers / get_my_answer        自分の回答履歴
--
-- ランキング（get_rankings）は work_slot_stats を読むので、
-- 上流でシステムを外せば、あの関数に触れずに外れる。

CREATE OR REPLACE FUNCTION public.answers_after_insert_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- システム回答は通常の統計に入れない（D194）。
  -- **正式な回答ではない。**人間の回答だけが伝達率・順位・配給を動かす。
  if new.answer_source <> 'human' then
    return null;
  end if;

  update public.works w
     set answers_count = w.answers_count + 1
   where w.id = new.work_id;

  if new.user_id is not null then
    insert into public.user_stats as us (user_id, total_answers, updated_at)
    values (new.user_id, 1, now())
    on conflict (user_id) do update
      set total_answers = us.total_answers + 1,
          updated_at    = now();
  end if;

  return null;   -- after トリガーなので戻り値は使われない
end;
$function$;


CREATE OR REPLACE FUNCTION public.answers_after_insert_hint_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  -- システム回答は通常の統計に入れない（D194）。
  -- **正式な回答ではない。**人間の回答だけが伝達率・順位・配給を動かす。
  if new.answer_source <> 'human' then
    return null;
  end if;

  insert into public.work_hint_stats (work_id, hint_used, answers_count)
  values (new.work_id, new.hint_used, 1)
  on conflict (work_id, hint_used) do update
    set answers_count = work_hint_stats.answers_count + 1,
        updated_at    = clock_timestamp();
  return null;
end;
$function$;


CREATE OR REPLACE FUNCTION public.answer_items_after_insert_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_work_id uuid;
  v_user_id uuid;
  v_source  text;
  v_correct int := case when new.is_correct then 1 else 0 end;
  v_exact   int := case when new.answer_mode = 'exact' then 1 else 0 end;
  v_pair    int := case when new.answer_mode = 'pair'  then 1 else 0 end;
  v_exact_c int := case when new.answer_mode = 'exact' and new.is_correct then 1 else 0 end;
  v_pair_c  int := case when new.answer_mode = 'pair'  and new.is_correct then 1 else 0 end;
begin
  select a.work_id, a.user_id, a.answer_source
    into v_work_id, v_user_id, v_source
    from public.answers a
   where a.id = new.answer_id;

  -- システム回答は通常の統計に入れない（D194）
  if v_source <> 'human' then
    return null;
  end if;

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
$function$;


CREATE OR REPLACE FUNCTION public.answer_items_after_insert_hint_stats()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_work_id uuid;
  v_hint    boolean;
  v_source  text;
begin
  select a.work_id, a.hint_used, a.answer_source into v_work_id, v_hint, v_source
    from public.answers a where a.id = new.answer_id;

  -- システム回答は通常の統計に入れない（D194）
  if v_source <> 'human' then
    return null;
  end if;

  insert into public.work_hint_stats (work_id, hint_used, total_items, correct_items)
  values (v_work_id, v_hint, 1, case when new.is_correct then 1 else 0 end)
  on conflict (work_id, hint_used) do update
    set total_items   = work_hint_stats.total_items + 1,
        correct_items = work_hint_stats.correct_items
                        + case when new.is_correct then 1 else 0 end,
        updated_at    = clock_timestamp();
  return null;
end;
$function$;


CREATE OR REPLACE FUNCTION public.next_work_candidates(p_current_work_id uuid DEFAULT NULL::uuid)
 RETURNS TABLE(work_id uuid, band integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid      uuid := (select auth.uid());
  v_division text;
begin
  -- いま答えた作品の部門を、**その作品の行から**取る。
  -- クライアントは部門を渡せない（引数が無い）。
  if p_current_work_id is not null then
    select w.division
      into v_division
      from public.works w
     where w.id = p_current_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null;

    -- 非公開・審査未通過・削除済み・存在しないID。
    -- **どれも同じ「候補なし」で返す。**理由を分けると、
    -- そのIDの作品が在るのか無いのかを外から数えられてしまう（D40）。
    --
    -- 判定に FOUND を使う。行が無いとき select into は変数を NULL にするので、
    -- 「見つかったか」を自前の真偽値で持つと `not NULL` が真にならず、
    -- **素通りする**（実測: 存在しないIDで次の作品が返った）。
    if not found then
      return;
    end if;
  end if;

  return query
    select w.id,
           -- band は**人間の回答だけ**で決める（D194）。
           -- システム回答が付いただけの作品は、まだ誰にも読まれていない
           case when exists (select 1 from public.answers a
                              where a.work_id = w.id
                                and a.answer_source = 'human')
                then 2 else 1 end
      from public.works w
     where w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
       -- いま見ている作品そのものは出さない
       and (p_current_work_id is null or w.id <> p_current_work_id)
       -- 部門。**現在の作品と同じものだけ**（D169 の12）。
       -- 現在の作品が無いとき（直接呼ばれたとき）だけ、
       -- 一覧の既定と同じ「AI以外」に落とす。AI を常に除く条件は残さない。
       and (
         case
           when v_division is not null then w.division = v_division
           else w.division <> 'ai'
         end
       )
       -- 自分の作品には答えられない（D28）
       and (v_uid is null or w.user_id <> v_uid)
       -- すでに答えた作品は出さない
       and (v_uid is null
            or not exists (select 1 from public.answers a
                            where a.work_id = w.id and a.user_id = v_uid));
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_my_work_result(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid uuid := (select auth.uid());
  v_ok  boolean;
begin
  if v_uid is null then
    return null;
  end if;

  select true into v_ok
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    return null;
  end if;

  return (
    with ans as (
      select a.id, a.correct_count, a.question_count, a.scoring_version
        from public.answers a
       where a.work_id = p_work_id
         -- 人間の回答だけを数える（D194）。システム回答の見せ方は別に作る
         and a.answer_source = 'human'
    ),
    items as (
      select ai.card_slot_key, ai.selected_tag_id, ai.selected_tag_id_2,
             ai.is_correct, ai.answer_mode
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
    ),
    per_answer as (
      select ai.answer_id, count(*) as total, sum((ai.is_correct)::int) as corrects
        from public.answer_items ai
        join ans on ans.id = ai.answer_id
       group by ai.answer_id
    ),
    -- 誤答に選ばれた語。2択当ての2語目も数える（どちらも「そう読まれた」ため）
    picked as (
      select i.card_slot_key, i.selected_tag_id as tag_id from items i where not i.is_correct
      union all
      select i.card_slot_key, i.selected_tag_id_2 from items i
       where not i.is_correct and i.selected_tag_id_2 is not null
    )
    select jsonb_build_object(
      'answers_count', (select count(*) from ans),
      'blind_count', (
        select count(*) from per_answer pa where pa.corrects = 0
      ),

      -- **分母は実際に出題された問の数。**3で割らない（D165）
      'total_items',   (select count(*) from items),
      'correct_items', (select count(*) from items i where i.is_correct),

      -- 方式別。重みを付けて1つにまとめない（D165 の 11-2）
      'exact_items',   (select count(*) from items i where i.answer_mode = 'exact'),
      'exact_correct', (select count(*) from items i where i.answer_mode = 'exact' and i.is_correct),
      'pair_items',    (select count(*) from items i where i.answer_mode = 'pair'),
      'pair_correct',  (select count(*) from items i where i.answer_mode = 'pair' and i.is_correct),

      -- 枠ごとの方式別。「どの要素が断定で伝わり、どの要素は2つまでしか
      -- 絞られなかったか」を作者へ返す（D165 の 5 / 6）
      'slots', coalesce((
        select jsonb_agg(x.obj order by x.priority)
          from (
            select cs.quiz_priority as priority,
                   jsonb_build_object(
                     'card_slot_key',   i.card_slot_key,
                     'card_slot_label', cs.label,
                     'attempts',        count(*),
                     'corrects',        count(*) filter (where i.is_correct),
                     'exact_attempts',  count(*) filter (where i.answer_mode = 'exact'),
                     'exact_corrects',  count(*) filter (where i.answer_mode = 'exact' and i.is_correct),
                     'pair_attempts',   count(*) filter (where i.answer_mode = 'pair'),
                     'pair_corrects',   count(*) filter (where i.answer_mode = 'pair' and i.is_correct)
                   ) as obj
              from items i
              join public.card_slots cs on cs.card_slot_key = i.card_slot_key
             group by i.card_slot_key, cs.label, cs.quiz_priority
          ) x
      ), '[]'::jsonb),

      -- 旧方式の回答が混ざっているか。混ぜて平均を取らせないための印
      'legacy_answers', (
        select count(*) from ans where ans.scoring_version = 'v1_fixed_count'
      ),

      'misreads', coalesce((
        select jsonb_agg(x.obj order by x.n desc, x.label)
          from (
            select cs.label   as slot_label,
                   t.label    as label,
                   count(*)   as n,
                   jsonb_build_object(
                     'slot_label', cs.label,
                     'tag_label',  t.label,
                     'count',      count(*)
                   ) as obj
              from picked i
              join public.tags t        on t.id = i.tag_id
              join public.card_slots cs on cs.card_slot_key = i.card_slot_key
             group by cs.label, t.label
          ) x
      ), '[]'::jsonb)
    )
  );
end;
$function$;


CREATE OR REPLACE FUNCTION public.get_public_answers(p_user_id uuid, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS TABLE(work_id uuid, title text, image_path text, image_width integer, image_height integer, division text, correct_count integer, item_count integer, answered_at timestamp with time zone, author_id uuid, author_handle text, author_display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    and a.answer_source = 'human'   -- 人の回答履歴（D194）
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
$function$;


CREATE OR REPLACE FUNCTION public.get_my_answers(p_limit integer DEFAULT 24, p_offset integer DEFAULT 0)
 RETURNS TABLE(work_id uuid, work_title text, image_path text, correct_count integer, item_count bigint, answered_at timestamp with time zone, author_handle text, author_display_name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select
    w.id,
    w.title,
    w.image_path,
    a.correct_count,
    (select count(*) from public.answer_items ai where ai.answer_id = a.id),
    a.created_at,
    pr.handle,
    pr.display_name
  from public.answers a
  join public.works    w  on w.id  = a.work_id
  join public.profiles pr on pr.id = w.user_id
  where a.user_id = (select auth.uid())
    and a.answer_source = 'human'   -- 自分の回答履歴（D194）
  order by a.created_at desc, a.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$function$;


CREATE OR REPLACE FUNCTION public.get_my_answer(p_work_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'work_id',        w.id,
    'work_title',     w.title,
    'correct_count',  a.correct_count,
    'question_count', a.question_count,
    'exact_attempts', a.exact_attempts,
    'exact_corrects', a.exact_corrects,
    'pair_attempts',  a.pair_attempts,
    'pair_corrects',  a.pair_corrects,
    'scoring_version', a.scoring_version,
    'answered_at',    a.created_at,
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'question_id',       ai.question_id,
                 'card_slot_key',     ai.card_slot_key,
                 'card_slot_label',   cs.label,
                 'answer_mode',       ai.answer_mode,
                 'selected_tag_id',   ai.selected_tag_id,
                 'selected_label',    sel.label,
                 'selected_tag_id_2', ai.selected_tag_id_2,
                 'selected_label_2',  sel2.label,
                 'is_correct',        ai.is_correct,
                 'correct_tag_id',    pc.tag_id,
                 'correct_label',     cor.label
               )
               order by q.position
             )
        from public.answer_items ai
        join public.quiz_questions q  on q.id = ai.question_id
        join public.card_slots    cs  on cs.card_slot_key = ai.card_slot_key
        join public.tags          sel on sel.id = ai.selected_tag_id
        left join public.tags     sel2 on sel2.id = ai.selected_tag_id_2
        join public.prompt_cards  pc  on pc.prompt_id = q.prompt_id
                                     and pc.card_slot_key = q.card_slot_key
        join public.tags          cor on cor.id = pc.tag_id
       where ai.answer_id = a.id
    ), '[]'::jsonb)
  )
  from public.answers a
  join public.works w on w.id = a.work_id
  where a.work_id = p_work_id
    and a.user_id = (select auth.uid())
    and a.answer_source = 'human';   -- 自分の回答（D194）
$function$;


-- ── 4. 当たったことを、その場で数えて確かめる ──────────────

do $check$
declare
  v_col   int;
  v_def   text;
  v_bad   int;
  v_idx   int;
  v_trg   int;
  v_leak  int;
begin
  select count(*) into v_col
    from information_schema.columns
   where table_schema='public' and table_name='answers' and column_name='answer_source';
  if v_col <> 1 then
    raise exception '列が % 個です（1個のはず）', v_col;
  end if;

  select is_nullable into v_def
    from information_schema.columns
   where table_schema='public' and table_name='answers' and column_name='answer_source';
  if v_def <> 'NO' then
    raise exception '列が null を許しています';
  end if;

  -- 既存の回答はすべて human。**1件も system になっていないこと**
  select count(*) into v_bad from public.answers where answer_source <> 'human';
  if v_bad <> 0 then
    raise exception '既存の回答 % 件が human になっていません', v_bad;
  end if;

  select count(*) into v_idx
    from pg_indexes
   where schemaname='public' and indexname='answers_one_system_per_work';
  if v_idx <> 1 then
    raise exception 'システム回答の索引がありません';
  end if;

  -- 人間の側の一意制約が残っていること
  select count(*) into v_idx
    from pg_constraint
   where conrelid='public.answers'::regclass and conname='answers_one_per_user_per_work';
  if v_idx <> 1 then
    raise exception '人間の側の一意制約が消えています';
  end if;

  select count(*) into v_trg
    from pg_trigger t join pg_class c on c.oid=t.tgrelid
   where not t.tgisinternal and c.relname='answers'
     and t.tgname='answers_guard_source_immutable';
  if v_trg <> 1 then
    raise exception '出所を守る引き金がありません';
  end if;

  -- 利用者は表そのものへ書けない（この migration で変えていないことの確認）
  select count(*) into v_leak
    from information_schema.role_table_grants
   where table_schema='public' and table_name='answers'
     and grantee in ('anon','authenticated','PUBLIC');
  if v_leak <> 0 then
    raise exception '利用者が回答の表へ直接書けます（% 件）', v_leak;
  end if;

  -- 回答を出す窓口は、種別を受け取らない
  select count(*) into v_leak
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='submit_answer'
     and pg_get_functiondef(p.oid) like '%answer_source%';
  if v_leak <> 0 then
    raise exception 'submit_answer が種別を扱っています（扱わないはず）';
  end if;

  -- 統計を数える4本が、すべて種別を見ていること
  select count(*) into v_leak
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('answers_after_insert_stats','answers_after_insert_hint_stats',
                       'answer_items_after_insert_stats','answer_items_after_insert_hint_stats')
     and pg_get_functiondef(p.oid) like '%answer_source%';
  if v_leak <> 4 then
    raise exception '統計の引き金 % 本しか種別を見ていません（4本のはず）', v_leak;
  end if;

  -- 配給と作者向け集計も
  select count(*) into v_leak
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public'
     and p.proname in ('next_work_candidates','get_my_work_result',
                       'get_public_answers','get_my_answers','get_my_answer')
     and pg_get_functiondef(p.oid) like '%answer_source%';
  if v_leak <> 5 then
    raise exception '配給・履歴の % 本しか種別を見ていません（5本のはず）', v_leak;
  end if;

  raise notice '回答の出所を足しました（列1・索引1・引き金1・差し替え9本）。既存はすべて human。';
end
$check$;

commit;
