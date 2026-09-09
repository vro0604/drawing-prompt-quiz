-- ============================================================================
-- 作者が結果を掘り下げるための仕掛け（P3）
-- ============================================================================
--
-- 【この migration が足すもの】
--   表を1つと、読み取りの関数を4本、書き込みの関数を1本。
--   既存の表の列は1つも足さず、過去のデータを1行も書き換えない。
--
--     public.analysis_exclusions        …… 作者が分析から外した回答
--     public.analysis_min_subgroup()    …… 掘り下げに要る最少人数（5）
--     public.eligible_answers(uuid)     …… 分析の母集団を決める**唯一の場所**
--     public.answer_word_stats(...)     …… 語ごとの数（引数を作り直した）
--     public.get_work_answer_list(uuid) …… 作者向けの回答一覧（身元は出さない）
--     public.get_work_drilldown(...)    …… 条件を指定して絞った集団の語の分布
--     public.set_answer_excluded(...)   …… 分析から外す／戻す
--
-- 【母集団を1か所で決める理由】
--   いまの母集団は「その作品への回答のうち、作者が外していないもの」。
--   この先、持ち込み枠の仕組みが入ると「取り込み済みのものだけ」が加わる。
--   条件が各関数に散らばっていると、そのとき全部を書き直すことになる。
--   `eligible_answers` の中だけを書き換えれば済む形にしてある。
--
-- 【回答そのものは消さない】
--   外すのは作者の分析からだけ。`answers` も `answer_items` も残り、
--   回答した本人の結果（get_my_answer / get_my_answer_analysis）も、
--   公開の集計（work_slot_stats / user_stats）も変わらない。
--   **「その回答が無効だ」ということと「作者の分析に使わない」ことを、
--   同じ印で表さない。**別の表に置いてあるのはそのため。
--
-- 【少人数のときに詳細を返さない】
--   条件で絞った集団が5人未満になったら、その先を返さない。
--   人数そのものも返さない。**画面で隠すのでは足りない。**
--   隠すだけだと、通信の中身を見れば読めてしまう。作者本人にも返さない。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 分析から外した回答
-- ----------------------------------------------------------------------------
--
-- 【なぜ answers に列を足さないか】
--   `answers` に `is_excluded` を足すと、回答そのものの性質のように見える。
--   実際には「この作品の作者が、自分の分析にはこれを使わないと決めた」だけで、
--   回答が無効になったわけではない。**置き場所で意味を分ける。**
--
--   もう1つ実務的な理由がある。`answers` には書き込みの門番と
--   集計のトリガが付いている。外す・戻すのたびにそこを通すと、
--   集計表（work_slot_stats など）を触ってしまう恐れがある。
--   別の表なら、触れる先はこの表だけになる。

create table if not exists public.analysis_exclusions (
  answer_id bigint primary key
    references public.answers (id) on delete cascade on update restrict,

  -- どの作品の分析から外したか。answer_id から引けるが、
  -- 作者の確認と索引のために持つ
  work_id uuid not null
    references public.works (id) on delete cascade on update restrict,

  excluded_at timestamptz not null default now(),

  -- 外した人。作品の持ち主のはずだが、記録として残す
  excluded_by uuid
    references public.profiles (id) on delete set null on update restrict
);

comment on table public.analysis_exclusions is
  '作者が自分の分析から外した回答【作者限定】。回答そのものは消さない。'
  '権限もポリシーも与えない。読み書きは RPC 経由だけ。';

create index if not exists analysis_exclusions_work_idx
  on public.analysis_exclusions (work_id);

alter table public.analysis_exclusions enable row level security;


-- ----------------------------------------------------------------------------
-- 2. 掘り下げに要る最少人数
-- ----------------------------------------------------------------------------
--
-- 5人。出所: ユーザー指示（2026-09-08）「P3の深掘り対象は5人以上」。
-- 画面にも試験にも数を直接書かず、ここから読む。

create or replace function public.analysis_min_subgroup()
returns int
language sql
immutable
set search_path = ''
as $fn$ select 5 $fn$;

comment on function public.analysis_min_subgroup() is
  '条件で絞った集団の詳細を返すのに要る最少人数（5）。ここが唯一の出どころ。';

revoke all on function public.analysis_min_subgroup() from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 分析の母集団（**唯一の定義**）
-- ----------------------------------------------------------------------------
--
-- いまの条件は「その作品への回答のうち、作者が外していないもの」。
-- 持ち込み枠の仕組みが入ったら、ここへ1つ条件が増えるだけで、
-- 呼ぶ側は1行も変わらない。

create or replace function public.eligible_answers(p_work_id uuid)
returns table (answer_id bigint)
language sql
stable
security definer
set search_path = ''
as $fn$
  select a.id
    from public.answers a
   where a.work_id = p_work_id
     and not exists (
       select 1 from public.analysis_exclusions x where x.answer_id = a.id
     );
$fn$;

comment on function public.eligible_answers(uuid) is
  '作者の分析に使う回答の集合【内部用】。母集団の条件はここだけに書く。'
  '将来の取り込み枠の条件もここへ足す。';

revoke all on function public.eligible_answers(uuid) from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. 語ごとの数（数える相手を引数で受け取る形へ）
-- ----------------------------------------------------------------------------
--
-- P2 では「この作品への回答すべて」を数えていた。P3 では
--   ・作者向け  … 外していない回答だけ
--   ・回答者向け … これまでどおり全部
--   ・掘り下げ   … 条件で絞った集団だけ
-- の3通りを数える。**式は1つのまま、数える相手だけを外から渡す。**

drop function if exists public.answer_word_stats(uuid);

create or replace function public.answer_word_stats(
  p_work_id      uuid,
  p_answer_ids   bigint[],
  p_question_ids bigint[] default null
)
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
       and (p_question_ids is null or qq.id = any (p_question_ids))
  ),
  it as (
    -- 数える相手だけを拾う。**誰が答えたかは持ち出さない**
    select ai.id, ai.question_id, ai.answer_mode,
           ai.selected_tag_id, ai.selected_tag_id_2
      from public.answer_items ai
     where ai.answer_id = any (coalesce(p_answer_ids, array[]::bigint[]))
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

comment on function public.answer_word_stats(uuid, bigint[], bigint[]) is
  '問ごとの語の数【内部用】。数える回答を p_answer_ids で受け取る。'
  '正解の印を含むため、誰にも実行権を与えない。';

revoke all on function public.answer_word_stats(uuid, bigint[], bigint[])
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 5. 作者向けの集計を、外した回答を抜いた母集団で数え直す
-- ----------------------------------------------------------------------------
--
-- P2 で作った関数の中身だけを差し替える。返す形は変えていない。
-- 足したのは母数の内訳（分析対象と、外した件数）と最少人数。

create or replace function public.get_work_answer_analysis(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_prompt    uuid;
  v_questions int;
  v_ids       bigint[];
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
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  -- 母集団はここでだけ決める
  select coalesce(array_agg(e.answer_id), array[]::bigint[])
    into v_ids
    from public.eligible_answers(p_work_id) e;

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
       where a.id = any (v_ids)
       group by a.id
    )
    select jsonb_build_object(
      -- **母数は外した分を引いたあとの数。**もとの件数は excluded_count と足せば出る
      'answers_count',  cardinality(v_ids),
      'excluded_count', (
        select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
      ),
      'min_subgroup',   public.analysis_min_subgroup(),
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
      'sections', public.answer_word_stats(p_work_id, v_ids)
    )
  );
end;
$fn$;

comment on function public.get_work_answer_analysis(uuid) is
  '作者だけが見る集計。母集団は eligible_answers（外した回答を含まない）。'
  '割り算はしない（数えた素の数だけを返す）。作者以外には null。';


-- ----------------------------------------------------------------------------
-- 6. 回答者向けは、母集団を変えない
-- ----------------------------------------------------------------------------
--
-- 【境界】
--   作者が自分の分析から外した回答は、**回答した人の画面には影響しない。**
--   外すのは作者の見方であって、他人の結果を書き換える権限ではない。
--   だからここは「その作品への回答すべて」を数え続ける。

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
  v_all       bigint[];
begin
  if v_uid is null then
    return null;
  end if;

  select a.id into v_answer_id
    from public.answers a
   where a.work_id = p_work_id and a.user_id = v_uid;

  if not found then
    return null;
  end if;

  select w.prompt_id into v_prompt from public.works w where w.id = p_work_id;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  -- **外した回答も入れる。**作者の都合で他人の見え方を変えない
  select coalesce(array_agg(a.id), array[]::bigint[])
    into v_all
    from public.answers a
   where a.work_id = p_work_id;

  return (
    with sets as (
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
      'match_histogram', coalesce((
        select jsonb_agg(x.obj order by x.matches desc)
          from (
            select mt.n as matches,
                   jsonb_build_object('matches', mt.n, 'count', count(*)) as obj
              from matches mt
             group by mt.n
          ) x
      ), '[]'::jsonb),
      'sections', public.answer_word_stats(p_work_id, v_all)
    )
  );
end;
$fn$;

comment on function public.get_my_answer_analysis(uuid) is
  '答え終わった本人だけが見る集計。**作者が外した回答も母数に入れる**'
  '（外すのは作者の見方であって、他人の結果ではない）。未回答者には null。';


-- ----------------------------------------------------------------------------
-- 7. 条件で絞った集団の語の分布（掘り下げ）
-- ----------------------------------------------------------------------------
--
-- 【引数】
--   p_pattern  "11010" のような 0 と 1 の並び。問の出題順。null なら全員。
--   p_filters  [{"question_id": 12, "tag_id": 345}, ...]
--              **文字列の断片は受け取らない。**問と語の組だけを受け取り、
--              その問がこの作品のもので、その語がその問の選択肢であることを
--              ここで確かめる。画面から来た値をそのまま SQL に混ぜない。
--
-- 【条件の意味】
--   語の条件は「その回答者が最後に選んだ語の集まりに、その語が入っている」。
--   ビタ当てで選んだ1語でも、複勝で選んだ2語のどちらかでも、同じく「入っている」。
--   **答え方で条件を分けない。**分けるのは、返す内訳の中だけ。
--
-- 【返すもの】
--   足りているとき … 集団の人数と、正解を含まなかった問だけの語の分布
--   足りないとき   … below_threshold だけ。人数も語の数も返さない
--
-- 【正解を含んだ問を返さない理由】
--   掘り下げの目的は「伝わった人たちが、伝わらなかった部分を何だと思ったか」。
--   当たった問の内訳はその問いに答えない。返さないのは画面の都合ではなく、
--   返す必要が無いため。ただし各問の正解語は必ず添える。

create or replace function public.get_work_drilldown(
  p_work_id uuid,
  p_pattern text default null,
  p_filters jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid       uuid := (select auth.uid());
  v_prompt    uuid;
  v_questions int;
  v_min       int := public.analysis_min_subgroup();
  v_ids       bigint[];
  v_subgroup  bigint[];
  v_count     int;
  v_bad       int;
  v_targets   bigint[];
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
    return null;
  end if;

  if p_filters is null or jsonb_typeof(p_filters) <> 'array' then
    raise exception 'BAD_FILTERS: 絞り込みの形式が正しくありません。';
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  if p_pattern is not null
     and (length(p_pattern) <> v_questions or p_pattern !~ '^[01]+$') then
    raise exception 'BAD_PATTERN: 当て方の指定が正しくありません。';
  end if;

  -- --- 絞り込みの中身を確かめる ------------------------------------------
  --
  -- その問がこの作品のものか。その語がその問の選択肢か。
  -- **どちらか外れていたら断る。**通してしまうと、他の作品の語で
  -- 人数を試せるようになる。
  select count(*)
    into v_bad
    from jsonb_array_elements(p_filters) f
   where not exists (
     select 1
       from public.quiz_questions qq
       join public.quiz_choices c on c.question_id = qq.id
      where qq.prompt_id = v_prompt
        and qq.id  = (f ->> 'question_id')::bigint
        and c.tag_id = (f ->> 'tag_id')::bigint
   );

  if v_bad > 0 then
    raise exception 'BAD_FILTER_TARGET: この作品に無い問か語が指定されています。';
  end if;

  -- 同じ問に2つの条件を重ねない（重ねると必ず0人になる）
  if (select count(distinct f ->> 'question_id') from jsonb_array_elements(p_filters) f)
     <> (select count(*) from jsonb_array_elements(p_filters) f) then
    raise exception
      'DUPLICATE_FILTER_SECTION: 同じ項目に2つの条件は重ねられません。'
      'その項目の条件を選び直してください。';
  end if;

  select coalesce(array_agg(e.answer_id), array[]::bigint[])
    into v_ids
    from public.eligible_answers(p_work_id) e;

  -- --- 条件に合う回答を絞る ----------------------------------------------
  with per as (
    select a.id as answer_id,
           string_agg(
             case when ai.is_correct then '1' else '0' end, ''
             order by qq.position
           ) as pattern
      from public.answers a
      join public.answer_items ai   on ai.answer_id = a.id
      join public.quiz_questions qq on qq.id = ai.question_id
     where a.id = any (v_ids)
     group by a.id
  )
  select coalesce(array_agg(p.answer_id), array[]::bigint[])
    into v_subgroup
    from per p
   where (p_pattern is null or p.pattern = p_pattern)
     and not exists (
       select 1
         from jsonb_array_elements(p_filters) f
        where not exists (
          select 1
            from public.answer_items ai
           where ai.answer_id = p.answer_id
             and ai.question_id = (f ->> 'question_id')::bigint
             and (f ->> 'tag_id')::bigint
                 in (ai.selected_tag_id, coalesce(ai.selected_tag_id_2, ai.selected_tag_id))
        )
     );

  v_count := cardinality(v_subgroup);

  -- --- 少人数なら、その先を返さない --------------------------------------
  --
  -- **人数も返さない。**返すと、条件を少しずつ変えて誰かを言い当てられる。
  if v_count < v_min then
    return jsonb_build_object(
      'below_threshold', true,
      'min_subgroup',    v_min,
      'subgroup_count',  null,
      'question_count',  v_questions,
      'pattern',         p_pattern,
      'sections',        '[]'::jsonb
    );
  end if;

  -- --- 正解を含まなかった問だけを詳細の対象にする ------------------------
  if p_pattern is null then
    v_targets := null;   -- 当て方を指定していないときは全部の問を出す
  else
    select coalesce(array_agg(qq.id order by qq.position), array[]::bigint[])
      into v_targets
      from public.quiz_questions qq
     where qq.prompt_id = v_prompt
       and substr(p_pattern, qq.position + 1, 1) = '0';
  end if;

  return jsonb_build_object(
    'below_threshold', false,
    'min_subgroup',    v_min,
    'subgroup_count',  v_count,
    'question_count',  v_questions,
    'pattern',         p_pattern,
    'sections',        public.answer_word_stats(p_work_id, v_subgroup, v_targets)
  );
end;
$fn$;

comment on function public.get_work_drilldown(uuid, text, jsonb) is
  '作者だけが呼べる掘り下げ。当て方の並びと「その語を選んだ人」で絞り、'
  '正解を含まなかった問の語の分布を返す。5人未満なら人数も内訳も返さない。';

revoke all on function public.get_work_drilldown(uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.get_work_drilldown(uuid, text, jsonb) to authenticated;


-- ----------------------------------------------------------------------------
-- 8. 作者向けの回答一覧（外す相手を選ぶための表）
-- ----------------------------------------------------------------------------
--
-- 【誰が答えたかを出さない】
--   user_id も表示名も返さない。返すのは
--     ・その作品の中だけの通し番号（古い順に1から）
--     ・答えた日時
--     ・いくつの項目で正解を含んだか
--     ・全問をビタ当てで当てたか
--     ・いま分析から外しているか
--   だけ。
--
-- 【当て方の並びを返さない理由】
--   1件ずつの並びを返すと、5人未満の集団の中身を、この一覧から
--   組み立て直せてしまう。**少人数を守る仕掛けを、別の入口から迂回できる。**
--   「いくつ含んだか」は、作者向けの重なりの図が既に段ごとに出している数と
--   同じ粒度なので、ここから新しく分かることは無い。
--
-- 【通し番号を返す理由】
--   answers.id はサービス全体で通し番号なので、渡すと他の作品の回答量まで
--   にじむ。作品の中だけの番号にすれば、外す相手を指すのに足りる。

create or replace function public.get_work_answer_list(p_work_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid    uuid := (select auth.uid());
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
    return null;
  end if;

  select count(*) into v_questions
    from public.quiz_questions qq
   where qq.prompt_id = v_prompt;

  return (
    with numbered as (
      select a.id,
             a.created_at,
             row_number() over (order by a.created_at, a.id) as no
        from public.answers a
       where a.work_id = p_work_id
    ),
    per as (
      select n.id, n.no, n.created_at,
             count(*) filter (where ai.is_correct) as corrects,
             count(*) as items,
             count(*) filter (where ai.answer_mode = 'exact' and ai.is_correct)
               as exact_corrects
        from numbered n
        join public.answer_items ai on ai.answer_id = n.id
       group by n.id, n.no, n.created_at
    )
    select jsonb_build_object(
      'total',          (select count(*) from numbered),
      'excluded_count', (
        select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
      ),
      'question_count', v_questions,
      'answers', coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'no',               p.no,
                   'answered_at',      p.created_at,
                   'correct_sections', p.corrects,
                   'question_count',   p.items,
                   'is_perfect_exact',
                     p.items = v_questions and p.exact_corrects = v_questions,
                   'is_excluded', exists (
                     select 1 from public.analysis_exclusions x where x.answer_id = p.id
                   )
                 )
                 order by p.no
               )
          from per p
      ), '[]'::jsonb)
    )
  );
end;
$fn$;

comment on function public.get_work_answer_list(uuid) is
  '作者向けの回答一覧。身元も当て方の並びも返さない。'
  '外す相手を指すための通し番号と、日時と、含んだ項目数だけ。';

revoke all on function public.get_work_answer_list(uuid) from public, anon, authenticated;
grant execute on function public.get_work_answer_list(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 9. 分析から外す／戻す
-- ----------------------------------------------------------------------------
--
-- 通し番号（get_work_answer_list が返したもの）で指す。まとめて渡せる。
-- **取り消せる。**戻せば、次に読んだときの集計に戻ってくる。

create or replace function public.set_answer_excluded(
  p_work_id    uuid,
  p_answer_nos int[],
  p_excluded   boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_ids bigint[];
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  -- **作品の持ち主だけが変えられる。**画面ではなくここで断る
  if not exists (
    select 1 from public.works w
     where w.id = p_work_id and w.user_id = v_uid and w.deleted_at is null
  ) then
    raise exception 'NOT_WORK_OWNER: 自分の作品の分析だけが変えられます。';
  end if;

  if p_answer_nos is null or cardinality(p_answer_nos) = 0 then
    raise exception 'NO_TARGET: 対象が選ばれていません。';
  end if;

  with numbered as (
    select a.id, row_number() over (order by a.created_at, a.id) as no
      from public.answers a
     where a.work_id = p_work_id
  )
  select coalesce(array_agg(n.id), array[]::bigint[])
    into v_ids
    from numbered n
   where n.no = any (p_answer_nos);

  if cardinality(v_ids) <> cardinality(p_answer_nos) then
    raise exception 'ANSWER_NOT_FOUND: 指定した回答が見つかりません。画面を開き直してください。';
  end if;

  if p_excluded then
    insert into public.analysis_exclusions (answer_id, work_id, excluded_by)
    select id, p_work_id, v_uid from unnest(v_ids) as u(id)
    on conflict (answer_id) do nothing;
  else
    delete from public.analysis_exclusions x where x.answer_id = any (v_ids);
  end if;

  return jsonb_build_object(
    'changed',        cardinality(v_ids),
    'excluded_count', (
      select count(*) from public.analysis_exclusions x where x.work_id = p_work_id
    ),
    'analysed_count', (
      select count(*) from public.eligible_answers(p_work_id)
    )
  );
end;
$fn$;

comment on function public.set_answer_excluded(uuid, int[], boolean) is
  '作者が回答を自分の分析から外す／戻す。回答そのものは消さない。'
  '作品の持ち主以外は断る。';

revoke all on function public.set_answer_excluded(uuid, int[], boolean)
  from public, anon, authenticated;
grant execute on function public.set_answer_excluded(uuid, int[], boolean) to authenticated;
