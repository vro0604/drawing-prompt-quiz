/**
 * _setup-common.mjs ／ 公開の下ごしらえをする3本の共通部分
 *
 * setup-domain.mjs ／ setup-auth.mjs ／ verify-launch.mjs が使う。
 * 「外の API を叩く」「秘密を出さない」「送る前に見せる」ための道具だけを置き、
 * **何を送るか**は各スクリプト側に書く。
 *
 * 【値は出さない】
 *   check-env.mjs (D80) と同じ作法。秘密は1文字も表示せず、長さだけを出す。
 *   ログが残る場所（端末の履歴・CI の出力）に鍵を落とさないため。
 *
 * 【送る前に見せる】
 *   既定は --dry-run。**引数を足さない限り、外へは何も送らない。**
 *   取り返しにくい操作（課金・外部公開・設定の上書き）を、
 *   中身を見ないまま実行できてしまう状態を作らない。
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const GREEN = "\x1b[32m";
export const RED = "\x1b[31m";
export const YELLOW = "\x1b[33m";
export const CYAN = "\x1b[36m";
export const DIM = "\x1b[2m";
export const BOLD = "\x1b[1m";
export const RESET = "\x1b[0m";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── 環境変数 ────────────────────────────────────────

/** .env.local も見る（check-env.mjs と同じ読みかた） */
function loadEnvLocal() {
  try {
    const text = readFileSync(`${ROOT}/.env.local`, "utf8");
    const out = {};
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return {};
  }
}

export const env = { ...loadEnvLocal(), ...process.env };

/**
 * 必須の環境変数を取る。無ければその場で止める。
 * **何が足りないかは名前で言う。値は出さない。**
 */
export function need(name, label) {
  const v = (env[name] ?? "").trim();
  if (v === "") {
    console.log("");
    console.log(`${RED}${BOLD}✗ ${name} が設定されていません${RESET}`);
    console.log(`  ${DIM}${label}${RESET}`);
    console.log("");
    console.log(`  ${DIM}.env.local に書いてください（Git には入りません）${RESET}`);
    console.log("");
    process.exit(1);
  }
  return v;
}

export function optional(name) {
  return (env[name] ?? "").trim() || null;
}

/** 秘密を表示用に潰す。長さだけ残す */
export function redact(value) {
  if (value == null || value === "") return `${DIM}(空)${RESET}`;
  return `${DIM}(${String(value).length}文字)${RESET}`;
}

// ── 判定 ────────────────────────────────────────────

let failures = 0;
let checks = 0;

export function must(ok, label, extra = "") {
  checks += 1;
  if (!ok) failures += 1;
  const mark = ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
  console.log(`  ${mark} ${label}${extra ? `  ${DIM}${extra}${RESET}` : ""}`);
  return ok;
}

/** 直せない・確かめられないものは、失敗ではなく参考として出す（D79 と区別する） */
export function note(label, extra = "") {
  console.log(`  ${YELLOW}—${RESET} ${label}${extra ? `  ${DIM}${extra}${RESET}` : ""}`);
}

export function section(title) {
  console.log("");
  console.log(`${BOLD}${title}${RESET}`);
}

export function summary(title) {
  console.log("");
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}✓ ${title}：${checks}項目すべて通りました${RESET}`);
    console.log("");
    return 0;
  }
  console.log(`${RED}${BOLD}✗ ${title}：${checks}項目中 ${failures}件が通りませんでした${RESET}`);
  console.log("");
  return 1;
}

// ── 実行するかどうか ─────────────────────────────────

/**
 * **既定は「送らない」。**
 * --apply を明示したときだけ、外へ送る。
 */
export const APPLY = process.argv.includes("--apply");
export const DRY_RUN = !APPLY;

export function banner(title, note2) {
  console.log("");
  console.log(`${BOLD}${title}${RESET}`);
  if (note2) console.log(`${DIM}${note2}${RESET}`);
  console.log("");
  if (DRY_RUN) {
    console.log(
      `${CYAN}${BOLD}［下見］${RESET} ${CYAN}何を送るかだけを表示します。外へは何も送りません。${RESET}`,
    );
    console.log(`${DIM}        実行するには --apply を付けてください${RESET}`);
  } else {
    console.log(`${YELLOW}${BOLD}［実行］${RESET} ${YELLOW}実際に外へ送ります${RESET}`);
  }
  console.log("");
}

// ── 外の API を叩く ──────────────────────────────────

/**
 * 送る前に「何を・どこへ」を必ず表示する。
 * 下見のときは表示だけして、null を返す。
 *
 * secretFields … 表示のときに潰す項目名（値は長さだけ出す）
 */
export async function api(label, { method = "GET", url, headers = {}, body, secretFields = [] }) {
  const isRead = method === "GET";

  if (!isRead) {
    console.log(`  ${CYAN}→${RESET} ${label}`);
    console.log(`    ${DIM}${method} ${url}${RESET}`);
    if (body) {
      const shown = {};
      for (const [k, v] of Object.entries(body)) {
        shown[k] = secretFields.includes(k) ? `…(${String(v ?? "").length}文字)` : v;
      }
      for (const line of JSON.stringify(shown, null, 2).split("\n")) {
        console.log(`    ${DIM}${line}${RESET}`);
      }
    }
    if (DRY_RUN) {
      console.log(`    ${CYAN}（下見なので送りません）${RESET}`);
      console.log("");
      return null;
    }
  }

  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* JSON でない応答もある */
  }

  if (!res.ok) {
    console.log(`    ${RED}✗ ${res.status} ${res.statusText}${RESET}`);
    // 応答をそのまま画面に出さない（D82）。要点だけ拾う
    const reason =
      json?.errors?.[0]?.message ?? json?.error?.message ?? json?.message ?? json?.msg ?? null;
    if (reason) console.log(`    ${RED}${reason}${RESET}`);
    throw new Error(`${label} に失敗しました（${res.status}）`);
  }

  if (!isRead) {
    console.log(`    ${GREEN}✓ ${res.status}${RESET}`);
    console.log("");
  }

  return json ?? {};
}

// ── 戻し道 ──────────────────────────────────────────

/**
 * 変更前の状態を控える。**これが唯一の戻し道になる。**
 * 下見のときも書く（何が入っているかを先に見られるほうがよい）。
 */
export function saveBackup(name, data) {
  const dir = `${ROOT}/backup`;
  mkdirSync(dir, { recursive: true });
  // 日時はファイル名に使うだけ。中身の比較には使わない
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const path = `${dir}/${name}-${stamp}.json`;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  console.log(`  ${GREEN}✓${RESET} 変更前の設定を控えました  ${DIM}${path.replace(ROOT + "/", "")}${RESET}`);
  console.log("");
  return path;
}
