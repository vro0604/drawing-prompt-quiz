/**
 * _smoke-baseline.mjs ／ スモークの前後で、本番の件数が元に戻ったかを数える
 *
 * 【なぜ要るか】
 *   片づけが「できたつもり」になっていないかを、件数で確かめる。
 *   スモークは自分で「消しました」と言えるが、それは頼んだ相手の返事であって、
 *   本番に何が残ったかではない。**前と後で同じ数であること**だけが証拠になる。
 *
 * 【何を数えるか】
 *   D209 の初回利用ファネルが分母と段に使う表そのもの（docs/funnel-v0.md）。
 *   ここが増えたままなら、次に測る数字が汚れる。
 *     auth_users        … 認証の口にある人の数（ゲストを含む）
 *     profiles          … サービス側の人の行。ファネルの分母
 *     draft_sessions    … ドラフト開始
 *     prompts           … お題の確定
 *     works             … 作品の投稿
 *     answers           … 回答
 *     usage_events      … 「共有した」「次の作品へ」の記録
 *     terms_agreements  … 同意の記録
 *
 * 【増えたままでよいものは無い】
 *   journey スモークは、自分が作った行を最後に全部たどって消す。
 *   どれか1つでも戻らなければ、それは片づけ漏れとして報告する。
 */

/** 数える表。**ファネルが読む表と同じ並び**にしてある */
export const BASELINE_TABLES = [
  "profiles",
  "draft_sessions",
  "prompts",
  "works",
  "answers",
  "usage_events",
  "terms_agreements",
];

/** 表示に使う日本語名 */
export const BASELINE_LABELS = {
  auth_users: "認証の口の人",
  profiles: "人（profiles）",
  draft_sessions: "ドラフト",
  prompts: "確定したお題",
  works: "作品",
  answers: "回答",
  usage_events: "利用の記録",
  terms_agreements: "同意の記録",
};

async function countRows(client, table) {
  const { count, error } = await client.from(table).select("id", { count: "exact", head: true });
  if (error) throw new Error(`${table}: ${error.message}`);
  return count ?? 0;
}

/** 認証の口にいる人を全ページ数える。メールも ID も持ち出さない */
export async function countAuthUsers(client) {
  let total = 0;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`auth.users: ${error.message}`);
    const list = data?.users ?? [];
    total += list.length;
    if (list.length < 1000) break;
  }
  return total;
}

/** いまの件数をまとめて取る */
export async function takeBaseline(client) {
  const out = { auth_users: await countAuthUsers(client) };
  for (const t of BASELINE_TABLES) out[t] = await countRows(client, t);
  return out;
}

/** 前後の差。増減があるものだけでなく、全項目を返す */
export function diffBaseline(before, after) {
  const keys = ["auth_users", ...BASELINE_TABLES];
  return keys.map((key) => ({
    key,
    label: BASELINE_LABELS[key] ?? key,
    before: before?.[key] ?? null,
    after: after?.[key] ?? null,
    delta:
      typeof before?.[key] === "number" && typeof after?.[key] === "number"
        ? after[key] - before[key]
        : null,
  }));
}

/** 元に戻っていない項目 */
export function baselineDrift(rows) {
  return rows.filter((r) => r.delta === null || r.delta !== 0);
}

/** 1行ぶんの表示 */
export function describeBaselineRow(r) {
  const d = r.delta === null ? "？" : r.delta === 0 ? "±0" : r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
  return `${r.label.padEnd(14, "　")} ${String(r.before ?? "?").padStart(6)} → ${String(r.after ?? "?").padStart(6)}  ${d}`;
}
