-- サブ指令（D193）
--
-- 【何のためか】
--   お題に出た正式な語1つについて、「それをどう表現するか」の
--   取っかかりを1つだけ添える。
--
--     正式なお題: 怯え   → サブ指令: 強がって隠している
--     正式なお題: 深緑   → サブ指令: 黄を差し色にする
--
--   形状アシスト（D191）が「お題ぜんぶをどういう形として描くか」なのに対し、
--   こちらは正式な語1つずつに付く。役割が違うので別のものとして扱う。
--
-- 【正式なお題ではない】
--   出所: ユーザー指示（2026-09-10）「正式語数に含めない ／ quizに出さない ／
--   誤答候補にしない ／ 正解判定に使わない ／ ビタ当てに使わない ／
--   2択当てに使わない ／ D169に使わない ／ rankingに使わない ／
--   伝達指標に使わない ／ noveltyに使わない ／ 回答者には見せない ／
--   作者は無視して投稿できる」。
--
--   守り方は画面ではない。**置き場所そのものを分けてある。**
--   出題を作る関数が読むのは prompt_cards の tag_id と card_slots だけなので、
--   同じ表に列を足しても、出題には届かない。
--   それを、この migration の最後で数えて確かめる。
--
-- 【表を増やしていない】
--   出所: ユーザー指示（2026-09-10）「新しい表を作らず、
--   nullable列追加で安全に成立するならそれを優先する。」
--   足すのは列2つだけ。表は52のまま。
--
-- 【一覧をDBが持っていない】
--   出所: ユーザー指示（2026-09-10）「modifierをtagsへ入れない。
--   TypeScript側：modifier key / 表示文 / 対応formal tag。
--   DB側：実際に選ばれたmodifier keyだけ。」
--
--   だから DB は「どの語にどれが付くか」を知らない。形だけを検査して保存する。
--   tags に入れると出題の誤答としてその語が出るので、そこには置かない。
--
-- 【持ち込み（art_first）には付かない】
--   出所: ユーザー指示（2026-09-10）「初期版は prompt_first のみ。
--   art_first には付けない。」
--   持ち込みはドラフトを持たず、create_art_first_work が
--   prompt_cards へ直接入れる。あの関数には手を入れていないので、
--   持ち込みの列は必ず空になる。

begin;

-- ── 1. 列を2つ足す ────────────────────────────────────
--
-- ドラフトの枠（作っている途中）と、確定したお題のカード（作り終えたあと）。
-- どちらも null は「サブ指令なし」。既存の行はすべて null から始まる。

alter table public.draft_session_slots
  add column if not exists sub_directive_key text;

alter table public.prompt_cards
  add column if not exists sub_directive_key text;

comment on column public.draft_session_slots.sub_directive_key is
  'サブ指令（D193）。その枠に決まった正式な語へ添える制作の手がかり。null はなし。正式なお題ではない。';
comment on column public.prompt_cards.sub_directive_key is
  'サブ指令（D193）。確定したお題のカードに添える制作の手がかり。null はなし。出題には使わない。';

-- 形だけを見る。**中身が何であるかは DB は知らない。**
alter table public.draft_session_slots
  drop constraint if exists draft_session_slots_sub_directive_format;
alter table public.draft_session_slots
  add constraint draft_session_slots_sub_directive_format
  check (sub_directive_key is null or sub_directive_key ~ '^[a-z][a-z0-9_]{0,30}$');

alter table public.prompt_cards
  drop constraint if exists prompt_cards_sub_directive_format;
alter table public.prompt_cards
  add constraint prompt_cards_sub_directive_format
  check (sub_directive_key is null or sub_directive_key ~ '^[a-z][a-z0-9_]{0,30}$');

-- ── 2. サブ指令だけを書く窓口（サーバー専用） ──────────────
--
-- 【なぜ choose_card に持たせないか】
--   最初は choose_card の引数として鍵を渡す形にしていた。あの関数は
--   「サインイン済みの人」全員に実行を配ってある。そしてサインインの証明書は
--   ブラウザから読み取れる（@supabase/ssr の既定が httpOnly: false）。
--   つまり画面を通さず窓口を直接叩けば、好きな鍵を自分のドラフトへ書けた。
--   DB 側は形しか見ていないので、これを止められない。
--   出所: ユーザー指示（2026-09-10）「sub_directive_key を authenticated利用者が
--   呼べるRPCの引数に置かない。」
--
--   そこで choose_card からはサブ指令の責務を丸ごと外した。**この migration は
--   choose_card に一切触れない。**元の3引数のまま、権限も元のまま残る。
--
-- 【代わりにこれを置く】
--   サーバーだけが持っている秘密の鍵（service_role）からしか呼べない窓口。
--   秘密の鍵はブラウザへ1バイトも渡らないので、捏造する側はここを叩けない。
--   出所: ユーザー指示（2026-09-10）「PUBLIC: false / anon: false /
--   authenticated: false / service_role等のサーバー経路のみ」。
--
-- 【秘密の鍵でも、無条件には書かない】
--   service_role は行ごとの守り（RLS）を素通りする。だから
--   「誰の・どのドラフトの・どの世代の・どの枠の・どの語に対して決めたか」を
--   5つとも突き合わせ、いま DB にある状態と食い違ったら1行も書かない。
--   出所: ユーザー指示（2026-09-10）「service roleだからといって
--   任意のdraft_session_slotsを無条件UPDATEしない。」
--
-- 【引き直しが割り込んだ場合】
--   サーバーが語を読んでから書きに来るまでの間に引き直しが起きると、
--   世代が進んで語も変わる。そのとき古い語に対して決めた鍵を書くと、
--   いまの語と噛み合わないサブ指令が残る。上の突き合わせで弾かれ、
--   0行更新として静かに終わる。**例外にはしない。**
--   出所: ユーザー指示（2026-09-10）「0 rows updateとして安全に終了させる。」

create or replace function public.set_draft_slot_sub_directive(
  p_user_id            uuid,
  p_session_id         uuid,
  p_generation         integer,
  p_card_slot_key      text,
  p_tag_id             bigint,
  p_sub_directive_key  text
)
  returns boolean
  language plpgsql
  security definer
  set search_path to ''
as $function$
declare
  v_rows int;
begin
  -- 何も決まらなかったとき（候補なし、または30%の「付けない」）は
  -- そもそも書きに来ないが、来ても静かに終わる
  if p_sub_directive_key is null then
    return false;
  end if;

  -- 形だけは DB でも見る。中身が何であるかは DB は知らない
  if p_sub_directive_key !~ '^[a-z][a-z0-9_]{0,30}$' then
    raise exception 'BAD_SUB_DIRECTIVE: サブ指令の指定が読み取れません。';
  end if;

  update public.draft_session_slots s
     set sub_directive_key = p_sub_directive_key
   where s.session_id     = p_session_id
     and s.generation     = p_generation
     and s.card_slot_key  = p_card_slot_key
     -- 一度入った枠へ上書きしない。**同じ枠で引き直せる形にしない**
     and s.sub_directive_key is null
     -- そのドラフトが本当にその人のもので、まだ進行中で、世代も一致すること
     and exists (
           select 1
             from public.draft_sessions ds
            where ds.id                 = p_session_id
              and ds.user_id            = p_user_id
              and ds.status             = 'in_progress'
              and ds.current_generation = p_generation)
     -- その枠で実際に決まった語が、サーバーが見て決めたときの語と同じであること
     and exists (
           select 1
             from public.draft_candidates dc
            where dc.session_id    = p_session_id
              and dc.generation    = p_generation
              and dc.card_slot_key = p_card_slot_key
              and dc.is_chosen
              and dc.tag_id        = p_tag_id);

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$function$;

comment on function public.set_draft_slot_sub_directive(uuid, uuid, integer, text, bigint, text) is
  'サブ指令（D193）をドラフトの枠へ書く。サーバー専用。利用者の証明書では呼べない。';

-- **ブラウザから届く証明書では絶対に呼べないこと。**
revoke all on function public.set_draft_slot_sub_directive(uuid, uuid, integer, text, bigint, text)
  from public, anon, authenticated;
grant execute on function public.set_draft_slot_sub_directive(uuid, uuid, integer, text, bigint, text)
  to service_role;


-- ── 3. 確定したお題へ写す ────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_draft(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_uid            uuid := (select auth.uid());
  v_session        record;
  v_slot_count     int;
  v_chosen_count   int;
  v_prompt_id      uuid;
  v_inserted       int;
  v_carried        int;
  v_two_stage      boolean;
  v_question_count int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.reroll_count,
         ds.current_generation, ds.time_limit_seconds,
         ds.started_at, ds.deadline_at, ds.renew_count, ds.last_renewed_at
    into v_session
    from public.draft_sessions ds
   where ds.id = p_session_id
     and ds.user_id = v_uid;

  if not found then
    raise exception 'DRAFT_NOT_FOUND: そのドラフトは見つかりません。';
  end if;

  if v_session.status <> 'in_progress' then
    raise exception 'DRAFT_NOT_IN_PROGRESS: そのドラフトは終了しています。';
  end if;

  perform public.assert_draft_not_expired(p_session_id);

  select dm.uses_two_stage into v_two_stage
    from public.draft_modes dm where dm.mode_key = v_session.mode_key;

  if v_two_stage then
    select count(*) into v_slot_count
      from public.draft_session_slots s
     where s.session_id = p_session_id
       and s.generation = v_session.current_generation;
  else
    select count(*) into v_slot_count
      from public.draft_mode_slots dms
     where dms.mode_key = v_session.mode_key;
  end if;

  select count(*) into v_chosen_count
    from public.draft_candidates dc
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  if v_chosen_count <> v_slot_count then
    raise exception 'DRAFT_INCOMPLETE: まだ決まっていない枠があります（%/%）。',
      v_chosen_count, v_slot_count;
  end if;

  select count(*) into v_carried
    from public.draft_session_carried c where c.session_id = p_session_id;

  insert into public.prompts
    (draft_session_id, created_by, mode_key, time_limit_seconds,
     was_rerolled, reroll_count, status, origin,
     started_at, deadline_at, renew_count, last_renewed_at)
  values
    (p_session_id, v_uid, v_session.mode_key, v_session.time_limit_seconds,
     v_session.reroll_count > 0, v_session.reroll_count, 'active',
     case when v_carried > 0 then 'saved' else 'draft' end,
     v_session.started_at, v_session.deadline_at,
     v_session.renew_count, v_session.last_renewed_at)
  returning id into v_prompt_id;

  -- 確定したカード。サブ指令（D193）は枠の行から写す。
  -- **正式な語と同じ行に載るが、別の列である。**
  -- 出題はこの表の tag_id しか読まないので、混ざる道は無い。
  insert into public.prompt_cards
    (prompt_id, card_slot_key, slot_order, tag_id, sub_directive_key)
  select v_prompt_id, dc.card_slot_key, dc.slot_order, dc.tag_id, s.sub_directive_key
    from public.draft_candidates dc
    left join public.draft_session_slots s
      on s.session_id = dc.session_id
     and s.generation  = dc.generation
     and s.card_slot_key = dc.card_slot_key
   where dc.session_id = p_session_id
     and dc.generation = v_session.current_generation
     and dc.is_chosen;

  get diagnostics v_inserted = row_count;
  if v_inserted <> v_slot_count then
    raise exception 'CARD_COUNT_MISMATCH: 答えのカードが %件です（必要 %件）。',
      v_inserted, v_slot_count;
  end if;

  if v_carried > 0 then
    -- 派生お題へ実際に入った要素（要素単位の追跡）
    insert into public.prompt_element_origins
      (prompt_id, tag_id, source_prompt_id, source_work_id,
       carry_slot_id, saved_element_id, source_is_own)
    select v_prompt_id, c.tag_id, c.source_prompt_id, c.source_work_id,
           c.carry_slot_id, c.saved_element_id, c.source_is_own
      from public.draft_session_carried c
     where c.session_id = p_session_id
    on conflict (prompt_id, tag_id) do nothing;

    -- 保存枠を使用した派生お題（枠単位の追跡）。
    -- **枠の要素数と、そのうち使った数の両方を残す。**
    -- 1つの枠から一部だけ使ったことが、あとから分かるようにするため。
    insert into public.prompt_carry_slots
      (prompt_id, carry_slot_id, source_is_own, source_work_id, source_prompt_id,
       slot_size, used_count)
    select v_prompt_id,
           c.carry_slot_id,
           bool_and(c.source_is_own),
           (array_agg(c.source_work_id))[1],
           (array_agg(c.source_prompt_id))[1],
           coalesce((select count(*) from public.saved_elements se
                      where se.carry_slot_id = c.carry_slot_id), count(*)),
           count(*)
      from public.draft_session_carried c
     where c.session_id = p_session_id
       and c.carry_slot_id is not null
     group by c.carry_slot_id
    on conflict (prompt_id, carry_slot_id) do nothing;
  end if;

  -- **出題数はここで決まる。お題のカードの数がそのまま問数になる（D165）**
  v_question_count := public.build_quiz_for_prompt(v_prompt_id);

  update public.draft_sessions ds
     set status       = 'completed',
         completed_at = clock_timestamp()
   where ds.id = p_session_id;

  -- 流れがここで終わる。セッション内の保存枠は保持を終える
  perform public.end_session_carry(v_uid);

  return jsonb_build_object(
    'prompt_id',      v_prompt_id,
    'mode_key',       v_session.mode_key,
    'card_count',     v_slot_count,
    'question_count', v_question_count
  );
end;
$function$;

-- ── 4. 作者にだけ返す2本 ────────────────────────────────
--
-- どちらも本人の行しか返さない（作者かどうかの判定は元からある）。
-- 回答者へ渡る関数には1つも足していない。

CREATE OR REPLACE FUNCTION public.draft_state_json(p_session_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'session_id',          ds.id,
    'mode_key',            ds.mode_key,
    'mode_label',          dm.label,
    'status',              ds.status,
    'candidate_count',     ds.candidate_count,
    'max_rerolls',         ds.max_rerolls,
    'reroll_count',        ds.reroll_count,
    'rerolls_left',        ds.max_rerolls - ds.reroll_count,
    'time_limit_seconds',  ds.time_limit_seconds,
    -- 【互換期間だけ返す旧い鍵】
    --   旧い画面は、二重送信で衝突したときに「いま進行中のものが、
    --   いま始めようとした条件と同じか」をこの値で見比べている
    --   （実測: HEAD の src/app/play/actions.ts が
    --    current.quiz_question_count === mode.quiz_question_count を見ている）。
    --   鍵を消すと、その比較が必ず不一致になり、合流できるはずの場面で
    --   案内文が出る。**壊れはしないが、旧い画面の振る舞いが変わる。**
    --   だから互換期間のあいだは返す。
    --
    --   値の出どころは draft_modes（モードの設定値）。
    --   旧い画面が比べる相手も draft_modes なので、比較は今までどおり成立する。
    --   **この値は出題数の決定にも採点にも使わない。**
    --   出題数はお題として確定した語の数で決まる（D165）。
    --   新しい画面の本番稼働後、旧列の削除と同じ migration でこの鍵も消す。
    'quiz_question_count', dm.quiz_question_count,
    'draft_base',          ds.draft_base,
    -- 形状アシスト（D191）。**お題ではない。**盤面に小さく出すためだけの値
    'shape_assist_key',    ds.shape_assist_key,
    'generation',          ds.current_generation,
    'current_slot_order',  ds.current_slot_order,
    'slot_count',          (
      case when dm.uses_two_stage
        then (select count(*) from public.draft_session_slots s
               where s.session_id = ds.id and s.generation = ds.current_generation)
        else (select count(*) from public.draft_mode_slots dms
               where dms.mode_key = ds.mode_key)
      end
    ),
    'carried_count',       (
      select count(*) from public.draft_session_carried c
       where c.session_id = ds.id
    ),
    'chosen_count',        (select count(*) from public.draft_candidates dc
                             where dc.session_id = ds.id
                               and dc.generation = ds.current_generation
                               and dc.is_chosen),
    'is_ready_to_complete',
      (select count(*) from public.draft_candidates dc
        where dc.session_id = ds.id
          and dc.generation = ds.current_generation
          and dc.is_chosen)
      = (
        case when dm.uses_two_stage
          then (select count(*) from public.draft_session_slots s
                 where s.session_id = ds.id and s.generation = ds.current_generation)
          else (select count(*) from public.draft_mode_slots dms
                 where dms.mode_key = ds.mode_key)
        end
      ),
    'slots', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   x.card_slot_key,
                 'sub_directive_key', x.sub_directive_key,
                 'card_slot_label', x.card_slot_label,
                 'category_label',  x.category_label,
                 'is_carried',      x.is_carried,
                 'candidate_count', x.candidate_count,
                 'pool_revealed',   x.pool_revealed,
                 'held_limit',      least(2, x.candidate_count - 1),
                 'slot_order',      x.slot_order,
                 'is_current',      x.slot_order = ds.current_slot_order,
                 'candidates',      x.candidates
               )
               order by x.slot_order
             )
        from (
          select dc.card_slot_key,
                 (select s.sub_directive_key from public.draft_session_slots s
                   where s.session_id = dc.session_id
                     and s.generation = dc.generation
                     and s.card_slot_key = dc.card_slot_key) as sub_directive_key,
                 cs.label as card_slot_label,
                 tp.label as category_label,
                 coalesce(
                   (select s.source = 'carried' from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   false) as is_carried,
                 coalesce(
                   (select s.candidate_count from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   count(*)::int) as candidate_count,
                 coalesce(
                   (select s.pool_revealed_at is not null
                      from public.draft_session_slots s
                     where s.session_id = dc.session_id
                       and s.generation = dc.generation
                       and s.card_slot_key = dc.card_slot_key),
                   false) as pool_revealed,
                 dc.slot_order,
                 jsonb_agg(
                   jsonb_build_object(
                     'candidate_index', dc.candidate_index,
                     'revealed',        dc.revealed_at is not null,
                     'is_chosen',       dc.is_chosen,
                     'is_held',         dc.is_held,
                     -- めくっていないカードは中身を返さない
                     'tag_id', case when dc.revealed_at is null then null
                                    else to_jsonb(dc.tag_id) end,
                     'label',  case when dc.revealed_at is null then null
                                    else to_jsonb(tg.label) end
                   )
                   order by dc.candidate_index
                 ) as candidates
            from public.draft_candidates dc
            join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
            join public.tag_pools  tp on tp.pool_key      = cs.pool_key
            join public.tags       tg on tg.id            = dc.tag_id
           where dc.session_id = ds.id
             and dc.generation = ds.current_generation
           group by dc.session_id, dc.generation, dc.card_slot_key,
                    cs.label, tp.label, dc.slot_order
        ) x
    ), '[]'::jsonb)
  )
  from public.draft_sessions ds
  join public.draft_modes dm on dm.mode_key = ds.mode_key
  where ds.id = p_session_id;
$function$;

CREATE OR REPLACE FUNCTION public.get_my_prompt(p_prompt_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select jsonb_build_object(
    'id',                     p.id,
    'mode_key',               p.mode_key,
    'mode_label',             dm.label,
    'origin',                 p.origin,
    'time_limit_seconds',     p.time_limit_seconds,
    'was_rerolled',           p.was_rerolled,
    'reroll_count',           p.reroll_count,
    'status',                 p.status,
    'candidates_revealed_at', p.candidates_revealed_at,
    'reveal_reason',          p.reveal_reason,
    'created_at',             p.created_at,
    -- 形状アシスト（D191）。**お題ではない。**この関数は
    -- created_by = auth.uid() で作者に限っているので、回答者へは出ない。
    -- 持ち込み（draft_session_id が null）では必ず null になる
    'shape_assist_key', (select ds.shape_assist_key
                           from public.draft_sessions ds
                          where ds.id = p.draft_session_id),
    'work_id', (select w.id from public.works w where w.prompt_id = p.id),

    -- 確定カード＝お題の答え
    'cards', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'card_slot_key',   pc.card_slot_key,
                 'sub_directive_key', pc.sub_directive_key,
                 'card_slot_label', cs.label,
                 'slot_order',      pc.slot_order,
                 'tag_id',          pc.tag_id,
                 'tag_label',       tg.label,
                 'pool_key',        tg.pool_key
               )
               order by pc.slot_order
             )
        from public.prompt_cards pc
        join public.card_slots cs on cs.card_slot_key = pc.card_slot_key
        join public.tags       tg on tg.id            = pc.tag_id
       where pc.prompt_id = p.id
    ), '[]'::jsonb),

    -- 引かなかったカード。開示済みのときだけ。
    -- 持ち込み（draft_session_id が null）では、ここは必ず空になる。
    'unchosen', case
      when p.candidates_revealed_at is null then '[]'::jsonb
      else coalesce((
        select jsonb_agg(
                 jsonb_build_object(
                   'card_slot_key',   dc.card_slot_key,
                   'card_slot_label', cs.label,
                   'slot_order',      dc.slot_order,
                   'candidate_index', dc.candidate_index,
                   'tag_id',          dc.tag_id,
                   'tag_label',       tg.label
                 )
                 order by dc.slot_order, dc.candidate_index
               )
          from public.draft_candidates dc
          join public.draft_sessions ds on ds.id = dc.session_id
          join public.card_slots cs on cs.card_slot_key = dc.card_slot_key
          join public.tags       tg on tg.id            = dc.tag_id
         where ds.id = p.draft_session_id
           and dc.generation = ds.current_generation
           and dc.is_chosen = false
      ), '[]'::jsonb)
    end
  )
  from public.prompts p
  join public.draft_modes dm on dm.mode_key = p.mode_key
  where p.id = p_prompt_id
    and p.created_by = (select auth.uid());
$function$;

-- ── 5. 当たったことを、その場で数えて確かめる ──────────────

do $check$
declare
  v_cols  int;
  v_fn    int;
  v_anon  int;
  v_auth  int;
  v_leak  int;
  v_rows  int;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and ((table_name = 'draft_session_slots' and column_name = 'sub_directive_key')
       or (table_name = 'prompt_cards'        and column_name = 'sub_directive_key'));
  if v_cols <> 2 then
    raise exception '列が % 個です（2個のはず）', v_cols;
  end if;

  -- choose_card は**1本のまま**で、引数が3つのまま、
  -- サブ指令の文字が1つも入っていないこと。触っていないことを数えて確かめる
  select count(*) into v_fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'choose_card'
     and p.pronargs = 3;
  if v_fn <> 1 then
    raise exception 'choose_card が3引数で % 本です（1本のはず）', v_fn;
  end if;

  select count(*) into v_fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'choose_card'
     and pg_get_functiondef(p.oid) like '%sub_directive%';
  if v_fn <> 0 then
    raise exception 'choose_card にサブ指令が入っています（入らないはず）';
  end if;

  -- 書く窓口は1本だけ
  select count(*) into v_fn
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'set_draft_slot_sub_directive';
  if v_fn <> 1 then
    raise exception '書く窓口が % 本です（1本のはず）', v_fn;
  end if;

  -- **利用者の証明書では呼べないこと。**ここが今回の要。
  select count(*) into v_anon
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'set_draft_slot_sub_directive'
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));
  if v_anon <> 0 then
    raise exception '利用者が書く窓口を呼べます（呼べないはず）';
  end if;

  select count(*) into v_auth
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'set_draft_slot_sub_directive'
     and has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_auth <> 1 then
    raise exception 'サーバーが書く窓口を呼べません';
  end if;

  -- 表そのものへ直接書ける利用者がいないこと。
  -- 窓口を閉じても、表が開いていたら同じことになる
  select count(*) into v_anon
    from information_schema.column_privileges
   where table_schema = 'public'
     and table_name   = 'draft_session_slots'
     and column_name  = 'sub_directive_key'
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v_anon <> 0 then
    raise exception '利用者が枠の列へ直接書けます（書けないはず）';
  end if;

  -- **回答者・出題・配給・順位へ1歩も漏れていないこと。**
  select count(*) into v_leak
    from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prokind = 'f'
     and p.proname in ('build_quiz_for_prompt', 'get_work_quiz', 'submit_answer',
                       'next_work_candidates', 'get_next_work', 'get_work_detail',
                       'get_public_works', 'get_rankings', 'create_art_first_work',
                       'create_work', 'get_answered_prompt', 'get_public_answers')
     and pg_get_functiondef(p.oid) like '%sub_directive%';
  if v_leak <> 0 then
    raise exception '回答者・出題・配給・順位の関数 % 本にサブ指令が入っています', v_leak;
  end if;

  -- 既存の行はすべて空から始まる
  select count(*) into v_rows
    from public.prompt_cards where sub_directive_key is not null;
  if v_rows <> 0 then
    raise exception '既存のカードに % 件のサブ指令が入っています（0件のはず）', v_rows;
  end if;

  raise notice 'サブ指令を足しました（列2つ・書く窓口1本・作者向け3本。choose_card は触っていない）。';
end
$check$;

commit;
