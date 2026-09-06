/**
 * exclusive.mjs ／ 重い検査どうしがぶつからないようにする
 *
 * 【何を防ぐか】
 *   この計算機で「重い検査」と呼べるものは4つある。
 *
 *     ・ブラウザ試験（test:e2e）      … next dev ＋ PGlite ＋ Chromium
 *     ・ローカルのスモーク（test:smoke:local） … next dev ＋ PGlite
 *     ・build                         … Next のコンパイル
 *     ・DB試験（test:db / upgrade）   … PGlite（ポートは使わない）
 *
 *   このうち前の2つは **同じ計算機の上で Next のサーバーを立てる。**
 *   2つ同時に走ると、CPU と記憶領域を奪い合って
 *   「画面が15秒以内に出ない」という形で落ちる。落ちかたはアプリの不具合と
 *   区別がつかないので、**そもそも同時に走らせない。**
 *
 * 【どうやって防ぐか】
 *   リポジトリ直下の `.test-locks/heavy.lock` を**先に作れた者だけ**が走る。
 *   作れなかった側は、持ち主が終わるまで待つ。持ち主のプロセスが
 *   すでに居なければ（強制終了などで札が残った場合）、その札を捨てて取り直す。
 *
 *   札には「誰が・いつから・どのポートを使うか」を書く。
 *   待たされた側は、待っている相手の名前を画面に出す。
 *   **黙って待つと、止まっているのか待っているのか分からない。**
 *
 * 【ポートの予約】
 *   札を持っているあいだだけ、そのポートを使う。
 *   使う前に本当に空いているかを実際に bind して確かめ、
 *   終わったら札ごと外す。異常終了しても外れるように、
 *   プロセスの終了・SIGINT・SIGTERM・未捕捉例外のすべてに外す処理を付ける。
 */

import { createServer } from "node:net";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const LOCK_DIR = join(ROOT, ".test-locks");
const LOCK_FILE = join(LOCK_DIR, "heavy.lock");

/** その番号のプロセスがまだ居るか */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK_FILE, "utf8"));
  } catch {
    return null;
  }
}

/**
 * 重い検査の札を取る。取れるまで待つ。
 *
 * @param name  何のために取るか（待たされた側の画面に出る）
 * @param waitMs これ以上待ったら諦めて例外にする
 * @returns 札を外す関数
 */
export async function acquireHeavyLock(name, { waitMs = 30 * 60_000 } = {}) {
  mkdirSync(LOCK_DIR, { recursive: true });

  const started = Date.now();
  let announced = false;

  for (;;) {
    try {
      writeFileSync(
        LOCK_FILE,
        JSON.stringify({ name, pid: process.pid, at: new Date().toISOString() }, null, 2),
        { flag: "wx" },
      );
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;

      const holder = readLock();

      // 持ち主がもう居ない札は捨てる。**居るかどうかで判断する。**
      // 時間で判断すると、正常に長く走っている検査を横取りしてしまう。
      if (!holder || !alive(holder.pid)) {
        try {
          rmSync(LOCK_FILE, { force: true });
        } catch {
          /* 同時に捨てようとした別のプロセスが先に消しただけ */
        }
        continue;
      }

      if (!announced) {
        console.log(
          `（重い検査の順番待ち: いま「${holder.name}」が走っています` +
            `／PID ${holder.pid}／${holder.at} 開始）`,
        );
        announced = true;
      }

      if (Date.now() - started > waitMs) {
        throw new Error(
          `重い検査の順番待ちが ${Math.round((Date.now() - started) / 1000)} 秒を超えました。\n` +
            `いま走っているのは「${holder.name}」（PID ${holder.pid}）です。\n` +
            "終わるのを待つか、そのプロセスを止めてから やり直してください。",
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const mine = readLock();
    if (mine && mine.pid === process.pid) rmSync(LOCK_FILE, { force: true });
  };

  // **異常終了でも札を残さない。**残すと、次の実行が延々と待つ
  process.once("exit", release);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      release();
      process.exit(130);
    });
  }
  process.once("uncaughtException", (e) => {
    release();
    throw e;
  });

  if (announced) console.log("（順番が来ました）");
  return release;
}

/**
 * そのポートが空いているか、実際に bind して確かめる。
 *
 * **空いていなければ、そのまま乗っ取らない。**前の実行で残った next dev が
 * 同じ番号を掴んでいると、こちらは「起動した」と思ったまま古いアプリを叩く。
 * 古いアプリは古い擬似 Supabase を向いているので、作った利用者も作品も
 * 見つからず、原因の分からない失敗が並ぶ。
 */
export async function waitForFreePort(port, { timeoutMs = 15_000 } = {}) {
  const tryOnce = () =>
    new Promise((resolve) => {
      const probe = createServer();
      probe.once("error", (e) => resolve(e.code ?? "EADDRINUSE"));
      probe.once("listening", () => probe.close(() => resolve(null)));
      probe.listen(port, "127.0.0.1");
    });

  const started = Date.now();
  let code = await tryOnce();
  while (code !== null && Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 250));
    code = await tryOnce();
  }
  return code;   // null なら空いている
}

/**
 * ポートを予約する。札の中身に書き足して、誰が使っているか分かるようにする。
 *
 * 空いていなければ**例外にする。**待ってもだめなら、
 * それは前の実行が片づいていないということなので、勝手に別の番号へ逃げない。
 * 逃げると、残っているサーバーがいつまでも残る。
 */
export async function reservePort(port, { timeoutMs = 15_000 } = {}) {
  const code = await waitForFreePort(port, { timeoutMs });
  if (code !== null) {
    throw new Error(
      `ポート ${port} はすでに使われています（${code}）。\n` +
        "前の検証用サーバーが残っている可能性があります。\n" +
        `  lsof -nP -iTCP:${port} -sTCP:LISTEN\n` +
        "で調べて、残っていれば終了させてから もう一度実行してください。",
    );
  }

  const lock = readLock();
  if (lock && lock.pid === process.pid) {
    writeFileSync(
      LOCK_FILE,
      JSON.stringify({ ...lock, ports: [...(lock.ports ?? []), port] }, null, 2),
    );
  }
  return port;
}

/** いま札が空いているか（一括の検査が、次の工程へ進む前に確かめる） */
export function heavyLockHolder() {
  const holder = readLock();
  if (!holder) return null;
  if (!alive(holder.pid)) return null;
  return holder;
}
