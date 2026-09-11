-- ============================================================================
-- 20260912090000_system_answer_queue.sql
--   システム回答を、信頼されたサーバーだけが積んで・取り出して・保存できる形
-- ============================================================================
--
-- 【何のためか】
--   新規利用者の最初の作品に、誰からも回答が来ないまま終わる時間を作らない。
--   そのために「仕組みが1件だけ答える」道を用意する。
--   その道の**入口と待ち行列と保存先**を、この migration で作る。
--
--   Phase 1（20260911090000）で、回答に「何が答えたか」を持たせた。
--   ここで作るのは、その system という種別の回答を**作れる唯一の経路**である。
--
-- 【この段では、まだ何も自動で動かない】
--   ・外部の AI へはつながない。provider も SDK も呼ばない
--   ・作品を投稿しても、待ち行列へ自動では積まれない
--   ・でたらめな回答も、決め打ちの回答も、本番の機能として作らない
--   出所: ユーザー指示（2026-09-10）「まだ外部AIには接続しない。まだ投稿時に
--   自動enqueueしない。まだ利用者向けオンボーディングは有効化しない。」
--
--   この段で保存入口へ渡すのは、検査のときだけである。
--   「外部の AI がこの選択肢を選んだ」という結果だけを渡して動かす。
--
-- 【v1 の対象は prompt_first だけ】
--   お題を受け取る → 描く → 回答される → 結果を見る、の一周が初回体験であり、
--   art_first には最初の「お題を受け取る」が無い。
--   出所: ユーザー指示（2026-09-10）「v1の対象：prompt_firstのみ。」
--
--   実測: prompt_first / art_first は prompts.origin で分かれる。
--   origin は draft / saved / daily / art_first の4値
--   （20260908090000_art_first.sql の prompts_origin_check）。
--   つまり origin = 'art_first' が art_first、それ以外が prompt_first。
--   **新しい列は作らない。**
--
-- 【正解を渡す場所ではない】
--   保存入口が受け取るのは「どの問に、どの語を選んだか」だけ。
--   合っているかどうかは**この中で quiz_choices を見て決める。**
--   呼ぶ側から is_correct を渡させない。正解一覧も返さない。
--   出所: ユーザー指示（2026-09-10）「保存入口は『AIが選んだ選択肢を保存する
--   場所』であって、正解情報を供給する場所ではない。」
--
-- 【人間が先に答えたら、システムは作らない】
--   目的は「初回の回答ゼロを無くすこと」で、人間が答えたなら目的は済んでいる。
--   あとからシステムを足して分布へ混ぜない。待ち行列は取り消しで終える。
--   出所: ユーザー指示（2026-09-10）「system回答を保存する直前にhuman回答が
--   1件以上存在した場合：system回答を作らない。」
--
-- 【版番号の選び方】
--   使われている最大は 20260911090000（Phase 1。この作業木のみ、本番未適用）。
--   本番の履歴の最大は 20260910190000 で、これは別作業線が適用済みだった
--   （実測 2026-09-10。`supabase migration list --linked`）。
--   全作業木7つ・ローカル4ブランチ・リモート11ブランチ・本番履歴のどこにも
--   20260912090000 は無い。
--
-- 【触っていないもの】
--   draft_state_json / draft_sessions / draft_session_slots / prompt_cards /
--   shape_assist / sub_directive / draw・redo 系 / P0〜P5 の migration。
--   既存の関数も1本も差し替えていない。**足すだけ。**
--   submit_answer も works も prompts も、1文字も変えていない。

begin;

-- ── 1. 待ち行列の表 ──────────────────────────────────────
--
-- 【storage_cleanup_queue をそのまま写していない】
--   あちらは「消せたら deleted_at が入る」だけで、途中の状態が無い。
--   こちらは取り出して処理している最中があり、失敗して再び試すこともある。
--   だから状態を持つ。名前の付け方と権限の閉じ方だけ、あちらへ合わせた。
--
-- 【1つの作品につき、行は最大1つ】
--   同じ作品へ何度積んでも増えない。再び試すときは、この1行の状態を戻す。
--   出所: ユーザー指示（2026-09-10）「duplicate enqueueで新しいqueue行を
--   無制限に増やさない。」
--
-- 【作品を消したら、この行も消える】
--   回答（answers）が作品と一緒に消えるのと同じにしてある。
--   消えた作品の待ち行列だけが残っても、誰も拾えない。
--
--   **この表を「その人がもう初心者ではない印」として使わない。**
--   使うと、作品を1つ消しただけで初心者へ戻ってしまう。
--   初回体験の進み具合は、別の場所で持つ（この段では作らない）。
--   出所: ユーザー指示（2026-09-10）「『作品を削除したら初心者へ戻る』
--   挙動にはしない。queue履歴をオンボーディング状態そのものとして代用しない。」

create table if not exists public.system_answer_queue (
  id              bigint generated always as identity primary key,
  work_id         uuid not null
                  references public.works (id)
                  on update restrict on delete cascade,
  -- 誰の作品に対する仕事かを、作品を辿らずに分かるようにしておく。
  -- 作品が消えれば行ごと消えるが、その人の登録が消えた場合は
  -- works.user_id と同じく null になる（profiles の on delete set null）。
  owner_user_id   uuid
                  references public.profiles (id)
                  on update restrict on delete set null,
  status          text not null default 'pending',
  attempts        int  not null default 0,
  enqueued_at     timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_attempt_at timestamptz,
  last_error      text,
  constraint system_answer_queue_one_per_work unique (work_id),
  constraint system_answer_queue_status_valid
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  constraint system_answer_queue_attempts_positive check (attempts >= 0)
);

-- 取り出すときに見るのは「待っている行」だけ。何度も失敗した行は後ろへ回す
-- （storage_cleanup_queue と同じ考え方。壊れた1件で後ろが詰まらないように）。
create index if not exists system_answer_queue_pending_idx
  on public.system_answer_queue (attempts, enqueued_at)
  where status = 'pending';

alter table public.system_answer_queue enable row level security;
revoke all on public.system_answer_queue from public, anon, authenticated;

-- **RLS の方針を明示する。**
--   この表は security definer の関数からしか触らない。
--   利用者の役（anon / authenticated）には権限を1つも配っていないので、
--   直接 select / insert / update / delete のどれもできない。
--   許可の規則を1つも書かないことで「誰にも開いていない」状態にしてある。
comment on table public.system_answer_queue is
  'システム回答を作る仕事の待ち行列。1つの作品につき1行まで。'
  '積む・取り出す・終える、のどれも信頼されたサーバーからしか呼べない。'
  'この表を「初回体験が済んだ印」として使わないこと（作品を消すと消えるため）。';

comment on column public.system_answer_queue.status is
  'pending=待っている / processing=取り出して処理中 / completed=保存できた / '
  'failed=失敗した（戻せば再び試せる） / cancelled=作る必要が無くなった';

comment on column public.system_answer_queue.owner_user_id is
  'その作品の作者。作品を辿らずに「誰のための仕事か」を見るために持つ。'
  '登録が消えたら null になる（works.user_id と同じ）。';


-- ── 2. 状態を変えたら updated_at を進める ─────────────────
--
-- 呼ぶ側が書き忘れても必ず進むように、引き金で面倒を見る。

create or replace function public.system_answer_queue_touch()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists system_answer_queue_touch on public.system_answer_queue;
create trigger system_answer_queue_touch
  before update on public.system_answer_queue
  for each row execute function public.system_answer_queue_touch();


-- ── 3. 積む ─────────────────────────────────────────────
--
-- 【誰が呼べるか】
--   信頼されたサーバーだけ。anon にも authenticated にも配らない。
--   出所: ユーザー指示（2026-09-10）「anonから呼べない / authenticatedから
--   呼べない / trusted server/service-roleのみ」。
--
-- 【断る条件】
--   作品が無い／消されている／公開されていない／表示を止められている／
--   art_first ／もうシステム回答がある。
--   どれも**例外にせず false を返す。**積めなかったこと自体は異常ではなく、
--   呼ぶ側（将来の投稿処理）が止まる理由にならないため。
--   引数の形が壊れている場合だけ例外にする。

create or replace function public.enqueue_system_answer(p_work_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_work record;
begin
  if p_work_id is null then
    raise exception 'BAD_WORK: 作品の指定がありません。';
  end if;

  select w.id, w.user_id, w.prompt_id, w.is_published, w.review_status,
         w.deleted_at, p.origin
    into v_work
    from public.works w
    join public.prompts p on p.id = w.prompt_id
   where w.id = p_work_id;

  if not found then return false; end if;
  if v_work.deleted_at is not null then return false; end if;
  if not v_work.is_published then return false; end if;
  if v_work.review_status <> 'ok' then return false; end if;
  if v_work.origin = 'art_first' then return false; end if;

  -- もう回答が付いているなら、作る必要が無い。
  -- 人間の回答が1件でもあれば目的は済んでいるし、
  -- システム回答が既にあるなら二重に作れない（Phase 1 の索引が断る）。
  if exists (select 1 from public.answers a where a.work_id = p_work_id) then
    return false;
  end if;

  -- 1つの作品につき1行。すでに行があるなら、何もしないで false を返す。
  -- **新しい行を足さない。**再び試すのは retry_system_answer_job の仕事。
  insert into public.system_answer_queue (work_id, owner_user_id)
  values (p_work_id, v_work.user_id)
  on conflict (work_id) do nothing;

  return found;
end $fn$;

revoke all on function public.enqueue_system_answer(uuid) from public, anon, authenticated;
grant execute on function public.enqueue_system_answer(uuid) to service_role;

comment on function public.enqueue_system_answer(uuid) is
  'システム回答を作る仕事を1件積む。積めたら true。'
  '消された・公開されていない・表示を止められた・art_first・'
  'もう回答がある・すでに積んである場合は false（例外にしない）。';


-- ── 4. 取り出す ─────────────────────────────────────────
--
-- 【2人の働き手が同じ行を取らないこと】
--   待っている行を `for update skip locked` で押さえてから状態を進める。
--   押さえられた行は、もう一方からは見えない（飛ばされる）。
--   だから同じ行を2人が取ることはない。
--   出所: ユーザー指示（2026-09-10）「二つのworkerが同じ行を同時claimできない
--   こと。」

create or replace function public.claim_system_answer_jobs(p_limit int default 1)
returns table (id bigint, work_id uuid, owner_user_id uuid, attempts int)
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return query
  with picked as (
    select q.id
      from public.system_answer_queue q
     where q.status = 'pending'
     order by q.attempts asc, q.enqueued_at asc
     limit greatest(coalesce(p_limit, 1), 1)
       for update skip locked
  )
  update public.system_answer_queue q
     set status = 'processing',
         attempts = q.attempts + 1,
         last_attempt_at = now()
    from picked
   where q.id = picked.id
  returning q.id, q.work_id, q.owner_user_id, q.attempts;
end $fn$;

revoke all on function public.claim_system_answer_jobs(int) from public, anon, authenticated;
grant execute on function public.claim_system_answer_jobs(int) to service_role;

comment on function public.claim_system_answer_jobs(int) is
  '待っている仕事を取り出して処理中にする。押さえた行は他の働き手には見えない。'
  '取り出した時点で試行回数が1つ増える。';


-- ── 5. 保存する ─────────────────────────────────────────
--
-- 【受け取るもの】
--   作品と、「どの問に、どの語を選んだか」の一覧だけ。
--   submit_answer と同じ形の jsonb にしてある
--   （[{question_id, tag_id, tag_id_2?}, ...]）。
--
-- 【受け取らないもの】
--   正解かどうか、正式なお題の語、サブ指令、形状の手がかり、作者の言葉。
--   合否はこの中で quiz_choices を見て決める。
--
-- 【呼ぶ側を信じない】
--   保存する直前に、作品・お題・問・選択肢・重複・数を全部見直す。
--   人間の窓口（submit_answer）と同じ関門を通す。
--
-- 【まとめて成功するか、まとめて失敗するか】
--   回答の行と、その中身と、待ち行列の完了を1つの関数の中で行う。
--   途中で例外が出れば、この関数の中の変更は全部戻る
--   （PostgreSQL の関数は1つの塊として扱われる）。
--   だから「回答だけあって中身が無い」「完了なのに回答が無い」は起きない。

create or replace function public.save_system_answer(
  p_work_id uuid,
  p_selections jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_work           record;
  v_question_count int;
  v_sel_count      int;
  v_distinct_count int;
  v_valid_count    int;
  v_correct_count  int;
  v_exact_att      int;
  v_exact_cor      int;
  v_pair_att       int;
  v_pair_cor       int;
  v_answer_id      bigint;
begin
  if p_work_id is null then
    raise exception 'BAD_WORK: 作品の指定がありません。';
  end if;

  if p_selections is null or jsonb_typeof(p_selections) <> 'array' then
    raise exception 'BAD_SELECTIONS: 回答の形式が正しくありません。';
  end if;

  -- --- 作品を見直す -------------------------------------------------------
  select w.id, w.user_id, w.prompt_id, w.is_published, w.review_status,
         w.deleted_at, p.origin
    into v_work
    from public.works w
    join public.prompts p on p.id = w.prompt_id
   where w.id = p_work_id;

  if not found then
    raise exception 'WORK_NOT_FOUND: その作品は見つかりません。';
  end if;

  -- 消された・公開されていない・表示を止められた・art_first。
  -- どれも「作る必要が無くなった」なので、待ち行列は取り消しで終える。
  -- **作品そのものには1文字も触らない。**
  if v_work.deleted_at is not null
     or not v_work.is_published
     or v_work.review_status <> 'ok'
     or v_work.origin = 'art_first' then
    update public.system_answer_queue q
       set status = 'cancelled',
           last_error = 'WORK_NOT_ELIGIBLE'
     where q.work_id = p_work_id
       and q.status in ('pending', 'processing', 'failed');
    return false;
  end if;

  -- --- 人間が先に答えていたら、作らない -----------------------------------
  --
  -- 目的は「初回の回答ゼロを無くすこと」。人間が答えたなら済んでいる。
  if exists (
    select 1 from public.answers a
     where a.work_id = p_work_id and a.answer_source = 'human'
  ) then
    update public.system_answer_queue q
       set status = 'cancelled',
           last_error = 'HUMAN_ANSWERED_FIRST'
     where q.work_id = p_work_id
       and q.status in ('pending', 'processing', 'failed');
    return false;
  end if;

  -- --- もうシステム回答がある ---------------------------------------------
  if exists (
    select 1 from public.answers a
     where a.work_id = p_work_id and a.answer_source = 'system'
  ) then
    update public.system_answer_queue q
       set status = 'completed',
           last_error = null
     where q.work_id = p_work_id
       and q.status in ('pending', 'processing', 'failed');
    return false;
  end if;

  -- --- 問の数と、渡ってきた数 ---------------------------------------------
  select count(*) into v_question_count
    from public.quiz_questions q
   where q.prompt_id = v_work.prompt_id;

  if v_question_count = 0 then
    raise exception 'NO_QUESTIONS: この作品のお題には問がありません。';
  end if;

  select count(*), count(distinct (x ->> 'question_id'))
    into v_sel_count, v_distinct_count
    from jsonb_array_elements(p_selections) x;

  if v_sel_count <> v_question_count then
    raise exception 'INCOMPLETE_ANSWER: %問すべてに答えてください（いま %問）。',
      v_question_count, v_sel_count;
  end if;

  if v_distinct_count <> v_sel_count then
    raise exception 'DUPLICATE_QUESTION: 同じ問に2回答えることはできません。';
  end if;

  -- --- 選んだ語が、その問の選択肢の中にあるか ------------------------------
  --
  -- 他の作品の問を混ぜても、ここで数が合わなくなって落ちる
  -- （問がこのお題のものであることを join の条件で見ている）。
  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  )
  select count(*)
    into v_valid_count
    from sel s
    join public.quiz_questions q
      on q.id = s.qid and q.prompt_id = v_work.prompt_id
   where exists (select 1 from public.quiz_choices c
                  where c.question_id = q.id and c.tag_id = s.t1)
     and (
       s.t2 is null
       or (s.t2 <> s.t1
           and exists (select 1 from public.quiz_choices c
                        where c.question_id = q.id and c.tag_id = s.t2))
     );

  if v_valid_count <> v_sel_count then
    raise exception
      'BAD_SELECTION: 選択肢にない答えが含まれています。'
      '2択当てで同じ語を2回選ぶこともできません。';
  end if;

  -- --- 採点する（合否はここで決める。渡させない）--------------------------
  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  ),
  scored as (
    select s.qid,
           (s.t2 is not null) as is_pair,
           exists (select 1 from public.quiz_choices c
                    where c.question_id = s.qid
                      and c.is_correct
                      and (c.tag_id = s.t1 or c.tag_id = s.t2)) as ok
      from sel s
  )
  select count(*) filter (where ok),
         count(*) filter (where not is_pair),
         count(*) filter (where not is_pair and ok),
         count(*) filter (where is_pair),
         count(*) filter (where is_pair and ok)
    into v_correct_count, v_exact_att, v_exact_cor, v_pair_att, v_pair_cor
    from scored;

  -- --- 保存する -----------------------------------------------------------
  --
  -- 【答えた人は置かない】
  --   user_id は null。システムを人の顔として見せないため。
  --   実測: answers.user_id はもともと null を許す列で、profiles への
  --   外部キーは on delete set null。つまり null は既存の形の中にある。
  --   人間の「1人1回」（UNIQUE(work_id, user_id)）は null 同士を
  --   重複と見なさないので邪魔をせず、システムの1件までは
  --   Phase 1 の answers_one_system_per_work が受け持つ。
  --
  -- 【ヒントは使っていない】
  --   ヒントは人が作者の言葉を開いた記録から決まる。仕組みは開かない。
  insert into public.answers
    (work_id, user_id, correct_count, hint_used, question_count,
     exact_attempts, exact_corrects, pair_attempts, pair_corrects,
     scoring_version, answer_source)
  values
    (p_work_id, null, v_correct_count, false, v_question_count,
     v_exact_att, v_exact_cor, v_pair_att, v_pair_cor,
     'v2_all_words', 'system')
  returning id into v_answer_id;

  with sel as (
    select (x ->> 'question_id')::bigint          as qid,
           (x ->> 'tag_id')::bigint               as t1,
           nullif(x ->> 'tag_id_2', '')::bigint   as t2
      from jsonb_array_elements(p_selections) x
  )
  insert into public.answer_items
    (answer_id, question_id, card_slot_key, selected_tag_id, selected_tag_id_2,
     answer_mode, is_correct)
  select v_answer_id,
         q.id,
         q.card_slot_key,
         s.t1,
         s.t2,
         case when s.t2 is null then 'exact' else 'pair' end,
         exists (select 1 from public.quiz_choices c
                  where c.question_id = q.id
                    and c.is_correct
                    and (c.tag_id = s.t1 or c.tag_id = s.t2))
    from sel s
    join public.quiz_questions q
      on q.id = s.qid and q.prompt_id = v_work.prompt_id;

  -- 待ち行列があれば完了にする。無くても保存は成立する
  -- （将来、待ち行列を通さず直接呼ぶ道があってもよいように）。
  update public.system_answer_queue q
     set status = 'completed', last_error = null
   where q.work_id = p_work_id;

  return true;
end $fn$;

revoke all on function public.save_system_answer(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_system_answer(uuid, jsonb) to service_role;

comment on function public.save_system_answer(uuid, jsonb) is
  'システム回答を1件だけ保存する。受け取るのは「どの問にどの語を選んだか」だけで、'
  '合否はこの中で決める。人間が先に答えていた場合・作品が対象外になった場合は'
  '保存せず false を返し、待ち行列を終わらせる。';


-- ── 6. 失敗の印 ─────────────────────────────────────────

create or replace function public.mark_system_answer_failed(
  p_work_id uuid,
  p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_rows int;
begin
  update public.system_answer_queue q
     set status = 'failed',
         last_error = left(coalesce(p_error, ''), 500)
   where q.work_id = p_work_id
     and q.status = 'processing';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;

revoke all on function public.mark_system_answer_failed(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_system_answer_failed(uuid, text) to service_role;


-- ── 7. 取り消し ─────────────────────────────────────────

create or replace function public.cancel_system_answer_job(
  p_work_id uuid,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_rows int;
begin
  update public.system_answer_queue q
     set status = 'cancelled',
         last_error = left(coalesce(p_reason, ''), 500)
   where q.work_id = p_work_id
     and q.status in ('pending', 'processing', 'failed');
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;

revoke all on function public.cancel_system_answer_job(uuid, text) from public, anon, authenticated;
grant execute on function public.cancel_system_answer_job(uuid, text) to service_role;


-- ── 8. もう一度試せるようにする ─────────────────────────
--
-- **自動では戻さない。**何度でも勝手に試し続ける形にしない。
-- 上限の回数はまだ決めていないので、ここでは上限を見ない。
-- 出所: ユーザー指示（2026-09-10）「最終retry回数はまだ決めない。
-- 自動無限retryは作らない。」

create or replace function public.retry_system_answer_job(p_work_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare v_rows int;
begin
  update public.system_answer_queue q
     set status = 'pending'
   where q.work_id = p_work_id
     and q.status = 'failed';
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end $fn$;

revoke all on function public.retry_system_answer_job(uuid) from public, anon, authenticated;
grant execute on function public.retry_system_answer_job(uuid) to service_role;


-- ── 9. 様子を読む ───────────────────────────────────────
--
-- 待ち行列の中身を、信頼されたサーバーから確かめるための窓。
-- 表を直接開けないので、状態を見る道が1つ要る。

create or replace function public.get_system_answer_job(p_work_id uuid)
returns table (
  id bigint, work_id uuid, owner_user_id uuid, status text,
  attempts int, enqueued_at timestamptz, updated_at timestamptz,
  last_attempt_at timestamptz, last_error text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select q.id, q.work_id, q.owner_user_id, q.status, q.attempts,
         q.enqueued_at, q.updated_at, q.last_attempt_at, q.last_error
    from public.system_answer_queue q
   where q.work_id = p_work_id
$fn$;

revoke all on function public.get_system_answer_job(uuid) from public, anon, authenticated;
grant execute on function public.get_system_answer_job(uuid) to service_role;


-- ── 10. ここまでを自分で検算する ────────────────────────
--
-- 当てた直後に、この migration が意図どおりの形になったかを数える。
-- 1つでも合わなければ、この migration ごと巻き戻る。

do $check$
declare
  v int;
  v_txt text;
begin
  -- (1) 表がある
  select count(*) into v from information_schema.tables
   where table_schema = 'public' and table_name = 'system_answer_queue';
  if v <> 1 then raise exception '検算1: 待ち行列の表が %件', v; end if;

  -- (2) 1つの作品につき1行
  select count(*) into v from pg_constraint
   where conrelid = 'public.system_answer_queue'::regclass
     and conname = 'system_answer_queue_one_per_work';
  if v <> 1 then raise exception '検算2: 作品ごとの一意が %件', v; end if;

  -- (3) 状態は5つだけ
  select pg_get_constraintdef(oid) into v_txt from pg_constraint
   where conrelid = 'public.system_answer_queue'::regclass
     and conname = 'system_answer_queue_status_valid';
  if v_txt is null
     or v_txt not like '%pending%' or v_txt not like '%processing%'
     or v_txt not like '%completed%' or v_txt not like '%failed%'
     or v_txt not like '%cancelled%' then
    raise exception '検算3: 状態の許可値が合わない（%）', v_txt;
  end if;

  -- (4) 行の高さの守り（RLS）が入っている
  select count(*) into v from pg_class
   where oid = 'public.system_answer_queue'::regclass and relrowsecurity;
  if v <> 1 then raise exception '検算4: 行の守りが入っていない'; end if;

  -- (5) 利用者の役には、表の権限が1つも無い
  select count(*) into v from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'system_answer_queue'
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v <> 0 then raise exception '検算5: 利用者の役に表の権限が %件', v; end if;

  -- (6) 7本の関数が、信頼されたサーバーにだけ配られている
  select count(*) into v
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('enqueue_system_answer', 'claim_system_answer_jobs',
                       'save_system_answer', 'mark_system_answer_failed',
                       'cancel_system_answer_job', 'retry_system_answer_job',
                       'get_system_answer_job');
  if v <> 7 then raise exception '検算6: 窓口が %本（7本のはず）', v; end if;

  select count(*) into v
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('enqueue_system_answer', 'claim_system_answer_jobs',
                          'save_system_answer', 'mark_system_answer_failed',
                          'cancel_system_answer_job', 'retry_system_answer_job',
                          'get_system_answer_job')
     and grantee in ('anon', 'authenticated', 'PUBLIC');
  if v <> 0 then raise exception '検算7: 利用者の役に窓口の権限が %件', v; end if;

  select count(*) into v
    from information_schema.routine_privileges
   where routine_schema = 'public'
     and routine_name in ('enqueue_system_answer', 'claim_system_answer_jobs',
                          'save_system_answer', 'mark_system_answer_failed',
                          'cancel_system_answer_job', 'retry_system_answer_job',
                          'get_system_answer_job')
     and grantee = 'service_role';
  if v <> 7 then raise exception '検算8: サーバーへの配りが %件（7件のはず）', v; end if;

  -- (9) Phase 1 の守りが生きたまま
  select count(*) into v from pg_indexes
   where schemaname = 'public' and indexname = 'answers_one_system_per_work';
  if v <> 1 then raise exception '検算9: 1作品1システム回答の索引が %件', v; end if;

  -- (10) 人間の窓口は、いまも種別を引数に取らない
  select count(*) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'submit_answer'
     and pg_get_function_identity_arguments(p.oid) = 'p_work_id uuid, p_selections jsonb';
  if v <> 1 then raise exception '検算10: 人間の窓口の引数が変わっている'; end if;

  -- (11) システム回答はまだ1件も無い
  select count(*) into v from public.answers where answer_source = 'system';
  if v <> 0 then raise exception '検算11: システム回答が既に %件ある', v; end if;

  -- (12) 待ち行列も空
  select count(*) into v from public.system_answer_queue;
  if v <> 0 then raise exception '検算12: 待ち行列に %件ある', v; end if;

  raise notice '検算: 12項目すべて合いました';
end $check$;

commit;
