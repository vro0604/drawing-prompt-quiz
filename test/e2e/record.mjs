/**
 * record.mjs ／ 試験1件ごとの経過を、最後まで残す
 *
 * 【なぜ要るか】
 *   2026-09-05 に、ブラウザ試験を単独で4回まわして1回だけ 39/40 になった。
 *   **どの1件が落ちたのか分からなかった。**画面に出た文字の末尾しか
 *   手元に残っていなかったためで、原因を追う入口が無かった。
 *
 *   ここでやるのは、落ちたときに何かを足すことではない。
 *   **合格したときも含めて、全件ぶんを毎回ファイルへ書き切る。**
 *   合格した回の記録が無いと「前は何秒だったか」も比べられない。
 *
 * 【1件について残すもの】
 *   ・組と名前          … どの試験か
 *   ・開始と終了の時刻  … いつ動いていたか（他の検査と重なっていないかを見る）
 *   ・かかった時間
 *   ・どの段で落ちたか  … 試験の中の「いまやっていること」
 *   ・そのときのURL     … ブラウザがどの画面に居たか
 *   ・例外の連なり      … 内側の原因（cause）まで
 *   ・種類             … 下の CATEGORY のどれか
 *   ・検証用サーバーの出力（その試験のあいだに出た行だけ）
 *
 * 【種類を分ける理由】
 *   「落ちた」だけでは、直す先が決まらない。
 *   ポートを拒否されたのならサーバーが立っていないし、
 *   要素が出ないのなら画面の作りか待ち方の問題で、まったく別のことをする。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const LOG_DIR = join(ROOT, ".test-logs");

/**
 * 落ちかたの種類。**すべて別のものとして数える。**
 * 混ぜると、同じ「不合格1件」でも直す先が違うことに気づけない。
 */
export const CATEGORY = {
  PROCESS_GONE: "プロセス終了（ブラウザまたは検証用サーバーが居なくなった）",
  OUT_OF_MEMORY: "メモリ不足（領域の上限に当たって作り直された／落ちた）",
  PORT_REFUSED: "ポート拒否（接続を受け付けてもらえなかった）",
  CONNECTION_LOST: "通信断（つながっていた接続が途中で切れた）",
  PAGE_WAIT: "画面待ち（ページの読み込み・遷移が終わらなかった）",
  ELEMENT_WAIT: "要素待ち（部品が現れない／押せない）",
  ASSERTION: "判定の不一致（画面は出たが、中身が期待と違う）",
  SETUP: "準備の失敗（試験の前段が通らなかった）",
  UNKNOWN: "分類できないもの",
};

/** 例外を、内側の原因（cause）まで開いて並べる */
export function unwrap(e) {
  const chain = [];
  let cur = e;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    chain.push({
      name: cur.name ?? "Error",
      message: String(cur.message ?? cur),
      code: cur.code ?? cur.errno ?? null,
      stack: typeof cur.stack === "string" ? cur.stack.split("\n").slice(0, 12) : null,
    });
    cur = cur.cause;
  }
  return chain;
}

/**
 * 落ちかたを1つに決める。
 *
 * 判定の材料は2つ。例外そのものと、**その試験のあいだに検証用サーバーが
 * 吐いた行**。サーバー側が「領域の上限に近い」と言っていたなら、
 * 呼んだ側から見えた「fetch failed」はその結果でしかない。
 */
export function classify(chain, serverLog = "") {
  const text = chain.map((c) => `${c.name}: ${c.message} ${c.code ?? ""}`).join(" | ");

  if (/approaching the used memory threshold/.test(serverLog)) return CATEGORY.OUT_OF_MEMORY;
  if (/heap out of memory|Allocation failed|JavaScript heap/i.test(text)) {
    return CATEGORY.OUT_OF_MEMORY;
  }
  if (/ECONNREFUSED/.test(text)) return CATEGORY.PORT_REFUSED;
  if (/ECONNRESET|socket hang up|UND_ERR_SOCKET|EPIPE/.test(text)) {
    return CATEGORY.CONNECTION_LOST;
  }
  if (
    /Target (page|closed)|has been closed|browserContext\.close|Browser closed|crashed/i.test(text)
  ) {
    return CATEGORY.PROCESS_GONE;
  }
  if (/waiting for locator|locator\.|toBeVisible|element is not|intercepts pointer/i.test(text)) {
    return CATEGORY.ELEMENT_WAIT;
  }
  if (/waitForSelector|page\.goto|waitForURL|waitForLoadState|waitForResponse|Navigation/i.test(text)) {
    return CATEGORY.PAGE_WAIT;
  }
  if (/Timeout .*exceeded|timeout/i.test(text)) return CATEGORY.ELEMENT_WAIT;
  return CATEGORY.ASSERTION;
}

/**
 * 記録係を1つ作る。
 *
 * @param runName    記録ファイルの名前に使う（e2e など）
 * @param serverLogs 検証用サーバーの出力が積まれる配列（server.mjs の logs）
 * @param probe      落ちた瞬間の様子を外から拾う関数。
 *                   `{ stage, urls }` を返す。**39件の試験の本文に1行も
 *                   足さずに「どの段で・どの画面で」を残すため**にある。
 *                   段は共通の操作（開く・押す・送る・待つ）が更新し、
 *                   URL は開いているページ全部から拾う。
 * @param collect    試験1件が終わるたびに呼ぶ関数。**合格でも呼ぶ。**
 *                   返した内容がその試験の記録へ混ざる。
 *                   押し直した回数のように「通ったが引っかかった」ことを
 *                   残すために使う。1回目で通ったのか3回目で通ったのかは、
 *                   同じ合格でも意味が違う。
 */
export function createRecorder({ runName, serverLogs = null, probe = null, collect = null }) {
  const records = [];
  const startedAt = new Date();
  let seq = 0;

  /** 試験1件を走らせて記録する */
  async function test(group, name, fn) {
    seq += 1;
    const index = seq;
    const logMark = serverLogs ? serverLogs.length : 0;
    const t0 = Date.now();
    const startedIso = new Date(t0).toISOString();

    // 試験の中の「いまやっていること」。落ちた瞬間の値が段になる
    let stage = "開始";
    let page = null;
    let urls = [];
    const stages = [];
    const ctx = {
      stage(label) {
        stage = label;
        stages.push({ at: new Date().toISOString(), label });
      },
      /** URL を拾えるように、いま見ているページを預ける */
      watch(p) {
        page = p;
        return p;
      },
    };

    let ok = true;
    let error = null;
    try {
      await fn(ctx);
    } catch (e) {
      ok = false;
      error = e;
    }

    const t1 = Date.now();
    const serverLog = serverLogs ? serverLogs.slice(logMark).join("") : "";

    let url = null;
    if (!ok) {
      // 外から拾えるもの（共通の操作が記録した段と、開いている画面のURL）
      if (probe) {
        try {
          const seen = probe();
          if (seen?.stage && stage === "開始") stage = seen.stage;
          urls = seen?.urls ?? [];
        } catch {
          /* 拾えなくても、試験の結果そのものは残す */
        }
      }
      if (page) {
        try {
          url = page.url();
        } catch {
          url = "（ページを掴めませんでした）";
        }
      }
      if (!url && urls.length > 0) url = urls.join(" / ");
    }

    const chain = ok ? [] : unwrap(error);

    // 合格でも拾う。**通ったが引っかかった**ことを残す
    let extra = {};
    if (collect) {
      try {
        extra = collect() ?? {};
      } catch {
        /* 拾えなくても、試験の結果は変わらない */
      }
    }

    const rec = {
      index,
      group,
      name,
      ok,
      startedAt: startedIso,
      endedAt: new Date(t1).toISOString(),
      ms: t1 - t0,
      stages,
      failedStage: ok ? null : stage,
      url,
      openUrls: ok ? [] : urls,
      category: ok ? null : classify(chain, serverLog),
      error: ok ? null : chain,
      message: ok ? null : (error?.message ?? String(error)),
      // サーバー側の言い分。**合格でも、作り直しが起きていれば残す**
      serverRestarted: /approaching the used memory threshold/.test(serverLog),
      serverLogTail: ok
        ? serverLog.includes("approaching the used memory threshold")
          ? serverLog.split("\n").slice(-20).join("\n")
          : null
        : serverLog.split("\n").slice(-60).join("\n"),
      ...extra,
    };
    records.push(rec);

    // **その場で1行出す。**最後にまとめて出す作りだと、
    // 途中で止まったときに何件まで進んだのか分からない
    console.log(
      `${rec.ok ? "○" : "✗"} [${String(index).padStart(2, "0")}/${group}] ${name}` +
        `（${(rec.ms / 1000).toFixed(1)}秒）` +
        (rec.clickRetries ? `  ※ ${rec.clickRetries}回 押し直しています` : "") +
        (rec.serverRestarted ? "  ※ この最中に検証用サーバーが作り直されました" : ""),
    );
    if (!rec.ok) {
      console.log(`      種類: ${rec.category}`);
      console.log(`      段:   ${rec.failedStage}`);
      if (rec.url) console.log(`      URL:  ${rec.url}`);
      console.log(`      原因: ${chain.map((c) => `${c.name}: ${c.message}`).join(" ← ")}`);
    }
    return rec;
  }

  /** 外から結果を1件足す（ブラウザを使わない判定など） */
  function add(rec) {
    seq += 1;
    records.push({
      index: seq,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      ms: 0,
      stages: [],
      failedStage: null,
      url: null,
      category: rec.ok ? null : CATEGORY.ASSERTION,
      error: null,
      serverRestarted: false,
      serverLogTail: null,
      ...rec,
    });
    console.log(`${rec.ok ? "○" : "✗"} [${String(seq).padStart(2, "0")}/${rec.group}] ${rec.name}`);
    if (!rec.ok) console.log(`      ${rec.message ?? ""}`);
    return records[records.length - 1];
  }

  /**
   * 記録を書き出す。**合格でも書く。**
   * 全件ぶんの1行要約と、機械で読める全文の2つを置く。
   */
  function finish(extra = {}) {
    mkdirSync(LOG_DIR, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const failed = records.filter((r) => !r.ok);

    const payload = {
      run: runName,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      total: records.length,
      passed: records.length - failed.length,
      failed: failed.length,
      ...extra,
      tests: records,
    };

    const jsonFile = join(LOG_DIR, `${runName}-${stamp}.json`);
    writeFileSync(jsonFile, JSON.stringify(payload, null, 2));
    writeFileSync(join(LOG_DIR, `${runName}-latest.json`), JSON.stringify(payload, null, 2));

    // 人が読む要約。**40件すべてを1行ずつ。**抜き出しはしない
    const lines = [
      `# ${runName} ${startedAt.toISOString()} 〜 ${payload.endedAt}`,
      `# ${payload.passed}/${payload.total} 合格 ／ 不合格 ${payload.failed}`,
      "",
      ...records.map(
        (r) =>
          `${r.ok ? "○" : "✗"} ${String(r.index).padStart(2, "0")} [${r.group}] ` +
          `${(r.ms / 1000).toFixed(1)}s ${r.startedAt} ${r.name}` +
          (r.clickRetries ? `（押し直し ${r.clickRetries}回）` : "") +
          (r.ok ? "" : `\n      種類: ${r.category}\n      段: ${r.failedStage}` +
            (r.url ? `\n      URL: ${r.url}` : "") +
            `\n      原因: ${r.message}`),
      ),
    ];
    const textFile = join(LOG_DIR, `${runName}-${stamp}.txt`);
    writeFileSync(textFile, `${lines.join("\n")}\n`);
    writeFileSync(join(LOG_DIR, `${runName}-latest.txt`), `${lines.join("\n")}\n`);

    return { payload, jsonFile, textFile, failed };
  }

  return { test, add, finish, records };
}
