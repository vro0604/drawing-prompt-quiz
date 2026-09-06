#!/usr/bin/env node
/**
 * selftest.mjs ／ 本番接続を止める柵が、本当に効くことを確かめる
 *
 * 実行: npm run test:guard
 *
 * 【なぜ柵そのものを試すのか】
 *   柵は「何も起きないこと」を仕事にしている。効いていなくても、
 *   ふだんは何も起きないので気づけない。**わざと本番らしい値を渡して、
 *   止まることを見る。**止まらなければ、この試験が落ちる。
 *
 * 【偽の本番として何を渡すか】
 *   ・本番の Supabase の URL
 *   ・本番の project ref だけ（URL の形をしていない値）
 *   ・本番ではないが、ローカルでもないホスト
 *   ・.env.local に書かれている値そのもの（別の変数名に入れる）
 *   ・柵を外そうとする環境変数
 *
 * 【値は表示しない】
 *   4つ目は本物の秘密を使うが、この試験も柵の出力も値を1文字も出さない。
 *   .env.local が無い環境では、その1件だけ「未実施」と出す。
 */

import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordCount } from "../counts.mjs";
import {
  envFileKeys,
  inspectEnvironment,
  neutraliseEnvFiles,
} from "./no-production.mjs";

const PROBE = fileURLToPath(new URL("./_probe.mjs", import.meta.url));

const results = [];

function run(env, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROBE, ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("close", (code) => resolve({ code, output: out.join("") }));
  });
}

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "○" : "✗"} ${name}${detail ? `  ${detail}` : ""}`);
}

function readEnvLocalValue(key) {
  try {
    const text = readFileSync(new URL("../../.env.local", import.meta.url), "utf8");
    for (const line of text.split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m && m[1] === key) return m[2].trim();
    }
  } catch {
    /* 無い環境もある */
  }
  return null;
}

console.log("\n本番接続を止める柵の自己試験\n");

// --- 1. 素の環境なら通る ----------------------------------------------------
{
  const r = await run({ NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" });
  check(
    "ローカルの接続先なら通る",
    r.code === 0 && /PASSED/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 2. 本番の URL を渡すと止まる -------------------------------------------
{
  const r = await run({
    NEXT_PUBLIC_SUPABASE_URL: "https://oyyiutiptsffckujqkvl.supabase.co",
  });
  check(
    "本番のURLを渡すと止まる",
    r.code !== 0 && /本番への接続を検出/.test(r.output),
    `終了コード ${r.code}`,
  );
  check(
    "どの環境変数が本番を指していたかが出る",
    /NEXT_PUBLIC_SUPABASE_URL/.test(r.output),
  );
}

// --- 3. project ref だけでも止まる ------------------------------------------
{
  const r = await run({ SUPABASE_PROJECT_REF: "oyyiutiptsffckujqkvl" });
  check(
    "URLの形をしていない project ref だけでも止まる",
    r.code !== 0 && /project ref/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 4. 本番のドメインでも止まる --------------------------------------------
{
  const r = await run({ NEXT_PUBLIC_SITE_URL: "https://tsutawarukana.com" });
  check(
    "本番のドメインを渡すと止まる",
    r.code !== 0 && /ホスト名/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 5. ローカル以外のホストなら、本番でなくても止まる -----------------------
{
  const r = await run({ NEXT_PUBLIC_SUPABASE_URL: "https://another-ref.supabase.co" });
  check(
    "ローカル以外のホストは、本番でなくても止まる",
    r.code !== 0 && /接続先ホスト/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 6. 本番の鍵そのものを別の名前で渡しても止まる ---------------------------
{
  const secret = readEnvLocalValue("SUPABASE_SECRET_KEY");
  if (secret === null) {
    check("本番の鍵を別名で渡しても止まる", true, "（.env.local が無いので未実施）");
  } else {
    const r = await run({ SOME_OTHER_NAME: secret });
    check(
      "本番の鍵を別の変数名で渡しても止まる",
      r.code !== 0 && /本番の資格情報/.test(r.output),
      `終了コード ${r.code}`,
    );
    check(
      "鍵の値そのものは表示されない",
      !r.output.includes(secret),
    );
    check(
      "どの変数と、.env.local のどの項目が一致したかは出る",
      /SOME_OTHER_NAME/.test(r.output) && /SUPABASE_SECRET_KEY/.test(r.output),
    );
  }
}

// --- 7. 環境変数では外せない ------------------------------------------------
{
  const r = await run({
    NEXT_PUBLIC_SUPABASE_URL: "https://oyyiutiptsffckujqkvl.supabase.co",
    ALLOW_PRODUCTION: "1",
    SKIP_PRODUCTION_GUARD: "1",
    DPQ_ALLOW_PRODUCTION: "true",
    NODE_ENV: "production",
    CI: "1",
  });
  check(
    "解除らしい環境変数を並べても外れない",
    r.code !== 0 && /本番への接続を検出/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 8. 許可外のホストへの通信そのものが止まる ------------------------------
{
  const r = await run({}, ["--fetch", "https://oyyiutiptsffckujqkvl.supabase.co/rest/v1/"]);
  check(
    "本番へ fetch しようとすると通信が止まる",
    /FETCH_BLOCKED/.test(r.output),
    `終了コード ${r.code}`,
  );
}
{
  const r = await run({}, ["--fetch", "https://example.com/"]);
  check(
    "ローカル以外への fetch は、どこであっても止まる",
    /FETCH_BLOCKED/.test(r.output),
    `終了コード ${r.code}`,
  );
}
{
  const r = await run({}, ["--fetch", "http://127.0.0.1:1/"]);
  // つながらないのは構わない。**柵に止められていないこと**を見る
  check(
    "ローカルへの fetch は柵で止められない",
    !/ローカル試験が接続してよいのは/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 9. URL の書き方が違っても、同じ本番として止まる ------------------------
{
  const shapes = [
    ["末尾スラッシュ", "https://oyyiutiptsffckujqkvl.supabase.co/"],
    ["大文字混じり", "https://OYYIUTIPTSFFCKUJQKVL.supabase.co"],
    ["パス付き", "https://oyyiutiptsffckujqkvl.supabase.co/rest/v1/tags?select=*"],
    ["ポート付き", "https://oyyiutiptsffckujqkvl.supabase.co:443/"],
    ["ドメインのほう", "https://TSUTAWARUKANA.com/works/"],
  ];
  for (const [label, url] of shapes) {
    const r = await run({ NEXT_PUBLIC_SUPABASE_URL: url });
    check(
      `本番のURL（${label}）でも止まる`,
      r.code !== 0 && /本番への接続を検出/.test(r.output),
      `終了コード ${r.code}`,
    );
  }
}

// --- 10. 見張っていない名前の変数に入れても止まる ---------------------------
{
  // CONNECTION_VARS に載っていない名前。**名前ではなく値を見ている**
  const r = await run({ MY_OWN_BACKUP_URL: "https://oyyiutiptsffckujqkvl.supabase.co" });
  check(
    "一覧に無い名前の変数へ本番URLを入れても止まる",
    r.code !== 0 && /本番への接続を検出/.test(r.output),
    `終了コード ${r.code}`,
  );
  check(
    "その変数の名前が出る",
    /MY_OWN_BACKUP_URL/.test(r.output),
  );
}

// --- 11. リダイレクトの先が外なら止まる -------------------------------------
{
  // ローカルの入口 → 外部。1跳び目は通り、2跳び目で止まるのが正しい
  const r = await run({}, ["--redirect", "https://example.com/"]);
  check(
    "ローカルから外へのリダイレクトは、跳んだ先で止まる",
    /FETCH_BLOCKED/.test(r.output) && /リダイレクト/.test(r.output),
    `終了コード ${r.code}`,
  );
}
{
  const r = await run({}, ["--redirect", "https://oyyiutiptsffckujqkvl.supabase.co/"]);
  check(
    "ローカルから本番へのリダイレクトも止まる",
    /FETCH_BLOCKED/.test(r.output),
    `終了コード ${r.code}`,
  );
}
{
  // ローカル → ローカルは止めない（止めると検査そのものが動かない）
  const r = await run({}, ["--redirect", "http://127.0.0.1:1/next"]);
  check(
    "ローカルからローカルへのリダイレクトは止めない",
    !/リダイレクトを止めました/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 12. WebSocket も外へ出られない -----------------------------------------
{
  const r = await run({}, ["--ws", "wss://oyyiutiptsffckujqkvl.supabase.co/realtime/v1"]);
  check(
    "外部への WebSocket は止まる",
    /FETCH_BLOCKED/.test(r.output) || /WS_UNAVAILABLE/.test(r.output),
    `終了コード ${r.code}`,
  );
}
{
  const r = await run({}, ["--ws", "ws://127.0.0.1:1/"]);
  check(
    "ローカルへの WebSocket は柵で止められない",
    !/WebSocket 接続を止めました/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 13. IPv6 の loopback は許可していない ----------------------------------
{
  // 使っていない宛先は許可しない（test/guard/no-production.mjs の ALLOWED_HOSTS）。
  const r = await run({}, ["--fetch", "http://[::1]:1/"]);
  check(
    "IPv6 の loopback は許可していない（この工程では使っていない）",
    /FETCH_BLOCKED/.test(r.output) && /\[?::1\]?/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 14. ローカル専用の入口から --production へ行けない ---------------------
{
  const smoke = fileURLToPath(new URL("../../scripts/smoke-draft.mjs", import.meta.url));
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [smoke, "--production"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => out.push(d.toString()));
    child.on("close", (code) => resolve({ code, output: out.join("") }));
  });
  check(
    "smoke:prod 以外の入口に --production を足しても本番へ行かない",
    r.code === 2 && /本番の入口から来ていません/.test(r.output),
    `終了コード ${r.code}`,
  );
}

// --- 15. ローカルの検査が .env.local を開かない ------------------------------
{
  // 静的な検査。**「読まない」は動かして確かめにくいので、
  // 読む場所が1か所だけであることを数える。**
  const roots = ["scripts", "test"];
  const readers = [];
  for (const root of roots) {
    const dir = fileURLToPath(new URL(`../../${root}`, import.meta.url));
    for (const name of readdirSync(dir, { recursive: true })) {
      if (typeof name !== "string" || !name.endsWith(".mjs")) continue;
      const rel = `${root}/${name}`;
      const text = readFileSync(join(dir, name), "utf8");
      // コメントの中の「.env.local」は数えない。読む式だけを見る
      if (/readFileSync\([^)]*\.env\.local/.test(text)) readers.push(rel);
    }
  }

  // 読んでよいのは、接続先を決める1か所と、その柵と、環境の点検だけ。
  //   _env-target.mjs   … 本番の経路のときだけ読む
  //   no-production.mjs … 指紋を取るためだけに読む（値は出さない）
  //   selftest.mjs      … この試験自身（照合する値を取り出す）
  //   check-env.mjs     … NEXT_DISABLE_ENV_FILES=1 では読まない
  //   _setup-common.mjs / setup-*.mjs … 手で叩く設定コマンド。検査ではない
  const ALLOWED = [
    "scripts/_env-target.mjs",
    "scripts/check-env.mjs",
    "scripts/_setup-common.mjs",
    "test/guard/no-production.mjs",
    "test/guard/selftest.mjs",
  ];
  const unexpected = readers.filter((f) => !ALLOWED.includes(f));
  check(
    "ローカルの検査で .env.local を開く場所が増えていない",
    unexpected.length === 0,
    unexpected.length === 0 ? `読む場所は ${readers.length} か所` : unexpected.join(" / "),
  );
}

// --- 16. 検証用サーバーへ渡す環境に、.env.local の値が1つも入らない ---------
{
  // Next.js は `.env.local` を必ず読む（取り消す設定は無い）。
  // 代わりに「名前を先に埋める」ことで値を締め出している。
  // **その埋めが効いているか**を、名前の一覧と突き合わせて確かめる。
  const keys = envFileKeys();
  if (keys.length === 0) {
    check(".env.local の名前を先に埋めている", true, "（.env.local が無いので未実施）");
  } else {
    const filled = neutraliseEnvFiles({ PATH: process.env.PATH });
    const missing = keys.filter((k) => filled[k] === undefined || filled[k] === "");
    check(
      ".env.local に書かれた名前が、渡す環境に全部そろっている",
      missing.length === 0,
      missing.length === 0 ? `${keys.length} 件` : `埋まっていない: ${missing.join(",")}`,
    );

    // 埋めた値が本番の値と一致していないこと（＝名前だけ写して値は写していない）
    const problems = inspectEnvironment(filled);
    check(
      "埋めた値が本番の資格情報と一致していない",
      problems.length === 0,
      problems.join(" / "),
    );
  }
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n合計 ${results.length} 件 / 合格 ${results.length - failed.length} 件 / 不合格 ${failed.length} 件`,
);

// 文書に書いた件数と突き合わせられるように、実測を残す
recordCount("柵の自己試験", results.length);

process.exit(failed.length === 0 ? 0 : 1);
