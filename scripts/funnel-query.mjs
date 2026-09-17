/**
 * funnel-query.mjs ／ 初回利用の進みぐあいを、いまの表だけから数える問い合わせ
 *
 * 【何のためか】
 *   トップを作り直した（D207 / D208）あと、「来た人がどこまで進んだか」を
 *   推測ではなく DB の行から言えるようにする。
 *   **新しい記録の仕組みは1つも足していない。**すでに書き込みで残っている行
 *   （profiles / draft_sessions / prompts / works / answers / terms_agreements）を
 *   数え直すだけ。閲覧の記録は取っていないので、閲覧は数えない。
 *
 * 【ここに SQL を置く理由】
 *   本番を読む道具（scripts/db-funnel.mjs）と、使い捨ての DB で数え方そのものを
 *   試す試験（test/tools/run.mjs）が、**同じ1本の SQL を使う**ため。
 *   別々に書くと、試験が通っても本番で違う数を出す。
 *
 * ---------------------------------------------------------------------------
 * 【人が生まれる場所（ここが分母の意味を決める）】
 *   このサービスは、ページを開いただけでは利用者の行を作らない。
 *   `ensureUserId()` を呼ぶ操作（src/features/auth/session.ts）で初めて
 *   匿名の利用者が発行される。呼んでいるのは2か所だけ:
 *     ・お題のドラフトを始める（src/app/play/actions.ts）
 *     ・作品に答える・通報するなど（src/app/works/[id]/actions.ts）
 *
 *   つまり profiles の1行は「初めて何かを書き込んだ人」であって、
 *   「トップを見た人」ではない。**だから「トップ閲覧者の何％」は作れない。**
 *   この道具が出す率は、すべて「DB に現れた人」を分母にしている。
 *
 * 【最初の入口で2つに分ける】
 *   ドラフト開始が先なら creator、回答が先なら answerer。
 *   どちらの行も無い人は unknown（行が残っていないだけのこともある）。
 *   人が発行される操作がそのまま最初の段なので、
 *   **creator の「人の発生 → ドラフト開始」は、ほぼ同時に起きる。**
 *   落ちる場所を見るのはその次の段から。
 *
 * 【消えた人の行は数えられない】
 *   退会・掃除で profiles の行が消えると、その人の works / prompts /
 *   answers は残るが、持ち主の列が null になる（外部キーが set null）。
 *   2026-09-18 の本番では works 621件のうち 618件が持ち主なしだった。
 *   **この道具は「いま残っている人」しか数えない。**
 *   期間が長いほど、掃除で消えた人のぶん母数が小さく出る。
 *
 * 【お題を先に引く／絵を先に出す】
 *   prompts.origin が 'art_first' かどうかで分ける（spec 20-1 と同じ判定）。
 *   'draft' / 'saved' / 'daily' は、お題が先なので prompt_first にまとめる。
 * ---------------------------------------------------------------------------
 */

/** 期間の指定。`--period` に渡せる語と、何日ぶんか */
export const PERIODS = [
  { key: "24h", label: "過去24時間", hours: 24 },
  { key: "7d", label: "過去7日", hours: 24 * 7 },
  { key: "30d", label: "過去30日", hours: 24 * 30 },
  { key: "all", label: "全期間", hours: null },
];

/**
 * 1期間ぶんの数を1行で返す SQL。
 *
 * $1 … この時刻より後に発行された人だけを見る（null なら全期間）。
 *
 * **SELECT しかしない。**関数も呼ばない。読み取り専用の取引の中で流せる。
 */
export const FUNNEL_SQL = `
with
-- 期間内に発行された人（＝初めて書き込んだ人）
actor as (
  select p.id, p.created_at, p.is_anonymous
    from public.profiles p
   where $1::timestamptz is null or p.created_at >= $1::timestamptz
),

-- ドラフト（お題を引き始めた記録）
d as (
  select user_id as uid, min(created_at) as at, count(*)::int as n
    from public.draft_sessions
   where user_id is not null
   group by 1
),

-- 確定したお題。行ができるのは「このお題で確定する」を押した瞬間
pr as (
  select created_by as uid,
         min(created_at) filter (where origin is distinct from 'art_first') as pf_at,
         min(created_at) filter (where origin = 'art_first') as af_at
    from public.prompts
   where created_by is not null
   group by 1
),

-- 投稿した作品。1件ずつ「お題が先か絵が先か」を付け、回答の数も数える
wk as (
  select w.user_id as uid,
         case when p.origin = 'art_first' then 'art_first' else 'prompt_first' end as kind,
         w.created_at,
         w.result_seen_at,
         (select count(*) from public.answers a
           where a.work_id = w.id and a.answer_source = 'human')::int as human_n,
         (select count(*) from public.answers a
           where a.work_id = w.id and a.answer_source = 'system')::int as system_n
    from public.works w
    join public.prompts p on p.id = w.prompt_id
   where w.user_id is not null
),
w as (
  select uid,
         min(created_at) filter (where kind = 'prompt_first') as pf_at,
         min(created_at) filter (where kind = 'art_first') as af_at,
         count(*) filter (where kind = 'prompt_first')::int as pf_works,
         count(*) filter (where kind = 'art_first')::int as af_works,
         count(*) filter (where kind = 'prompt_first' and human_n > 0)::int as pf_human,
         count(*) filter (where kind = 'art_first' and human_n > 0)::int as af_human,
         count(*) filter (where kind = 'prompt_first' and system_n > 0)::int as pf_system,
         count(*) filter (where kind = 'art_first' and system_n > 0)::int as af_system,
         count(*) filter (where kind = 'prompt_first' and result_seen_at is not null)::int as pf_seen,
         count(*) filter (where kind = 'art_first' and result_seen_at is not null)::int as af_seen
    from wk
   group by 1
),

-- 自分が送った回答（人が答えたものだけ）
an as (
  select user_id as uid, count(*)::int as n, min(created_at) as at
    from public.answers
   where user_id is not null and answer_source = 'human'
   group by 1
),

-- 規約・方針への同意。登録のときに記録されるので、登録時刻の近似に使う
ag as (
  select user_id as uid, min(agreed_at) as at
    from public.terms_agreements
   where user_id is not null
   group by 1
),

person as (
  select a.id,
         a.created_at,
         (not a.is_anonymous) as registered,
         d.at as draft_at,
         pr.pf_at as prompt_pf_at,
         pr.af_at as prompt_af_at,
         w.pf_at as work_pf_at,
         w.af_at as work_af_at,
         coalesce(w.pf_human, 0) as pf_human,
         coalesce(w.af_human, 0) as af_human,
         coalesce(w.pf_system, 0) as pf_system,
         coalesce(w.af_system, 0) as af_system,
         coalesce(w.pf_seen, 0) as pf_seen,
         coalesce(w.af_seen, 0) as af_seen,
         coalesce(an.n, 0) as answers_n,
         an.at as first_answer_at,
         ag.at as agreed_at,
         case
           when d.at is not null and (an.at is null or d.at <= an.at) then 'creator'
           when an.at is not null then 'answerer'
           else 'unknown'
         end as entry
    from actor a
    left join d  on d.uid  = a.id
    left join pr on pr.uid = a.id
    left join w  on w.uid  = a.id
    left join an on an.uid = a.id
    left join ag on ag.uid = a.id
)

select json_build_object(
  'actors', json_build_object(
    'total',      count(*)::int,
    'guest',      count(*) filter (where not registered)::int,
    'registered', count(*) filter (where registered)::int,
    'entry_creator',  count(*) filter (where entry = 'creator')::int,
    'entry_answerer', count(*) filter (where entry = 'answerer')::int,
    'entry_unknown',  count(*) filter (where entry = 'unknown')::int
  ),

  -- お題が先の作り手。分母は「ドラフトから入った人」
  'creator_prompt_first', json_build_object(
    'actor',        count(*) filter (where entry = 'creator')::int,
    'draft',        count(*) filter (where entry = 'creator' and draft_at is not null)::int,
    'prompt',       count(*) filter (where entry = 'creator' and prompt_pf_at is not null)::int,
    'work',         count(*) filter (where entry = 'creator' and work_pf_at is not null)::int,
    'human_answer', count(*) filter (where entry = 'creator' and pf_human > 0)::int,
    'result_seen',  count(*) filter (where entry = 'creator' and pf_seen > 0)::int,
    'system_answer',count(*) filter (where entry = 'creator' and pf_system > 0)::int
  ),

  -- 絵が先（持ち込み）。入口では分けずに、期間内の人ぜんぶから数える
  'creator_art_first', json_build_object(
    'actor',        count(*)::int,
    'prompt',       count(*) filter (where prompt_af_at is not null)::int,
    'work',         count(*) filter (where work_af_at is not null)::int,
    'human_answer', count(*) filter (where af_human > 0)::int,
    'result_seen',  count(*) filter (where af_seen > 0)::int,
    'system_answer',count(*) filter (where af_system > 0)::int
  ),

  -- 答える側。分母は「回答から入った人」
  'answerer', json_build_object(
    'actor',  count(*) filter (where entry = 'answerer')::int,
    'a1',     count(*) filter (where entry = 'answerer' and answers_n >= 1)::int,
    'a2',     count(*) filter (where entry = 'answerer' and answers_n >= 2)::int,
    'a3',     count(*) filter (where entry = 'answerer' and answers_n >= 3)::int,
    'a5',     count(*) filter (where entry = 'answerer' and answers_n >= 5)::int
  ),

  -- 登録。いまの状態は正確、登録した時刻は同意の記録からの近似
  'registration', json_build_object(
    'actor',            count(*)::int,
    'registered_now',   count(*) filter (where registered)::int,
    'with_agreement',   count(*) filter (where registered and agreed_at is not null)::int,
    'registered_work',  count(*) filter (where registered and (work_pf_at is not null or work_af_at is not null))::int,
    'guest_with_prompt',count(*) filter (where not registered and (prompt_pf_at is not null or prompt_af_at is not null))::int
  ),

  -- ゲストのままの人と登録した人で、作り手の段がどう違うか
  'by_identity', json_build_object(
    'guest_draft',       count(*) filter (where not registered and draft_at is not null)::int,
    'guest_prompt',      count(*) filter (where not registered and prompt_pf_at is not null)::int,
    'guest_work',        count(*) filter (where not registered and work_pf_at is not null)::int,
    'registered_draft',  count(*) filter (where registered and draft_at is not null)::int,
    'registered_prompt', count(*) filter (where registered and prompt_pf_at is not null)::int,
    'registered_work',   count(*) filter (where registered and work_pf_at is not null)::int
  )
) as result
  from person
`;

/** 期間の語から、いつより後を見るかを決める。all は null（全期間） */
export function cutoffFor(periodKey, now = new Date()) {
  const period = PERIODS.find((p) => p.key === periodKey);
  if (!period) throw new Error(`知らない期間です: ${periodKey}`);
  if (period.hours === null) return null;
  return new Date(now.getTime() - period.hours * 3600 * 1000);
}

/** 「3 / 7 = 42.9%」の形。母数が0のときは率を出さない（0除算を書かない） */
export function ratio(numerator, denominator) {
  if (!denominator) return `${numerator} / ${denominator}`;
  const pct = (numerator / denominator) * 100;
  return `${numerator} / ${denominator} = ${pct.toFixed(1)}%`;
}

/** 段の並び。ラベルと、JSON のどの鍵かの対応 */
const CREATOR_STAGES = [
  ["人が発行された（最初の書き込み）", "actor"],
  ["ドラフトを始めた", "draft"],
  ["お題を確定した", "prompt"],
  ["作品を投稿した", "work"],
  ["人からの回答が付いた", "human_answer"],
  ["結果を開いた", "result_seen"],
];

const ART_FIRST_STAGES = [
  ["期間内に発行された人", "actor"],
  ["持ち込みのお題ができた", "prompt"],
  ["持ち込みの作品を投稿した", "work"],
  ["人からの回答が付いた", "human_answer"],
  ["結果を開いた", "result_seen"],
];

const ANSWERER_STAGES = [
  ["人が発行された（最初の書き込み）", "actor"],
  ["1回答えた", "a1"],
  ["2回答えた", "a2"],
  ["3回答えた", "a3"],
  ["5回以上答えた", "a5"],
];

function stageLines(stages, data) {
  const lines = [];
  let previous = null;
  for (const [label, key] of stages) {
    const n = data[key] ?? 0;
    const tail = previous === null ? `${n} 人` : `${ratio(n, previous)}（前の段から）`;
    lines.push(`    ${label.padEnd(20, "　")} ${tail}`);
    previous = n;
  }
  return lines;
}

/** 1期間ぶんを人が読める形にする */
export function formatPeriod(periodKey, data) {
  const period = PERIODS.find((p) => p.key === periodKey);
  const out = [];
  out.push(`\n── ${period.label}（${periodKey}）────────────────────────────`);

  const a = data.actors;
  out.push(
    `  DB に現れた人: ${a.total} 人` +
      `（ゲストのまま ${a.guest} / 登録済み ${a.registered}）` +
      `　入口: 作る ${a.entry_creator} ／ 答える ${a.entry_answerer} ／ 不明 ${a.entry_unknown}`,
  );

  out.push("  [1] 作る側・お題が先（prompt_first）");
  out.push(...stageLines(CREATOR_STAGES, data.creator_prompt_first));
  if (data.creator_prompt_first.system_answer > 0) {
    out.push(`    （うち仕組みの回答が付いた人: ${data.creator_prompt_first.system_answer} 人）`);
  }

  out.push("  [2] 作る側・絵が先（art_first）");
  out.push(...stageLines(ART_FIRST_STAGES, data.creator_art_first));

  out.push("  [3] 答える側");
  out.push(...stageLines(ANSWERER_STAGES, data.answerer));

  const r = data.registration;
  out.push("  [4] 登録");
  out.push(`    いま登録済み          ${ratio(r.registered_now, r.actor)}`);
  out.push(`    うち同意の記録あり    ${ratio(r.with_agreement, r.registered_now)}`);
  out.push(`    うち作品を投稿        ${ratio(r.registered_work, r.registered_now)}`);
  out.push(`    ゲストのままお題を確定 ${ratio(r.guest_with_prompt, r.actor - r.registered_now)}`);

  const b = data.by_identity;
  out.push("  [5] ゲストと登録済みの違い（お題が先の作り手）");
  out.push(
    `    ゲスト   ドラフト ${b.guest_draft} → お題 ${b.guest_prompt} → 投稿 ${b.guest_work}`,
  );
  out.push(
    `    登録済み ドラフト ${b.registered_draft} → お題 ${b.registered_prompt} → 投稿 ${b.registered_work}`,
  );
  return out.join("\n");
}

/** この道具では測れないもの。**数字と一緒に必ず出す** */
export const LIMITS = [
  "トップを見ただけの人は数えられない（閲覧の記録を取っていない）。だから「トップ閲覧者の何％」は出していない。",
  "「お題を引く」「答える」を押しただけも数えられない。人の行ができるのは、引き始める・答えるなど書き込みが起きた瞬間。",
  "他人の作品を開いただけ・途中でやめた、も数えられない。",
  "退会・掃除で消えた人の行動は数に入らない（行は残るが持ち主の列が null になる）。期間が長いほど母数は小さく出る。",
  "「結果を開いた」は works.result_seen_at。列ができたのは 2026-09-10 なので、それより前に開いた分は残っていない。",
  "検査（スモーク）が作ったゲストは、本物のゲストと見分けられない。登録した検査用の利用者だけは電子メールの形で見分けられる。",
];
