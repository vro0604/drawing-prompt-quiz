-- ============================================================================
-- 20260907093000 ／ 開示した枠は引き直せない・お題の放棄と明示開示
-- ============================================================================
--
-- 出所: ユーザー指示（2026-09-07 の続き）。決定記録は D171。
--
-- 【前回の取りこぼしを塞ぐ】
--   D170 で「枠の残りを開示したら、その枠の抽選は終わり」と決めたのに、
--   引き直し（reroll_draft）は世代を進めて全部作り直していた。
--   **開示したあと引き直せば、新しい候補をもう一式見られる。**
--   固定総ドラフト基数を超えて候補を見る抜け道になっていた（実測: 前回の報告）。
--
-- 【もう1つ、仕様書にあって実装が無かったもの】
--   spec 4-4 は開示の契機を3つ書いているが、実装は投稿完了の1つだけだった。
--   お題を放棄する操作そのものが存在しなかった（実測: prompts.status を
--   'abandoned' にする関数が1本も無い）。今回それを作る。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 開示した枠があるドラフトは引き直せない（D171）
-- ----------------------------------------------------------------------------
--
-- 引き直しはドラフト全体を作り直す操作なので、1枠でも開示していれば断る。
-- **画面で隠すだけにしない。**RPC を直接叩いても同じところで止まる。

create or replace function public.reroll_draft(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_session  record;
  v_revealed int;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select ds.id, ds.status, ds.mode_key, ds.candidate_count,
         ds.max_rerolls, ds.reroll_count, ds.current_generation
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

  -- 【ここが今回の追加】
  --   残りを開いた枠が1つでもあれば、引き直しは断る。
  --   開いた時点でその枠の抽選は終わっている（D170）。
  --   引き直すと新しい候補が出てしまい、決めた約束が壊れる。
  select count(*) into v_revealed
    from public.draft_session_slots s
   where s.session_id = p_session_id
     and s.generation = v_session.current_generation
     and s.pool_revealed_at is not null;

  if v_revealed > 0 then
    raise exception
      'POOL_ALREADY_REVEALED: 候補の残りを開いた枠があるので、'
      'このお題はもう引き直せません。開いた候補の中から1枚選んでください。';
  end if;

  if v_session.reroll_count >= v_session.max_rerolls then
    raise exception 'NO_REROLL_LEFT: 引き直せる回数が残っていません。';
  end if;

  update public.draft_sessions ds
     set reroll_count       = ds.reroll_count + 1,
         current_generation = ds.current_generation + 1,
         current_slot_order = 1
   where ds.id = p_session_id;

  perform public.draft_generate_candidates(
    p_session_id,
    v_session.current_generation + 1,
    v_session.mode_key,
    v_session.candidate_count);

  return public.draft_state_json(p_session_id);
end;
$fn$;

comment on function public.reroll_draft(uuid) is
  'ドラフト全体を引き直す。**残りを開いた枠があるときは断る**（D171）。';


-- ----------------------------------------------------------------------------
-- 2. 制作中の開示は、お題の列へ書かない（D171 の判断）
-- ----------------------------------------------------------------------------
--
-- D170 で prompts.reveal_reason に 'in_progress' を足したが、**使わないので外す。**
--
-- 【なぜ枠側だけで足りるか】
--   ・セッションの復元      draft_session_slots.pool_revealed_at で足りる
--   ・引き直しの禁止判定    同上（上の関数がそれを見ている）
--   ・あとから追跡          prompts.draft_session_id から枠へ辿れる
--
--   prompts.reveal_reason は「そのお題の未選択候補を、お題ごと開示したか」を
--   表す列で、制作中の**枠単位**の開示とは粒度が違う。
--   同じ列に入れると、投稿後の開示と制作中の開示が同じ意味に見える。

alter table public.prompts
  drop constraint if exists prompts_reveal_reason_valid;
alter table public.prompts
  add constraint prompts_reveal_reason_valid check (
    reveal_reason is null
    or reveal_reason in ('work_submitted', 'abandoned', 'manual')
  );


-- ----------------------------------------------------------------------------
-- 3. お題を放棄する（spec 4-4 の 'abandoned'）
-- ----------------------------------------------------------------------------
--
-- 「このお題は描かない」を押したときの処理。**今まで存在しなかった。**
-- 放棄したお題は作品を作れなくなり、そのかわり未選択候補が開く。
--
-- 開示は本人にしか見えない。get_my_prompt が auth.uid() で絞っているためで、
-- ここでその規則を変えていない。

create or replace function public.abandon_prompt(p_prompt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select p.id, p.status, p.created_by
    into v_row
    from public.prompts p
   where p.id = p_prompt_id;

  if not found or v_row.created_by is distinct from v_uid then
    raise exception 'PROMPT_NOT_FOUND: そのお題は見つかりません。';
  end if;

  if v_row.status = 'submitted' then
    raise exception
      'ALREADY_SUBMITTED: このお題ではもう作品を投稿しています。放棄できません。';
  end if;

  -- 二度押しても壊れない。すでに放棄済みなら、そのまま今の状態を返す
  if v_row.status <> 'abandoned' then
    update public.prompts p
       set status                 = 'abandoned',
           abandoned_at           = clock_timestamp(),
           candidates_revealed_at = coalesce(p.candidates_revealed_at,
                                             clock_timestamp()),
           reveal_reason          = coalesce(p.reveal_reason, 'abandoned')
     where p.id = p_prompt_id;
  end if;

  return public.get_my_prompt(p_prompt_id);
end;
$fn$;

comment on function public.abandon_prompt(uuid) is
  'お題を放棄する（spec 4-4 / D171）。未選択候補が開く。本人にしか見えない。';

revoke all on function public.abandon_prompt(uuid) from public, anon, authenticated;
grant execute on function public.abandon_prompt(uuid) to authenticated;


-- ----------------------------------------------------------------------------
-- 4. 他の候補を見る（spec 4-4 の 'manual'）
-- ----------------------------------------------------------------------------
--
-- 放棄せずに未選択候補だけ開く。**開いても投稿は引き続きできる**（spec 仮定A9）。
--
-- 制作中の開示（D170）とは別物。あちらはドラフトの最中に枠1つぶんを開くもので、
-- こちらはお題が確定したあとにお題ごと開くもの。時点も範囲も違う。

create or replace function public.reveal_prompt_candidates(p_prompt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_uid uuid := (select auth.uid());
  v_row record;
begin
  if v_uid is null then
    raise exception 'NOT_SIGNED_IN: サインインが必要です。';
  end if;

  select p.id, p.status, p.created_by, p.candidates_revealed_at
    into v_row
    from public.prompts p
   where p.id = p_prompt_id;

  if not found or v_row.created_by is distinct from v_uid then
    raise exception 'PROMPT_NOT_FOUND: そのお題は見つかりません。';
  end if;

  if v_row.candidates_revealed_at is null then
    update public.prompts p
       set candidates_revealed_at = clock_timestamp(),
           reveal_reason          = 'manual'
     where p.id = p_prompt_id;
  end if;

  return public.get_my_prompt(p_prompt_id);
end;
$fn$;

comment on function public.reveal_prompt_candidates(uuid) is
  '他の候補を見る（spec 4-4 の manual / D171）。開いても投稿は続けられる。';

revoke all on function public.reveal_prompt_candidates(uuid)
  from public, anon, authenticated;
grant execute on function public.reveal_prompt_candidates(uuid) to authenticated;
