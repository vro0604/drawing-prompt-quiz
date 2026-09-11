/**
 * _smoke-own-rows.mjs ／ 検査がこの実行で作った行だけを、ID で名指しして消す
 *
 * 【なぜ要るか】
 *   smoke-sub-directive は、確定したお題を「この作者のもの全部」で消していた。
 *   同じ作者の古いお題に、非公開にしただけの作品の行が残っていると、
 *   外部キー（works_prompt_id_fkey）に断られて1文まるごと失敗する。
 *   今回作ったお題も1件も消えない。しかも失敗を合格と数えていた。
 *   2026-09-10 の本番で、作品の無い確定済みお題が6件残った原因がこれ。
 *
 * 【どう直したか】
 *   1. 作ったその場で ID を帳面に積む。一覧や作者名から拾った ID は入れない
 *   2. 消すときは帳面の ID だけを名指しする
 *   3. 帳面の ID が1件でも消えなければ、理由と ID を添えて不合格にする
 *
 * 【消す順】
 *   作品 → お題 → ドラフト。お題は作品が残っていると消せない（外部キー）。
 *   回答は作品と一緒に消える（answers.work_id は on delete cascade）。
 *   ドラフトを消すと、お題の draft_session_id は空になるだけで、お題は残る。
 */

/** 帳面に積める表と、消す順 */
export const OWN_ROW_TABLES = ["works", "prompts", "draft_sessions"];

/** この実行が作った行の帳面 */
export function createRunLedger() {
  const rows = new Map(OWN_ROW_TABLES.map((t) => [t, new Set()]));
  return {
    add(table, id) {
      if (!rows.has(table)) throw new Error(`帳面に無い表です: ${table}`);
      if (id) rows.get(table).add(id);
    },
    ids(table) {
      return [...(rows.get(table) ?? [])];
    },
  };
}

/**
 * 帳面の行を消す。**表ごとに1回だけ、ID の一覧で名指しする。**
 *
 * remove(table, ids) は { ids: 実際に消えた ID, error: 理由か null } を返すこと。
 * 1つの表で失敗しても、残りの表は続けて消す（どこまで消えたかを全部見せるため）。
 */
export async function cleanupRunRows(ledger, remove) {
  const report = [];
  for (const table of OWN_ROW_TABLES) {
    const expected = ledger.ids(table);
    if (expected.length === 0) {
      report.push({ table, expected: 0, removed: 0, missing: [], extra: [], error: null, ok: true });
      continue;
    }

    let out;
    try {
      out = await remove(table, expected);
    } catch (e) {
      out = { ids: [], error: e?.message ?? String(e) };
    }

    const got = new Set(out?.ids ?? []);
    const missing = expected.filter((id) => !got.has(id));
    const extra = [...got].filter((id) => !expected.includes(id));
    const error = out?.error ?? null;
    report.push({
      table,
      expected: expected.length,
      removed: got.size,
      missing,
      extra,
      error,
      ok: error === null && missing.length === 0 && extra.length === 0,
    });
  }
  return report;
}

/** 1表ぶんの結果を、1行で読める形にする */
export function describeCleanup(r) {
  const parts = [`${r.removed}/${r.expected} 件`];
  if (r.error) parts.push(`理由: ${r.error}`);
  if (r.missing.length > 0) parts.push(`消えなかった: ${r.missing.join(",")}`);
  if (r.extra.length > 0) parts.push(`頼んでいないのに消えた: ${r.extra.join(",")}`);
  return parts.join(" ／ ");
}

/** service_role の Supabase クライアントで消す remove */
export function supabaseRemover(client) {
  return async (table, ids) => {
    const { data, error } = await client.from(table).delete().in("id", ids).select("id");
    return {
      ids: (data ?? []).map((r) => r.id),
      error: error ? [error.code, error.message].filter(Boolean).join(" ") : null,
    };
  };
}
