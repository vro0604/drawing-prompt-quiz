import { createRequire } from "node:module"; import fs from "node:fs"; import { spawnSync } from "node:child_process";
const require = createRequire(`${process.env.HIST_TREE}/package.json`);
export const pg = require("pg");
export const H = process.env.HIST_WORK; // 作業用の置き場（DB のデータ・ログ・結果の JSON）
export const WT = process.env.HIST_TREE; // origin/main を取り出した作業木
export const url = (db) => `postgresql://postgres:pw@127.0.0.1:55433/${db}?sslmode=disable`;
export async function withDb(db, fn) {
  const c = new pg.Client({ connectionString: url(db), application_name: "dpq-hist-harness" });
  c.on("notice", () => {});
  await c.connect();
  try { return await fn(async (s, p) => (await c.query(s, p)).rows, c); } finally { await c.end(); }
}
export const LOG = `${H}/pg-statements.log`;
// CLI を走らせ、その間にサーバへ届いた文（harness 以外）を切り出す
export function cli(args, { workdir = WT, cliVersion = null } = {}) {
  const before = fs.statSync(LOG).size;
  const pkg = cliVersion ? [`--yes`, `supabase@${cliVersion}`] : ["supabase"];
  const r = spawnSync("npx", [...pkg, ...args, "--workdir", workdir], { cwd: WT, encoding: "utf8", env: { ...process.env, SUPABASE_DB_URL: "", DO_NOT_TRACK: "1" }, timeout: 600000 });
  // ログ書き込みの遅延を待つ
  const t = Date.now(); while (Date.now() - t < 700) {}
  const buf = fs.readFileSync(LOG).subarray(before).toString("utf8");
  const stmts = buf.split("\n@@").map((l) => l.replace(/^@@/, "")).filter((l) => !/\|dpq-hist-harness\|/.test(l) && /LOG:  (statement|execute)/.test(l));
  return { code: r.status, out: (r.stdout || "") + (r.stderr || ""), stmts };
}
export async function createDb(name, template) {
  await withDb("postgres", async (q) => {
    await q(`drop database if exists ${name} with (force)`);
    await q(template ? `create database ${name} template ${template}` : `create database ${name} template template0 encoding 'UTF8' locale_provider icu icu_locale 'en-US' locale 'en_US.UTF-8'`);
  });
}
