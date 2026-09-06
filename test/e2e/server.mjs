/**
 * server.mjs ／ 検証用の Supabase もどきの上で、アプリを実際に起動する
 *
 * 【何が起きるか】
 *   1. PGlite に migration を全部当てて DB を作る
 *   2. その DB の前に、Supabase の API の形をした小さなサーバーを立てる
 *   3. その URL を環境変数に入れて `next dev` を起動する
 *   4. 起動を待って、URL を返す
 *
 *   **本番の Supabase には1バイトも送らない。**接続先はここで作った値にする。
 *
 * 【.env.local をどう締め出しているか】
 *   Next.js は `.env.local` を必ず読む。読ませない設定は無い。
 *   代わりに「すでに環境にある名前は上書きしない」という性質を使い、
 *   **`.env.local` に書かれている名前を先に全部埋めてから**起動する。
 *   埋める値は当たり障りのない印で、本番の値は1つも渡らない。
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectEnvironment, neutraliseEnvFiles } from "../guard/no-production.mjs";
import { reservePort, waitForFreePort } from "./exclusive.mjs";
import { startSupabaseMock, ANON_KEY, SERVICE_KEY } from "./supabase-mock.mjs";
import { seedForE2E } from "./seed.mjs";

// パスに日本語が入るので、URL の pathname をそのまま使うと
// パーセント符号化された文字列になり、その名前のファイルは存在しない。
// fileURLToPath を通して元に戻す（実測: spawn ... ENOENT）。
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** サーバーが応答するまで待つ */
async function waitFor(url, { timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      /* まだ起動していない */
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`${url} が ${timeoutMs}ms 以内に応答しませんでした`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** プロセスの集団ごと止める */
function stop(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* すでに終わっている */
    }
  }
}


/**
 * 画面を1度ずつ開いて、`next dev` に道筋を組み立てさせる（先に温める）。
 *
 * 【なぜ要るか】
 *   `next dev` は**要求が来て初めてその画面を組み立てる。**組み立ては数秒
 *   かかることがあり、その時間は計算機の混み具合でいくらでも伸びる。
 *   温めずに試験へ入ると、その組み立て時間が
 *   「部品が15秒以内に出ない」という形で試験の失敗として現れる。
 *   **落ちているのはアプリではなく、間に合わなかった待ち時間のほうである。**
 *
 * 【待ち時間を伸ばして隠すのとは違う】
 *   試験の中の待ち時間は1ミリ秒も伸ばしていない。
 *   組み立てを**試験の外へ出した**だけで、試験が見るのは
 *   「組み立て済みの画面が何秒で出るか」になる。
 *   ここで組み立てに失敗すれば、試験ではなく準備の失敗として名前が付く。
 *
 * 【何を返すか】
 *   画面ごとの所要時間。記録に残して、遅い回と速い回を後から比べられるようにする。
 */
export async function warmupRoutes(base, paths, { timeoutMs = 120_000 } = {}) {
  const timings = [];
  for (const path of paths) {
    const t0 = Date.now();
    let status = null;
    let error = null;
    try {
      const res = await fetch(`${base}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      status = res.status;
      await res.arrayBuffer();      // 本文を最後まで受け取ってから次へ
    } catch (e) {
      error = `${e.name}: ${e.message}${e.cause?.code ? `（${e.cause.code}）` : ""}`;
    }
    timings.push({ path, ms: Date.now() - t0, status, error });
  }
  return timings;
}

export async function startApp({ port = 3210, log = false } = {}) {
  await reservePort(port);

  const mock = await startSupabaseMock();
  const seeded = await seedForE2E(mock.db);

  // **`.env.local` の名前を先に埋めておく。**
  //   Next.js は `.env.local` を必ず読む。取り消す仕組みは無い
  //   （実測: @next/env に NEXT_DISABLE_ENV_FILES の分岐が1つも無い）。
  //   ただし「すでにある名前」は上書きしない作りなので、
  //   名前だけ先に埋めれば、本番の値は1つも入ってこない。
  const env = neutraliseEnvFiles({
    ...process.env,
    NODE_ENV: "development",
    // **本番のサーバーと同じく UTC で動かす。**
    // 手元の時計（日本時間）のまま試すと、時間帯を書き忘れた表示でも
    // 正しく見えてしまい、9時間ずれる不具合を見つけられない。
    TZ: "UTC",
    NEXT_PUBLIC_SUPABASE_URL: mock.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ANON_KEY,
    SUPABASE_SECRET_KEY: SERVICE_KEY,
    NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
    CRON_SECRET: "e2e-cron-secret",
    // CAPTCHA は Cloudflare が公開している**検査用の鍵**を使う。
    // 常に通る値で、本番の鍵ではない（check-env.mjs が本番では弾く）。
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
    TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",

    // **検証用サーバーが途中で作り直されないようにする。**
    //   next dev は「使っている領域が上限の8割を超えた」時点で
    //   自分を終了させ、親が立て直す（node_modules/next/dist/server/lib/
    //   start-server.js の "approaching the used memory threshold"）。
    //   立て直しのあいだ、この番号は接続を受け付けない。
    //   そこへ要求が来ると ECONNRESET → ECONNREFUSED になり、
    //   呼んだ側には「TypeError: fetch failed」としか見えない。
    //   **2026-09-05 の間欠失敗はこれだった**（実測: スモークを5周続けた
    //   3周目に、この行がサーバーの出力へ出た直後に3回とも接続を拒否された）。
    //
    //   この端末の既定の上限は 2240MB で、8割は約 1.8GB。
    //   5周ぶん走らせると届く。倍にして届かないようにする
    //   （この端末の実装メモリは 8GB なので、4GB なら交換領域へは落ちない）。
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim(),
  });

  // **子プロセスへ渡す環境を、起動する前に検査する。**
  //   next dev は別のプロセスなので、こちら側で fetch を包んでも効かない。
  //   渡す値の中に本番のURL・project ref・ホスト名・鍵が残っていたら、
  //   そのプロセスは本番へつなげてしまう。渡す前にここで止める。
  {
    const problems = inspectEnvironment(env);
    if (problems.length > 0) {
      console.error("\n検証用サーバーへ渡す環境に本番が混ざっています:");
      for (const p of problems) console.error(`  ・${p}`);
      console.error("");
      await mock.close();
      process.exit(70);
    }
  }

  // node_modules/.bin の next を直に起動する。
  // npx は PATH に無いことがある（実測: spawn npx ENOENT）
  const nextBin = join(ROOT, "node_modules", ".bin", "next");
  const child = spawn(
    nextBin,
    ["dev", "--port", String(port), "--hostname", "127.0.0.1"],
    {
      cwd: ROOT,
      env,
      stdio: log ? "inherit" : ["ignore", "pipe", "pipe"],
      // **プロセスの集団ごと止められるようにする。**
      // next dev は自分の下にもう1つ立てるので、親だけ kill すると
      // 子が残って次回「すでに起動しています」で失敗する（実測）。
      detached: true,
    },
  );

  const logs = [];
  if (!log) {
    child.stdout?.on("data", (d) => logs.push(d.toString()));
    child.stderr?.on("data", (d) => logs.push(d.toString()));
  }

  const base = `http://127.0.0.1:${port}`;
  try {
    await waitFor(`${base}/`);
  } catch (e) {
    stop(child);
    await mock.close();
    throw new Error(`${e.message}\n--- サーバーの出力 ---\n${logs.join("")}`);
  }

  return {
    base,
    mock,
    db: mock.db,
    seeded,
    logs,
    /**
     * 片づける。**ポートが本当に空くまで待ってから返る。**
     *
     * 決め打ちの秒数で待つと、混んでいる日に足りず、
     * 次の実行が「すでに使われています」で落ちる。空いたことを確かめる。
     */
    async close() {
      stop(child);
      const code = await waitForFreePort(port, { timeoutMs: 20_000 });
      await mock.close();
      if (code !== null) {
        console.warn(
          `（注意: ポート ${port} が 20 秒たっても空きませんでした（${code}）。` +
            "残っているプロセスがないか確かめてください）",
        );
      }
    },
  };
}
