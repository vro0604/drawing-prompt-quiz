-- ============================================================================
-- 回答の結果を読み解くための集計（P2）
-- ============================================================================
--
-- 【この migration が足すもの】
--   読み取り専用の関数を3本だけ。表を1つも作らず、列を1つも足さず、
--   過去のデータを1行も書き換えない。
--
--   1. public.answer_word_stats(uuid)        …… 内部用。誰にも実行権を与えない
--   2. public.get_work_answer_analysis(uuid) …… 作者だけが呼べる
--   3. public.get_my_answer_analysis(uuid)   …… 答え終わった本人だけが呼べる
--
-- 【なぜ DB の中で数えるのか】
--   answer_items と quiz_choices は【機密】で、誰にも表の権限が無い。
--   他人の行が1行でも読めると is_correct から正解が分かってしまうため。
--   だから集計は security definer の関数の中だけで終わらせ、
--   外へ出すのは「もう正解を知ってよい人」に限る。
--
--     作者   …… 自分で出したお題なので、最初から正解を知っている
--     回答者 …… 答え終わっているので、get_my_answer で既に正解を見ている
--
--   まだ答えていない人には、この2本のどちらも null を返す。
--
-- 【割り算をここでしない】
--   語ごとの点は「ビタ当て1.0 ＋ 複勝0.5」を提示回数で割った値だが、
--   **割り算は画面側でやる。**ここが返すのは数えた素の数だけ。
--   式を1か所（src/features/quiz/results.ts）に置いて、
--   そこを試験で確かめられるようにするため。
--   分母が 0 のときの扱いも、割る側が持つ。
--
-- 【提示回数を、回答者数で代用しない】
--   いまは1つの作品につき4択が固定なので、「その語が出た回数」は
--   結局その問への回答数と同じになる。それでも quiz_choices を
--   join して数える。**将来、人ごとに選択肢を変えても壊れないため。**
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 語ごとの数（内部用）
-- ----------------------------------------------------------------------------
--
-- 1つの作品について、問ごとに「その問に出た語」を全部並べ、
-- それぞれが何回ビタ当てで選ばれ、何回複勝に含まれ、何回目の前に出たかを数える。
--
-- 正解の印も入れる。**呼べるのは下の2本だけ**なので、
-- 正解を知ってよい人にしか届かない。

create or replace function public.answer_word_stats(p_work_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with q as (
    select qq.id, qq.position, qq.card_slot_key, qq.prompt_id, cs.label as slot_label
      from public.works w
      join public.quiz_questions qq on qq.prompt_id = w.prompt_id
      join public.card_slots cs     on cs.card_slot_key = qq.card_slot_key
     where w.id = p_work_id
  ),
  it as (
    -- この作品への回答の内訳。**誰が答えたかは持ち出さない**
    select ai.id, ai.question_id, ai.answer_mode,
           ai.selected_tag_id, ai.selected_tag_id_2
      from public.answer_items ai
      join public.answers a on a.id = ai.answer_id
     where a.work_id = p_work_id
  ),
  ch as (
    select c.question_id, c.tag_id, c.position, c.is_correct, t.label
      from public.quiz_choices c
      join public.tags t on t.id = c.tag_id
      join q            on q.id = c.question_id
  ),
  counted as (
    select ch.question_id,
           ch.tag_id,
           ch.position,
           ch.label,
           ch.is_correct,
           -- その語が選択肢として目の前に出た回数
           count(it.id) as shown_times,
           count(it.id) filter (
             where it.answer_mode = 'exact' and it.selected_tag_id = ch.tag_id
           ) as exact_count,
           count(it.id) filter (
             where it.answer_mode = 'pair'
               and (it.selected_tag_id = ch.tag_id or it.selected_tag_id_2 = ch.tag_id)
           ) as pair_count
      from ch
      left join it on it.question_id = ch.question_id
     group by ch.question_id, ch.tag_id, ch.position, ch.label, ch.is_correct
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'question_id',     q.id,
        'position',        q.position,
        'card_slot_key',   q.card_slot_key,
        'card_slot_label', q.slot_label,
        'choice_count',    (select count(*) from ch where ch.question_id = q.id),
        'correct_tag_id',  pc.tag_id,
        'correct_label',   ct.label,
        'words', coalesce((
          select jsonb_agg(
                   jsonb_build_object(
                     'tag_id',      c.tag_id,
                     'label',       c.label,
                     'is_correct',  c.is_correct,
                     'exact_count', c.exact_count,
                     'pair_count',  c.pair_count,
                     'shown_times', c.shown_times
                   )
                   order by c.position
                 )
            from counted c
           where c.question_id = q.id
        ), '[]'::jsonb)
      )
      order by q.position
    ),
    '[]'::jsonb
  )
  from q
  join public.prompt_cards pc on pc.prompt_id = q.prompt_id
                            and pc.card_slot_key = q.card_slot_key
  join public.tags ct on ct.id = pc.tag_id;
$fn$;

comment on function public.answer_word_stats(uuid) is
  '問ごとの語の数（内部用）。正解の印を含むため、誰にも実行権を与えない。'
  'get_work_answer_analysis と get_my_answer_analysis だけが呼ぶ。';

revoke all on function public.answer_word_stats(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. 作者が見る集計
-- ----------------------------------------------------------------------------
--
-- 【何を返すか】
--   sections … 問ごとの語の数（上の関数そのまま）
--   patterns … 回答者ごとの「どの問で正解を含んでいたか」を 0 と 1 の並びにして、
--               同じ並びの人数を数えたもの。5問なら "11010" のような5文字。
--               **全部外した "00000" も1つの並びとして数える。**
--   perfect_exact_count … 全問をビタ当てで、しかも全問当てた人の数
--
-- 【正解を含んだか、の判定】
--   answer_items.is_correct をそのまま使う。この列は元から
--   「ビタ当てで当てた」と「複勝の2語のどちらかが正解だった」の両方で真になる。
--   **新しく数え直していない。**

create or replace function public.get_work_answer_analysis(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_prompt uuid;
  v_questions int;
begin
  if v_uid is null then
    return null;
  end if;

  select w.prompt_id into v_prompt
    from public.works w
   where w.id = p_work_id
     and w.user_id = v_uid
     and w.deleted_at is null;

  if not found then
    -- 作者以外には何も返さない。「無い」と「見せない」を区別しない
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  return (
    with per_answer as (
      select a.id as answer_id,
             string_agg(
               case when ai.is_correct then '1' else '0' end, ''
               order by qq.position
             ) as pattern,
             count(*) as items,
             count(*) filter (
               where ai.answer_mode = 'exact' and ai.is_correct
             ) as exact_corrects
        from public.answers a
        join public.answer_items ai   on ai.answer_id = a.id
        join public.quiz_questions qq on qq.id = ai.question_id
       where a.work_id = p_work_id
       group by a.id
    )
    select jsonb_build_object(
      'answers_count',  (select count(*) from public.answers a where a.work_id = p_work_id),
      'question_count', v_questions,
      'perfect_exact_count', (
        select count(*) from per_answer p
         where p.items = v_questions and p.exact_corrects = v_questions
      ),
      'patterns', coalesce((
        select jsonb_agg(x.obj order by x.n desc, x.pattern)
          from (
            select p.pattern,
                   count(*) as n,
                   jsonb_build_object('pattern', p.pattern, 'count', count(*)) as obj
              from per_answer p
             group by p.pattern
          ) x
      ), '[]'::jsonb),
      'sections', public.answer_word_stats(p_work_id)
    )
  );
end;
$fn$;

comment on function public.get_work_answer_analysis(uuid) is
  '作者だけが見る集計。語ごとの数・正解を含んだ並びの分布・完全ビタの人数。'
  '割り算はしない（数えた素の数だけを返す）。作者以外には null。';

revoke all on function public.get_work_answer_analysis(uuid) from public, anon, authenticated;
grant execute on function public.get_work_answer_analysis(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 3. 答え終わった本人が見る集計
-- ----------------------------------------------------------------------------
--
-- 【回答の似かたをどう数えるか】
--   問ごとに「最終的に選んだ語の集まり」が完全に一致したら1つ一致。
--
--     ビタ A  と ビタ A    → 一致
--     複勝 A+B と 複勝 B+A → 一致（順番は見ない）
--     ビタ A  と 複勝 A+B  → 一致しない（選んだ集まりが違う）
--
--   ビタだから加点、複勝だから減点、のような重みは付けない。
--   5問なら 0〜5 の一致数になり、その人数を全部返す。
--   **1問も一致しなかった人も数に入れる**（母数から外さない）。
--
-- 【自分を数えない】
--   自分は必ず全問一致するので、母数にも分子にも入れない。

create or replace function public.get_my_answer_analysis(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_answer_id bigint;
  v_prompt    uuid;
  v_questions int;
begin
  if v_uid is null then
    return null;
  end if;

  select a.id into v_answer_id
    from public.answers a
   where a.work_id = p_work_id and a.user_id = v_uid;

  if not found then
    -- まだ答えていない人には何も返さない
    return null;
  end if;

  select w.prompt_id into v_prompt from public.works w where w.id = p_work_id;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  return (
    with sets as (
      -- 回答1件・問1つあたりの「選んだ語の集まり」。並べ替えて持つので
      -- A+B と B+A が同じ値になる
      select ai.answer_id,
             ai.question_id,
             (
               select array_agg(u.x order by u.x)
                 from unnest(array[ai.selected_tag_id, ai.selected_tag_id_2]) as u(x)
                where u.x is not null
             ) as tags
        from public.answer_items ai
        join public.answers a on a.id = ai.answer_id
       where a.work_id = p_work_id
    ),
    mine as (
      select question_id, tags from sets where answer_id = v_answer_id
    ),
    matches as (
      select o.answer_id,
             count(*) filter (where o.tags = m.tags) as n
        from sets o
        join mine m on m.question_id = o.question_id
       where o.answer_id <> v_answer_id
       group by o.answer_id
    ),
    per_answer as (
      select a.id as answer_id,
             string_agg(
               case when ai.is_correct then '1' else '0' end, ''
               order by qq.position
             ) as pattern,
             count(*) as items,
             count(*) filter (
               where ai.answer_mode = 'exact' and ai.is_correct
             ) as exact_corrects
        from public.answers a
        join public.answer_items ai   on ai.answer_id = a.id
        join public.quiz_questions qq on qq.id = ai.question_id
       where a.work_id = p_work_id
       group by a.id
    )
    select jsonb_build_object(
      'answers_count',  (select count(*) from public.answers a where a.work_id = p_work_id),
      'others_count',   (select count(*) from matches),
      'question_count', v_questions,
      'my_pattern',     (select p.pattern from per_answer p where p.answer_id = v_answer_id),
      'is_perfect_exact', (
        select p.items = v_questions and p.exact_corrects = v_questions
          from per_answer p where p.answer_id = v_answer_id
      ),
      'perfect_exact_count', (
        select count(*) from per_answer p
         where p.items = v_questions and p.exact_corrects = v_questions
      ),
      -- 一致数ごとの人数。**0 一致の人も入っている**
      'match_histogram', coalesce((
        select jsonb_agg(x.obj order by x.matches desc)
          from (
            select mt.n as matches,
                   jsonb_build_object('matches', mt.n, 'count', count(*)) as obj
              from matches mt
             group by mt.n
          ) x
      ), '[]'::jsonb),
      'sections', public.answer_word_stats(p_work_id)
    )
  );
end;
$fn$;

comment on function public.get_my_answer_analysis(uuid) is
  '答え終わった本人だけが見る集計。自分の正解包含の並び・完全ビタか・'
  '他の回答者との一致数の分布・問ごとの語の数。まだ答えていない人には null。';

revoke all on function public.get_my_answer_analysis(uuid) from public, anon, authenticated;
grant execute on function public.get_my_answer_analysis(uuid) to authenticated;
