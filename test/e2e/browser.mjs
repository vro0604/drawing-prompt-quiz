/**
 * browser.mjs ／ 実際のブラウザで画面を操作して確かめる
 *
 * 実行: npm run test:e2e
 *
 * 【何を確かめるものか】
 *   DB の試験は「呼べば正しく動く」ことしか見ていない。
 *   ここで見るのは、**画面に出ているか・押せるか・秒が動くか**。
 *   Chromium を起動して、人が触るのと同じ順で操作する。
 *
 * 【時間の進め方】
 *   30分待つわけにはいかないので、DB の側で挑戦を過去へ巻き戻す。
 *   **本番の期限判定は1文字も緩めていない。**巻き戻すのは開始時刻と期限で、
 *   判定そのものは本番と同じ関数が同じ規則で行う。
 *   開始時刻を守るトリガーは、巻き戻しの間だけ外して必ず戻す。
 *
 * 【つながる先】
 *   Supabase の代わりに、この端末で立てた PGlite ＋ 小さな API を使う。
 *   本番へは1バイトも送らない。
 */

import { chromium } from "playwright";
import { installLocalOnlyGuard, ALLOWED_HOSTS } from "../guard/no-production.mjs";
import { startApp, warmupRoutes } from "./server.mjs";
import { acquireHeavyLock } from "./exclusive.mjs";
import { createRecorder } from "./record.mjs";
import { recordCount } from "../counts.mjs";
import { answerWork, makeMember, rewindChallenge } from "../db/helpers.mjs";

// **最初のネットワーク要求より前に柵を立てる。**
// 本番のURL・project ref・ホスト名・鍵が環境にあれば、ここで異常終了する。
installLocalOnlyGuard("ブラウザ試験（test:e2e）");

let browser;
let app;
let recorder;

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

/* ---------------------------------------------------------------------------
 * 落ちた瞬間の様子を、試験の本文に手を入れずに拾う
 * ------------------------------------------------------------------------- */

/**
 * いま何をしているか。共通の操作（開く・押す・送る・待つ）が書き換える。
 *
 * **39件の試験の中に1行も足さずに「どの段で落ちたか」を残す**ための仕掛け。
 * 試験ごとに手で段を書くと、書き忘れた試験だけ分からないままになる。
 */
let currentAction = "開始";
function act(label) {
  currentAction = label;
}

/** 開いているページ全部。落ちたときに、どの画面に居たかを拾う */
const openPages = new Set();

/**
 * 最後に画面を移したページ。
 *
 * 開いているページを全部並べると、**別の試験が開いたままの窓**まで混ざる。
 * 落ちた試験がどこに居たかを1つに絞るため、直近で移動したものを先頭に置く。
 */
let lastPage = null;

function seeNow() {
  const urls = [];
  const seen = new Set();
  for (const p of [lastPage, ...openPages]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    try {
      if (!p.isClosed()) urls.push(p.url());
    } catch {
      /* 閉じた直後は掴めない */
    }
  }
  return { stage: currentAction, urls };
}

/** 記録係を通す。呼び方は今までと同じ */
async function test(group, name, fn) {
  currentAction = `${group} / ${name}: 開始`;
  return recorder.test(group, name, fn);
}

/**
 * 押す前に、その部品を画面の真ん中へ寄せる。
 *
 * 帯は画面の上に貼り付くので、下までスクロールした状態だと
 * **押したい部品が帯の下に入ることがある。**人なら少し動かして押すが、
 * 自動の操作は動かさないので、ここで寄せてから押す。
 *
 * 【やり直すのは、押す位置が動いたときだけ】
 *   何でもやり直すと、**部品がそもそも出ていない失敗まで通ってしまう。**
 *   出ていないものを3回待てば、待ち時間が3倍になるだけで結果は変わらず、
 *   原因だけが見えなくなる。
 *
 *   やり直すのは「押そうとした瞬間に、押す先が動いた・別のものが上に来た・
 *   画面から外れた・作り直された」のときだけにする。これは人が押すときにも
 *   起きることで、押し直せば通る。それ以外は**1回で落とす。**
 *
 * 【やり直したことは記録に残す】
 *   1回目で通ったのか3回目で通ったのかは、同じ「合格」でも意味が違う。
 *   やり直した回数を数えて、記録ファイルへ残す。
 */

/** 押し直してよい理由。押す先が動いた・覆われた・作り直された、のいずれか */
const RETRYABLE_CLICK = [
  "element is not stable",
  "intercepts pointer events",
  "element is outside of the viewport",
  "element is not visible",     // 直後に描き直されて一瞬消えることがある
  "detached from the DOM",
  "Element is not attached",
  "Node is detached",
];

/** この実行で押し直した回数（試験ごとに数え直す） */
let clickRetries = 0;
function takeClickRetries() {
  const n = clickRetries;
  clickRetries = 0;
  return n;
}

async function clickSafely(locator) {
  act(`部品を押す: ${locator.toString?.() ?? "locator"}`);
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    } catch {
      /* 画面が描き直された直後は掴めない。次の click が待つ */
    }
    try {
      await locator.click({ timeout: 15000 });
      return;
    } catch (e) {
      last = e;
      const text = String(e?.message ?? "");
      const retryable = RETRYABLE_CLICK.some((m) => text.includes(m));
      if (!retryable) throw e;    // **出ていない・押せないは、その場で落とす**
      clickRetries += 1;
      act(`部品を押し直す（${attempt + 1}回目が失敗: ${text.split("\n")[0]}）`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  throw last;
}

/**
 * 送信のボタンを押して、**サーバーの処理が終わるまで待つ。**
 *
 * networkidle だけでは足りない。押した瞬間はもう「静か」なので、
 * 待たずに次へ進み、まだ保存されていない状態を読んでしまう
 * （実測で、保存できているのに0件と判定していた）。
 * 送信の応答を待ってから、画面の描き直しぶんだけ置く。
 *
 * **ここで「画面が変わるまで」を待たない。**変わらない送信もあるし、
 * めくる操作のように何度も押すところでは待ち時間が積み上がる。
 * 画面が変わったかどうかは、読む側（assertBody）が待つ。
 */
async function submitAndSettle(page, locator) {
  act(`送信して応答を待つ（${page.url()}）`);
  const waiting = page
    .waitForResponse((r) => r.request().method() === "POST", { timeout: 20000 })
    .catch(() => null);
  await clickSafely(locator);
  await waiting;
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(600);
}

/**
 * 本文が画面に届くまで待ってから、body の文字を読む。
 *
 * 【なぜ要るか】
 *   この画面はサーバーで組み立てて**少しずつ送られてくる。**外枠
 *   （サービス名・メニュー）が先に届き、本文はそのあとで届く。
 *   一覧には「読み込み中…」の差し替え表示もある。
 *   届く前に読むと、本文が空のまま判定してしまう。
 *
 *   2026-09-06 に実測。ブラウザ試験を5回続けたうちの3回目で、
 *   「サインインできていない」と「2択当てで的中しなかった」の2件が落ちた。
 *   どちらも**画面には出ていた。**読むのが早すぎただけで、
 *   落ちた時点の本文は「つたわるかな」（外枠だけ）だった。
 *
 * 【待ち時間を伸ばして隠すのとは違う】
 *   決まった秒数を待つのではなく、**本文が入ったこと**を条件にしている。
 *   入らなければ時間切れで落ちる。そのとき何が出ていたかも添える。
 */
async function settledBody(page, { timeout = 15000 } = {}) {
  act(`本文が届くのを待つ（${page.url()}）`);
  try {
    await page.waitForFunction(
      () => {
        const main = document.querySelector("main");
        if (!main) return false;
        const text = (main.innerText ?? "").replace(/\s+/g, " ").trim();
        return text.length > 0 && !text.includes("読み込み中…");
      },
      { timeout },
    );
  } catch (e) {
    // ここで settledBody を呼ばない（自分を呼び直して止まらなくなる）
    const seen = (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 300);
    throw new Error(`${e.message}\n      本文が届きませんでした。画面: ${seen}`);
  }

  // **描き足しが止まるまで待つ。**
  //   本文は一度に来るとは限らない。上のほう（回答の結果）が先に出て、
  //   下のほう（お題の開示・持ち出し）があとから足されることがある。
  //   途中で読むと、まだ来ていない部分を「出ていない」と判定してしまう。
  //
  //   決まった秒数を待つのではなく、**同じ長さが3回続いたら止まったとみなす。**
  //   止まらなければ 8 秒で切り上げ、そのときの中身をそのまま返す
  //   （判定は呼んだ側がする。ここで失敗を作らない）。
  //
  //   見るのは main の中だけ。画面上部の帯は秒が毎秒変わるので、
  //   body 全体を見ると永久に止まらない。
  const until = Date.now() + 8000;
  let last = -1;
  let same = 0;
  while (Date.now() < until && same < 3) {
    const size = await page
      .evaluate(() => (document.querySelector("main")?.innerText ?? "").length)
      .catch(() => -1);
    same = size === last ? same + 1 : 0;
    last = size;
    if (same < 3) await page.waitForTimeout(200);
  }

  return page.innerText("body");
}


/**
 * 本文にその言葉が出るまで待ってから判定する。
 *
 * 【なぜ「読んでから判定」ではだめか】
 *   このサービスの送信は Server Action で、応答が返ったあとに
 *   **もう一度サーバーから画面を取り直す。**その2回目が届く前に読むと、
 *   前の画面を見て「出ていない」と判定してしまう。
 *
 *   2026-09-06 に実測。ブラウザ試験を続けて回すと、**毎回ちがう1〜2件**が
 *   この形で落ちた（持ち出しの案内・作者の言葉・返歌の欄・サインインの表示・
 *   2択当ての結果）。落ちた瞬間の本文を残すようにして初めて分かった。
 *   どれも画面には出ていて、**読むのが早すぎただけ**だった。
 *
 * 【待ち時間を伸ばして隠すのとは違う】
 *   決まった秒数を待つのではなく、**出るべきものが出たこと**を条件にする。
 *   出なければ 10 秒で時間切れになり、そのとき画面に何が出ていたかを添えて
 *   落ちる。出ないものは、いままでどおり不合格になる。
 *
 * @param page    見ている画面
 * @param pattern 出るはずの言葉（正規表現）
 * @param message 出なかったときに書くこと
 */
async function assertBody(page, pattern, message, { timeout = 10000 } = {}) {
  try {
    await page.waitForFunction(
      (src) =>
        new RegExp(src).test((document.body.innerText ?? "").replace(/\s+/g, " ")),
      pattern.source,
      { timeout },
    );
  } catch {
    const seen = (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${message}: ${seen}`);
  }
}

/** 帯の中身を読む */
async function readBar(page) {
  const bar = page.locator("[data-challenge-bar]");
  if ((await bar.count()) === 0) return null;
  return {
    text: (await bar.innerText()).replace(/\s+/g, " "),
    elapsed: Number(await bar.getAttribute("data-elapsed")),
    kind: await bar.getAttribute("data-kind"),
    expired: (await bar.getAttribute("data-expired")) === "1",
    finished: (await bar.getAttribute("data-finished")) === "1",
    stale: (await bar.getAttribute("data-stale")) === "1",
  };
}

/** 帯が出るまで待つ */
async function waitForBar(page, timeout = 15000) {
  act(`帯が出るのを待つ（${page.url()}）`);
  await page.waitForSelector("[data-challenge-bar]", { timeout });
  return readBar(page);
}

/** いまその人が進めているドラフトのIDを DB から取る（試験の準備） */
async function currentSessionId(db) {
  const { rows } = await db.query(
    `select id from public.draft_sessions where status = 'in_progress'
      order by started_at desc limit 1`,
  );
  return rows[0]?.id ?? null;
}


/** /play からお題を確定するところまで進める */
async function drawThroughUi(page, base, { timeLimit = "1800" } = {}) {
  act("/play を開いてお題を引き始める");
  await page.goto(`${base}/play`);
  await page.selectOption("select[name=timeLimitSeconds]", timeLimit);
  await page.getByRole("button", { name: "ドラフトを始める" }).click();

  // **waitForURL は使えない。**送信先が同じ /play なので、
  // 押した瞬間にもう条件を満たしていて、待たずに次へ進んでしまう。
  // 盤面（伏せカード）が出たことで、始まったと判断する。
  act("盤面（伏せカード）が出るのを待つ");
  await page.waitForSelector("button[data-card=hidden]", { timeout: 20000 });

  try {
    await page.waitForSelector("[data-challenge-bar]", { timeout: 15000 });
  } catch (e) {
    // **なぜ出なかったかを言えるようにする。**画面の文言をそのまま添える
    const body = (await page.innerText("body")).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`${e.message}\n      画面: ${body}`);
  }
}

/**
 * 伏せカードを、決まるまで「めくる → これに決める」で1枠ずつ進める。
 *
 * 【2026-09-07 に2段になった（D170）】
 *   めくっただけでは確定しない。中身を見てから「これに決める」を押して
 *   初めて枠が進む。**めくるだけを繰り返すと、いつまでも先へ進まない。**
 *
 * 押した直後のボタンは塞がる（disabled）ので、
 * **押せる状態のものだけ**を選ぶ。塞がったものを押そうとすると待ち続ける。
 */
async function revealAll(page) {
  act("伏せカードをめくって決める");
  for (let i = 0; i < 24; i += 1) {
    const decide = page.locator("button:not([disabled])", { hasText: "これに決める" });
    if ((await decide.count()) > 0) {
      await submitAndSettle(page, decide.first());
      continue;
    }
    const buttons = page.locator("button[data-card=hidden]:not([disabled])");
    if ((await buttons.count()) === 0) break;
    await submitAndSettle(page, buttons.first());
  }
}

/** その人がサインインする（登録者の種データは全部この合言葉） */
async function signInAs(page, base, email) {
  await page.goto(`${base}/account`);
  const form = "form:has(button:has-text('サインインする'))";
  await page.locator(`${form} input[name=email]`).fill(email);
  await page.locator(`${form} input[name=password]`).fill("dummy-password");
  await page.getByRole("button", { name: "サインインする" }).click();
  await page.waitForLoadState("networkidle");
  await settledBody(page);
}

/**
 * その人の名前で、お題を1件だけ新しく確定させ、そのお題のIDを返す。
 *
 * 先に、進行中のドラフトを片づける。/play は進行中のものがあれば
 * その続きを出すので、片づけないと「新しく引く」にならない。
 */
async function drawFreshPrompt(page, base, db, userId) {
  await db.query(
    `update public.draft_sessions set status = 'abandoned', abandoned_at = now()
      where user_id = $1 and status = 'in_progress'`,
    [userId],
  );

  await drawThroughUi(page, base, { timeLimit: "3600" });
  await revealAll(page);
  await clickSafely(page.getByRole("button", { name: "このお題で確定する" }));
  await page.waitForURL("**/prompt/**");

  const id = /\/prompt\/([0-9a-fA-F-]{36})/.exec(page.url());
  if (!id) throw new Error(`お題のIDが読めない: ${page.url()}`);
  return id[1];
}

/**
 * ブラウザが出した通信を1本ずつ見張る。
 *
 * 【なぜ環境変数の検査だけでは足りないか】
 *   環境変数はアプリが**どこへつなぐか**を決めるが、ブラウザは
 *   ページに書かれた URL へも取りに行く。外部の JavaScript を1行足すと、
 *   環境変数は何も変わらないまま外へ出る。**出た先を数えるしかない。**
 *
 * 【許すもの】
 *   ・127.0.0.1 / localhost … 検証用に立てたアプリと API
 *   ・challenges.cloudflare.com … CAPTCHA の**公開テスト鍵**の受け口。
 *     常に通る公開値で、このプロジェクトのデータも鍵も送らない。
 *     ここだけは名前で許可し、それ以外はすべて不合格にする。
 */
const E2E_ALLOWED_EXTERNAL = new Set(["challenges.cloudflare.com"]);
const externalRequests = new Map();

function watchContext(ctx) {
  // 開いたページを覚える。**落ちたときに、どの画面に居たかを言うため。**
  ctx.on("page", (p) => {
    openPages.add(p);
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) lastPage = p;
    });
    p.on("close", () => {
      openPages.delete(p);
      if (lastPage === p) lastPage = null;
    });
    p.on("crash", () => act(`ページが落ちた（${(() => { try { return p.url(); } catch { return "?"; } })()}）`));
  });
  ctx.on("request", (req) => {
    let host;
    try {
      host = new URL(req.url()).hostname;
    } catch {
      return;
    }
    if (ALLOWED_HOSTS.has(host)) return;
    externalRequests.set(host, (externalRequests.get(host) ?? 0) + 1);
  });
  return ctx;
}

async function main() {
  app = await startApp({ port: 3220 });

  recorder = createRecorder({
    runName: "e2e",
    serverLogs: app.logs,
    probe: seeNow,
    collect: () => ({ clickRetries: takeClickRetries() }),
  });

  /* --- 先に画面を温める ---------------------------------------------------
   *
   * `next dev` は要求が来て初めてその画面を組み立てる。組み立ては数秒
   * かかることがあり、混んでいれば伸びる。温めずに試験へ入ると、その
   * 組み立て時間が「部品が15秒以内に出ない」という形で試験の失敗になる。
   * **試験の待ち時間は1ミリ秒も伸ばしていない。**組み立てを試験の外へ出した。
   */
  const warm = await warmupRoutes(app.base, [
    "/",
    "/play",
    "/works",
    "/works?tab=ai",
    "/works?tab=fanart",
    "/works?unanswered=1",
    `/works/${app.seeded.works[0].workId}`,
    `/works/${app.seeded.divisionWorks.fanart[0]}`,
    `/works/${app.seeded.divisionWorks.ai[0]}`,
    `/works/${app.seeded.hardWork}`,
    "/rankings",
    "/saves",
    "/account",
    "/account/signin",
    `/u/${"e2e-author"}`,
    "/terms",
    "/privacy",
  ]);
  const warmBad = warm.filter((w) => w.error || (w.status ?? 500) >= 500);
  console.log(
    `（画面の下ごしらえ: ${warm.length} 本 / 最も遅い ` +
      `${Math.max(...warm.map((w) => w.ms))}ms / 失敗 ${warmBad.length} 本）`,
  );
  if (warmBad.length > 0) {
    // **準備の失敗は、試験の失敗として数えない。**別の名前で出す
    throw new Error(
      "画面の下ごしらえに失敗しました（試験の失敗ではありません）:\n" +
        warmBad.map((w) => `  ${w.path} … ${w.error ?? `HTTP ${w.status}`}`).join("\n"),
    );
  }

  browser = await chromium.launch();

  // すべての context に見張りを付ける。**付け忘れる場所を作らない**ため、
  // 個々の呼び出し側ではなく newContext そのものを包む
  const openContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => watchContext(await openContext(...args));

  const { base, db, seeded } = app;

  /* =====================================================================
   * A. ゲストの流れ（共有URL → 回答 → 次の作品 → 制作開始）
   * ===================================================================== */

  const guest = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const g = await guest.newPage();

  await test("A", "共有URLを開いたゲストに、答えが出ていない", async () => {
    await g.goto(`${base}/works/${seeded.works[1].workId}`);
    const html = await g.content();

    const { rows } = await db.query(
      `select t.label from public.prompt_cards pc join public.tags t on t.id = pc.tag_id
        where pc.prompt_id = $1`,
      [seeded.works[1].promptId],
    );
    // 4択には正解が並ぶので、**正解の印**が無いことを見る
    assert(!html.includes("is_correct"), "正解の印が画面に出ている");
    assert(rows.length > 0, "お題の語が取れない（準備の失敗）");
    assert(html.includes("この絵のお題を当てる"), "クイズが出ていない");
  });

  await test("A", "ゲストがそのまま回答でき、結果が出る", async () => {
    const groups = g.locator("fieldset");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    const n = await groups.count();
    for (let i = 0; i < n; i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(g, g.getByRole("button", { name: "回答する" }));

    const body = await settledBody(g);
    assert(body.includes("この絵のお題"), "回答後にお題が開示されていない");
  });

  await test("A", "回答後に「次の作品」で別の作品へ進める", async () => {
    const before = g.url();
    await clickSafely(g.getByRole("button", { name: "次の作品に答える" }));
    await g.waitForURL((u) => u.toString() !== before, { timeout: 20000 });
    assert(/\/works\//.test(g.url()), `作品ページ以外へ移った（${g.url()}）`);
  });

  await test("A", "ゲストがそのまま制作を始められ、帯が出る", async () => {
    await drawThroughUi(g, base, { timeLimit: "1800" });
    const bar = await readBar(g);
    assert(bar !== null, "制作を始めても帯が出ない");
    assert(bar.kind === "draft", `帯の区分が ${bar.kind}（draft のはず）`);
    assert(/30分枠/.test(bar.text), `枠が出ていない: ${bar.text}`);
    assert(/経過 \d\d:\d\d:\d\d/.test(bar.text), `経過が出ていない: ${bar.text}`);
    assert(/残り \d\d:\d\d:\d\d/.test(bar.text), `残りが出ていない: ${bar.text}`);
  });

  /* =====================================================================
   * B. 帯が全ページに出て、勝手に進む
   * ===================================================================== */

  await test("B", "どのページへ移動しても帯が出ている", async () => {
    for (const path of ["/", "/works", "/rankings", "/saves", "/account", "/play"]) {
      await g.goto(`${base}${path}`);
      const bar = await waitForBar(g);
      assert(bar !== null, `${path} に帯が出ない`);
      assert(bar.elapsed >= 0, `${path} の経過が読めない`);
    }
  });

  await test("B", "帯の秒が、操作しなくても進む", async () => {
    await g.goto(`${base}/works`);
    const first = await waitForBar(g);
    await g.waitForTimeout(3000);
    const second = await readBar(g);
    assert(
      second.elapsed > first.elapsed,
      `経過が ${first.elapsed} から ${second.elapsed} へ進んでいない`,
    );
  });

  await test("B", "帯が本文にもヘッダーにも重なっていない", async () => {
    await g.goto(`${base}/works`);
    await waitForBar(g);
    await g.evaluate(() => window.scrollTo(0, 0));
    const boxes = await g.evaluate(() => {
      const bar = document.querySelector("[data-challenge-bar]").getBoundingClientRect();
      const header = document.querySelector("[data-site-nav]").getBoundingClientRect();
      const main = document.querySelector("main")?.getBoundingClientRect() ?? null;
      return { bar, header, main };
    });
    assert(boxes.bar.bottom <= boxes.header.top + 1, "帯がヘッダーに重なっている");
    if (boxes.main) {
      assert(boxes.bar.bottom <= boxes.main.top + 1, "帯が本文に重なっている");
    }
    assert(boxes.bar.height > 0, "帯の高さが0（場所を占めていない）");
  });

  await test("B", "スクロールしても帯が見えている", async () => {
    await g.goto(`${base}/works`);
    await waitForBar(g);
    await g.evaluate(() => window.scrollTo(0, 2000));
    await g.waitForTimeout(300);
    const top = await g.evaluate(
      () => document.querySelector("[data-challenge-bar]").getBoundingClientRect().top,
    );
    assert(top >= -1 && top < 5, `スクロール後の帯の位置が ${top}（上に残っていない）`);
  });

  await test("B", "再読込しても経過が続く（0に戻らない）", async () => {
    const before = await readBar(g);
    await g.reload();
    const after = await waitForBar(g);
    assert(
      after.elapsed >= before.elapsed,
      `再読込で経過が ${before.elapsed} → ${after.elapsed} へ戻った`,
    );
  });

  await test("B", "背面から戻ったとき、閉じていた間の時間も入っている", async () => {
    const before = await readBar(g);

    // 背面にいる間に、サーバー側で5分進んだことにする
    const sessionId = await currentSessionId(db);
    await rewindChallenge(db, { sessionId }, 300);

    // タブが前面に戻ったときと同じ知らせを出す
    await g.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await g.waitForTimeout(1500);

    const after = await readBar(g);
    assert(
      after.elapsed >= before.elapsed + 290,
      `復帰後の経過が ${after.elapsed}（${before.elapsed + 300} 前後のはず）`,
    );
  });

  await test("B", "2つのタブで同じ経過が出る", async () => {
    const second = await guest.newPage();
    await second.goto(`${base}/rankings`);
    const a = await waitForBar(g);
    const b = await waitForBar(second);
    assert(Math.abs(a.elapsed - b.elapsed) <= 3, `タブ間で ${a.elapsed} と ${b.elapsed}`);
    await second.close();
  });

  await test("B", "帯の中身が、他の人のものと混ざらない（キャッシュ対策）", async () => {
    const headers = await g.evaluate(async () => {
      const res = await fetch("/api/challenge", { cache: "no-store" });
      return {
        cache: res.headers.get("cache-control") ?? "",
        vary: res.headers.get("vary") ?? "",
      };
    });
    assert(/no-store/.test(headers.cache), `Cache-Control が ${headers.cache}`);
    assert(/private/.test(headers.cache), `private が付いていない: ${headers.cache}`);
    assert(/Cookie/i.test(headers.vary), `Vary が ${headers.vary}`);

    // 別の人が同じURLを開いても、自分の挑戦が返らない
    const other = await browser.newContext();
    const op = await other.newPage();
    await op.goto(`${base}/works`);
    const body = await op.evaluate(async () => {
      const res = await fetch("/api/challenge", { cache: "no-store" });
      return res.text();
    });
    assert(
      JSON.parse(body).challenge === null,
      `挑戦していない人に他人の帯が返った: ${body.slice(0, 200)}`,
    );
    await other.close();
  });

  /* =====================================================================
   * C. 時間の規則（更新・超過・猶予・無制限）
   * ===================================================================== */

  await test("C", "残りが 1/4 を切るまで、延ばすボタンは出ない", async () => {
    await g.goto(`${base}/play`);
    await waitForBar(g);
    const count = await g.locator("[data-action=renew]").count();
    assert(count === 0, "始めた直後から延ばせてしまう");
  });

  await test("C", "1/4 を切ると延ばせて、押すと残りが 0.75T になる", async () => {
    const sessionId = await currentSessionId(db);
    // 30分枠（T = 1800秒）。更新できるのは残りが 0.25T = 450秒 を切ってから。
    // 残り 350秒 になるところまで進める
    await rewindChallenge(db, { sessionId }, 1800 - 350);
    await g.reload();
    await waitForBar(g);

    const before = await readBar(g);
    await clickSafely(g.locator("[data-action=renew]"));
    await g.waitForTimeout(2000);
    const after = await readBar(g);

    const left = /残り (\d\d):(\d\d):(\d\d)/.exec(after.text);
    assert(left, `更新後に残りが出ていない: ${after.text}`);
    assert(
      !/延ばせませんでした|通信できませんでした/.test(after.text),
      `更新が断られた: ${after.text}`,
    );
    const seconds = Number(left[1]) * 3600 + Number(left[2]) * 60 + Number(left[3]);
    assert(
      seconds > 1300 && seconds <= 1350,
      `更新後の残りが ${seconds} 秒（0.75T = 1350秒のはず）。帯: ${after.text}`,
    );
    assert(
      after.elapsed >= before.elapsed,
      `更新で経過が ${before.elapsed} → ${after.elapsed} へ減った`,
    );
    assert(/1 回延長/.test(after.text), `延長の回数が出ていない: ${after.text}`);
  });

  await test("C", "期限を過ぎると、超過と猶予の残りが出る", async () => {
    const sessionId = await currentSessionId(db);
    // 更新後の期限は「押した時刻 ＋ 0.75T = 1350秒」。そこを3分だけ過ぎさせる
    await rewindChallenge(db, { sessionId }, 1350 + 180);
    await g.reload();
    const bar = await waitForBar(g);

    assert(/超過 \d\d:\d\d:\d\d/.test(bar.text), `超過が出ていない: ${bar.text}`);
    assert(/猶予残り \d\d:\d\d:\d\d/.test(bar.text), `猶予の残りが出ていない: ${bar.text}`);
    assert(bar.expired === false, "猶予の中なのに終了になっている");
    await g
      .locator("[data-action=renew]")
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => null);
    assert(
      (await g.locator("[data-action=renew]").count()) === 1,
      "猶予の中なのに延ばせない",
    );
  });

  await test("C", "通信できないときは「未同期」と出て、延ばせたことにしない", async () => {
    const sessionId = await currentSessionId(db);
    const before = (
      await db.query(`select renew_count from public.draft_sessions where id = $1`, [sessionId])
    ).rows[0].renew_count;

    await guest.setOffline(true);
    try {
      // 取り直しのきっかけを1つ起こす（30秒待たずに済ませる）
      await g.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await g.waitForSelector("[data-field=stale]", { timeout: 10000 });

      const stale = await g.locator("[data-field=stale]").innerText();
      assert(/未同期/.test(stale), `未同期と出ていない: ${stale}`);

      // つながらない状態で押しても、**延びたことにしない**
      await g.locator("[data-action=renew]").click();
      await g.waitForTimeout(1500);

      const text = (await g.locator("[data-challenge-bar]").innerText()).replace(/\s+/g, " ");
      assert(
        /時間は延びていません|延ばせませんでした/.test(text),
        `延ばせなかったことが出ていない: ${text}`,
      );
      assert(!/制作時間を延ばしました/.test(text), `成功として出ている: ${text}`);
    } finally {
      await guest.setOffline(false);
    }

    const after = (
      await db.query(`select renew_count from public.draft_sessions where id = $1`, [sessionId])
    ).rows[0].renew_count;
    assert(
      after === before,
      `通信できないのに更新回数が ${before} → ${after} に増えた`,
    );

    // つながり直したら「未同期」が消える
    await g.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await g.waitForTimeout(1500);
    assert(
      (await g.locator("[data-field=stale]").count()) === 0,
      "つながり直しても未同期のままになっている",
    );
  });

  await test("C", "猶予を使い切ると、どのページでも終了と分かる", async () => {
    const sessionId = await currentSessionId(db);
    // 猶予は 0.5T = 15分。さらに過ぎさせる
    await rewindChallenge(db, { sessionId }, 1200);

    await g.goto(`${base}/works`);
    const bar = await waitForBar(g);
    assert(bar.expired === true, `終了になっていない: ${bar.text}`);
    assert(/挑戦が終了しました/.test(bar.text), `終了の表示が無い: ${bar.text}`);
    assert(
      (await g.locator("[data-action=renew]").count()) === 0,
      "終了したのに延ばすボタンが出ている",
    );
  });

  await test("C", "終了しても、勝手に別のページへ飛ばされない", async () => {
    const url = g.url();
    await g.waitForTimeout(2500);
    assert(g.url() === url, `${url} から ${g.url()} へ勝手に移動した`);
  });

  await test("C", "終了しても、書きかけの入力が消えない", async () => {
    await g.goto(`${base}/account`);
    await waitForBar(g);
    const input = g.locator("input[name=email]").first();
    await input.fill("kakikake@example.test");
    await g.waitForTimeout(3000);
    assert(
      (await input.inputValue()) === "kakikake@example.test",
      "帯の更新で入力が消えた",
    );
  });

  await test("C", "無制限は、経過だけが出て期限も更新も無い", async () => {
    // 終わった挑戦を片づけてから、無制限で始め直す
    await db.query(
      `update public.draft_sessions set status = 'abandoned', abandoned_at = now()
        where status = 'in_progress'`,
    );
    await drawThroughUi(g, base, { timeLimit: "" });

    const bar = await readBar(g);
    assert(/無制限/.test(bar.text), `無制限と出ていない: ${bar.text}`);
    assert(/経過 \d\d:\d\d:\d\d/.test(bar.text), `経過が出ていない: ${bar.text}`);
    assert(!/残り/.test(bar.text), `無制限なのに残りが出ている: ${bar.text}`);
    assert(!/猶予/.test(bar.text), `無制限なのに猶予が出ている: ${bar.text}`);
    assert(
      (await g.locator("[data-action=renew]").count()) === 0,
      "無制限なのに延ばすボタンが出ている",
    );
  });

  /* =====================================================================
   * D. ドラフト開始から確定までの引き継ぎ
   * ===================================================================== */

  await test("D", "カードをめくっていた時間が、確定しても消えない", async () => {
    await db.query(
      `update public.draft_sessions set status = 'abandoned', abandoned_at = now()
        where status = 'in_progress'`,
    );
    await drawThroughUi(g, base, { timeLimit: "3600" });

    const sessionId = await currentSessionId(db);
    // カードを20分眺めた
    await rewindChallenge(db, { sessionId }, 1200);
    await g.reload();
    const inDraft = await waitForBar(g);
    assert(inDraft.elapsed >= 1200, `ドラフト中の経過が ${inDraft.elapsed} 秒`);

    await revealAll(g);
    await clickSafely(g.getByRole("button", { name: "このお題で確定する" }));
    await g.waitForURL("**/prompt/**");
    const afterFix = await waitForBar(g);

    assert(afterFix.kind === "prompt", `確定後の区分が ${afterFix.kind}`);
    assert(
      afterFix.elapsed >= inDraft.elapsed,
      `確定で経過が ${inDraft.elapsed} → ${afterFix.elapsed} へ戻った`,
    );

    const left = /残り (\d\d):(\d\d):(\d\d)/.exec(afterFix.text);
    assert(left, `確定後に残りが出ていない: ${afterFix.text}`);
    const seconds = Number(left[1]) * 3600 + Number(left[2]) * 60 + Number(left[3]);
    assert(
      seconds <= 3600 - 1200 + 30,
      `確定で残りが ${seconds} 秒へ増えた（時計が取り直されている）`,
    );
  });

  /* =====================================================================
   * E. 持ち出し（ゲストのセッション内）
   * ===================================================================== */

  await test("E", "ゲストの持ち出しは、お題を確定すると手元から消える", async () => {
    const guest2 = await browser.newContext();
    const p = await guest2.newPage();

    await p.goto(`${base}/works/${seeded.works[2].workId}`);
    const groups = p.locator("fieldset");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    for (let i = 0; i < (await groups.count()); i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(p, p.getByRole("button", { name: "回答する" }));

    await settledBody(p);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(p, /いまの流れの中だけ/, "ゲストに「いまの流れの中だけ」の説明が出ていない");

    await p.locator("[data-revealed-card] input[type=checkbox]").first().check();
    await submitAndSettle(p, p.getByRole("button", { name: /1つの保存枠にする/ }));

    // **押したあとの案内で「保存した」と思わせない。**
    // ゲストの持ち出しは永続しないので、そのことをその場で書く。
    const afterSave = await settledBody(p);
    await assertBody(p, /これは保存ではありません/, `ゲストに「保存ではない」と伝えていない: ${afterSave.replace(/\s+/g, " ").slice(0, 300)}`);
    await assertBody(p, /この流れの間だけ使えます/, "ゲストに「この流れの間だけ」と伝えていない");
    assert(
      !/保存枠にしました/.test(afterSave),
      "ゲストに「保存枠にしました」と出ている（残ると誤解させる）",
    );

    await p.goto(`${base}/play`);
    await p
      .locator("[data-carry-slot][data-scope=session]")
      .first()
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => null);
    assert(
      (await p.locator("[data-carry-slot][data-scope=session]").count()) >= 1,
      "持ち出した保存枠が /play に出ていない",
    );
    assert(
      (await p.locator("[data-carry-slot][data-scope=session] [data-saved-element]").count()) >= 1,
      "保存枠の中の要素が /play に出ていない",
    );

    await p.locator("[data-saved-element] input[type=checkbox]").first().check();
    await clickSafely(p.getByRole("button", { name: "ドラフトを始める" }));
    await p.waitForSelector("button[data-card=hidden]", { timeout: 20000 });
    await revealAll(p);

    const confirm = p.getByRole("button", { name: "このお題で確定する" });
    if ((await confirm.count()) === 0) {
      const body = (await p.innerText("body")).replace(/\s+/g, " ").slice(0, 400);
      throw new Error(`確定のボタンが出ていない。画面: ${body}`);
    }
    await clickSafely(confirm);
    await p.waitForURL("**/prompt/**");

    await p.goto(`${base}/play`);
    const bodyAfter = await settledBody(p);
    assert(
      !/持ち出した要素を使う/.test(bodyAfter),
      "お題を確定したのに、セッション内の持ち出しが残っている",
    );
    await guest2.close();
  });

  /* =====================================================================
   * F. 登録者（自己・他者の保存、上限、破棄、再利用）
   * ===================================================================== */

  const memberCtx = await browser.newContext();
  const m = await memberCtx.newPage();

  await test("F", "登録者としてサインインできる", async () => {
    await m.goto(`${base}/account`);
    await m.locator("form:has(button:has-text('サインインする')) input[name=email]").fill(
      seeded.memberEmail,
    );
    await m
      .locator("form:has(button:has-text('サインインする')) input[name=password]")
      .fill("dummy-password");
    await m.getByRole("button", { name: "サインインする" }).click();
    await m.waitForLoadState("networkidle");
    await settledBody(m);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(m, /登録ユーザーとしてサインインしています/, "サインインできていない");
  });

  await test("F", "他者のお題に答えて、要素を1つ持ち出せる", async () => {
    await m.goto(`${base}/works/${seeded.works[0].workId}`);

    const groups = m.locator("fieldset");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    const n = await groups.count();
    assert(n > 0, "回答の欄が出ていない");
    for (let i = 0; i < n; i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(m, m.getByRole("button", { name: "回答する" }));

    await m.locator("[data-revealed-card] input[type=checkbox]").first().check();
    await submitAndSettle(m, m.getByRole("button", { name: /1つの保存枠にする/ }));

    const { rows } = await db.query(
      `select scope, id from public.saved_carry_slots where user_id = $1`,
      [seeded.viewer],
    );
    const others = rows.filter((r) => r.scope === "others");
    assert(
      others.length === 1,
      `他者からの保存枠が ${others.length} 枠（1枠のはず）。`
        + `保存された区分: ${JSON.stringify(rows.map((r) => r.scope))}。`
        + `いまのURL: ${decodeURIComponent(m.url())}`,
    );
  });

  await test("F", "上限（保存枠3枠）に達すると画面に断りが出る（勝手に押し出さない）", async () => {
    // 上限の3枠まで埋める。**画面で3回押すのではなく、状態を作ってから試す。**
    // 押した回数ではなく「上限に達したときの振る舞い」を見たいため。
    //
    // 数えるのは**保存枠の数**であって語の数ではない（2026-09-05 に確定）。
    // だからここでは、わざと1枠に2要素を入れる。
    // 要素の数で数えていたら、この時点で上限を超えてしまう。
    const { rows: fill } = await db.query(
      `select pc.tag_id from public.works w
         join public.prompt_cards pc on pc.prompt_id = w.prompt_id
        where w.user_id <> $1
          and not exists (select 1 from public.saved_elements se
                           where se.user_id = $1 and se.tag_id = pc.tag_id)
        group by pc.tag_id limit 3`,
      [seeded.viewer],
    );
    assert(fill.length === 3, "上限まで埋める語が足りない（準備の失敗）");

    // 1枠目に2要素、2枠目に1要素。すでに1枠あるので合計3枠になる
    const groupsOfTags = [fill.slice(0, 2).map((r) => r.tag_id), [fill[2].tag_id]];
    for (const tagIds of groupsOfTags) {
      const slot = (
        await db.query(
          `insert into public.saved_carry_slots (user_id, scope, source_is_own)
           values ($1, 'others', false) returning id`,
          [seeded.viewer],
        )
      ).rows[0].id;

      let pos = 0;
      for (const tagId of tagIds) {
        pos += 1;
        await db.query(
          `insert into public.saved_elements
             (user_id, tag_id, scope, source_is_own, carry_slot_id, position)
           values ($1, $2, 'others', false, $3, $4)`,
          [seeded.viewer, tagId, slot, pos],
        );
      }
    }

    const before = await db.query(
      `select count(*)::int as n from public.saved_carry_slots
        where user_id = $1 and scope = 'others'`,
      [seeded.viewer],
    );
    assert(before.rows[0].n === 3, `準備の時点で ${before.rows[0].n} 枠`);

    const beforeElements = await db.query(
      `select count(*)::int as n from public.saved_elements
        where user_id = $1 and scope = 'others'`,
      [seeded.viewer],
    );
    assert(
      beforeElements.rows[0].n === 4,
      `要素が ${beforeElements.rows[0].n} 個（4個のはず。枠で数えるので上限内）`,
    );

    // もう1件、別の作品から持ち出そうとする
    await m.goto(`${base}/works/${seeded.works[1].workId}`);
    const groups = m.locator("fieldset");
    const n = await groups.count();
    if (n > 0) {
      for (let i = 0; i < n; i += 1) {
        await groups.nth(i).locator("input[type=checkbox]").first().check();
      }
      await submitAndSettle(m, m.getByRole("button", { name: "回答する" }));
      await m.waitForLoadState("networkidle");
    }

    await m.locator("[data-revealed-card] input[type=checkbox]").first().check();
    await submitAndSettle(m, m.getByRole("button", { name: /1つの保存枠にする/ }));

    const body = await settledBody(m);
    await assertBody(m, /他の人のお題から持ち出して手元に残せるのは3枠までです/, `上限の断りが画面に出ていない: ${body.replace(/\s+/g, " ").slice(0, 240)}`);

    const after = await db.query(
      `select count(*)::int as n from public.saved_carry_slots
        where user_id = $1 and scope = 'others'`,
      [seeded.viewer],
    );
    assert(after.rows[0].n === 3, `断ったのに ${after.rows[0].n} 枠になった`);
  });

  await test("F", "画面から保存枠を捨てられて、捨てると また保存できる", async () => {
    await m.goto(`${base}/play`);
    await m
      .locator("[data-saved-manage]")
      .first()
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => null);
    const before = await m.locator("[data-saved-manage]").count();
    assert(before === 3, `手元の保存枠が ${before} 枠（3枠のはず）`);

    await submitAndSettle(m, m.locator("[data-discard]").first());

    const afterCount = await m.locator("[data-saved-manage]").count();
    assert(afterCount === 2, `捨てたあとの保存枠が ${afterCount} 枠（2枠のはず）`);

    // 捨てたので、また保存できる
    await m.goto(`${base}/works/${seeded.works[1].workId}`);
    await m.locator("[data-revealed-card] input[type=checkbox]").first().check();
    await submitAndSettle(m, m.getByRole("button", { name: /1つの保存枠にする/ }));

    const { rows } = await db.query(
      `select count(*)::int as n from public.saved_carry_slots
        where user_id = $1 and scope = 'others'`,
      [seeded.viewer],
    );
    assert(rows[0].n === 3, `捨てて保存したあとが ${rows[0].n} 枠（3枠のはず）`);
  });

  await test("F", "保存した要素を、次のお題に持ち込める", async () => {
    await m.goto(`${base}/play`);

    // 画面の文字を切り分けて語を取り出さない（表示の都合でくっつくため）。
    // 選んだ行の id から、その語を DB に聞く
    const savedId = Number(
      await m.locator("[data-saved-element]").first().getAttribute("data-saved-element"),
    );
    const word = (
      await db.query(
        `select t.label from public.saved_elements se
           join public.tags t on t.id = se.tag_id where se.id = $1`,
        [savedId],
      )
    ).rows[0].label;

    await m.locator("[data-saved-element] input[type=checkbox]").first().check();
    await clickSafely(m.getByRole("button", { name: "ドラフトを始める" }));
    await m.waitForSelector("button[data-card=hidden]", { timeout: 20000 });
    await revealAll(m);
    await clickSafely(m.getByRole("button", { name: "このお題で確定する" }));
    await m.waitForURL("**/prompt/**");

    const body = await settledBody(m);
    assert(body.includes(word), `持ち込んだ語「${word}」がお題に入っていない`);
  });

  await test("F", "投稿し終えると時計が止まり、かかった時間が出る", async () => {
    const { rows } = await db.query(
      `select id from public.prompts where created_by = $1 and status = 'active'
        order by started_at desc limit 1`,
      [seeded.viewer],
    );
    assert(rows.length === 1, "投稿できるお題が無い（準備の失敗）");
    const promptId = rows[0].id;

    // 投稿の画面は画像が要る。ここは投稿の受け口を同じ権限で直接通す
    const workId = (await db.query(`select gen_random_uuid() as id`)).rows[0].id;
    const { asRole } = await import("../db/harness.mjs");
    await asRole(
      db,
      { role: "authenticated", uid: seeded.viewer, isAnonymous: false },
      async (c) => {
        await c.query(`select public.create_work($1, $2, $3, $4, 800, 600, 'original')`, [
          workId,
          promptId,
          "帯の検証用",
          `${seeded.viewer}/${workId}.png`,
        ]);
      },
    );

    await m.goto(`${base}/works/${workId}`);
    const bar = await waitForBar(m);
    assert(bar.finished === true, `投稿後も進行中のまま: ${bar.text}`);
    assert(/挑戦を終えました/.test(bar.text), `終了の表示が無い: ${bar.text}`);

    const first = bar.elapsed;
    await m.waitForTimeout(3000);
    const later = await readBar(m);
    assert(later.elapsed === first, `時計が止まっていない（${first} → ${later.elapsed}）`);

    const stored = await db.query(
      `select status, elapsed_seconds from public.prompts where id = $1`,
      [promptId],
    );
    assert(stored.rows[0].status === "submitted", "お題が submitted になっていない");
    assert(
      Number(stored.rows[0].elapsed_seconds) >= 0,
      "かかった時間が記録されていない",
    );
  });

  /* =====================================================================
   * H. フレーバー（ヒントの分離集計と返歌）
   * ===================================================================== */

  /** メールでサインインした新しいタブを作る */
  async function signedInPage(email) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/account`);
    await page
      .locator("form:has(button:has-text('サインインする')) input[name=email]")
      .fill(email);
    await page
      .locator("form:has(button:has-text('サインインする')) input[name=password]")
      .fill("dummy-password");
    await submitAndSettle(page, page.getByRole("button", { name: "サインインする" }));
    await settledBody(page);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(page, /登録ユーザーとしてサインインしています/, `${email} でサインインできない`);
    return { ctx, page };
  }

  await test("H", "作者の言葉を開いてから答えられる（開いた記録が残る）", async () => {
    const { ctx, page } = await signedInPage(seeded.hintReaderEmail);

    await page.goto(`${base}/works/${seeded.flavorWork}`);
    await settledBody(page);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(page, /作者からの言葉があります/, "ヒントの案内が出ていない");

    await submitAndSettle(page, page.getByRole("button", { name: "ヒントとして開く" }));
    await settledBody(page);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(page, /作者からの言葉（ヒント）/, "開いても文章が出ていない");

    const groups = page.locator("fieldset");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    for (let i = 0; i < (await groups.count()); i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(page, page.getByRole("button", { name: "回答する" }));

    const { rows } = await db.query(
      `select hint_used from public.answers where work_id = $1 and user_id = $2`,
      [seeded.flavorWork, seeded.hintReader],
    );
    assert(rows.length === 1, "回答が記録されていない");
    assert(rows[0].hint_used === true, "ヒントを開いた記録が回答に入っていない");

    await ctx.close();
  });

  await test("H", "開かずに答えた人は、別に数えられる", async () => {
    const { ctx, page } = await signedInPage(seeded.plainAnswererEmail);

    await page.goto(`${base}/works/${seeded.flavorWork}`);
    const groups = page.locator("fieldset");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    for (let i = 0; i < (await groups.count()); i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(page, page.getByRole("button", { name: "回答する" }));

    const { rows } = await db.query(
      `select hint_used from public.answers where work_id = $1 and user_id = $2`,
      [seeded.flavorWork, seeded.plainAnswerer],
    );
    assert(rows[0].hint_used === false, "開いていないのに開いた扱いになっている");

    await ctx.close();
  });

  await test("H", "作者の画面で、読んだ人と読まなかった人が分かれて出る", async () => {
    const { ctx, page } = await signedInPage(seeded.authorEmail);

    // 開く前は数字を出さない（D112）。まず、出ていないことを見る
    await page.goto(`${base}/works/${seeded.flavorWork}`);
    const sealed = await settledBody(page);
    assert(
      !/文章を読んだ人と、読まなかった人/.test(sealed),
      "開く前から、ヒントの分離集計が出ている（D112 違反）",
    );

    // 取りに行った人にだけ出る
    await page.goto(`${base}/works/${seeded.flavorWork}?result=open`);
    await settledBody(page);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(page, /文章を読んだ人と、読まなかった人/, "分離集計の欄が作者に出ていない");
    await assertBody(page, /絵だけで答えた人/, "読まなかった人の行が無い");
    await assertBody(page, /文章を読んでから答えた人/, "読んだ人の行が無い");

    await ctx.close();
  });

  await test("H", "回答した人が返歌を送れて、正誤の印は付かない", async () => {
    const { ctx, page } = await signedInPage(seeded.hintReaderEmail);
    await page.goto(`${base}/works/${seeded.flavorWork}`);

    await settledBody(page);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(page, /返歌/, "返歌の欄が出ていない");

    // 返歌の欄は、押して開いてから語を選ぶ形になっている
    await page.getByRole("link", { name: "返歌を作る" }).click();
    await page.waitForLoadState("networkidle");

    // **欄が開くまで待つ。**押した直後はまだ前の画面のことがある
    const boxes = page.locator("form:has(button:has-text('返歌を送る')) input[type=checkbox]");
    await boxes.first().waitFor({ state: "attached", timeout: 15000 });
    const n = await boxes.count();
    assert(n >= 2, `返歌に選べる語が ${n} 個`);
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await submitAndSettle(page, page.getByRole("button", { name: "返歌を送る" }));

    const { rows } = await db.query(
      `select count(*)::int as n from public.flavor_replies
        where work_id = $1 and user_id = $2`,
      [seeded.flavorWork, seeded.hintReader],
    );
    assert(rows[0].n === 1, `返歌が ${rows[0].n} 件（1件のはず）`);

    // 見るのは返歌の欄だけ。ページ全体を見ると、上にある回答結果の
    // 「正解／不正解」を拾ってしまう
    const section = await page
      .locator("section:has(h2:text-is('返歌'))")
      .innerText();
    // 説明文そのものが「正解も不正解もありません」と言っているので、
    // その1文だけは外してから見る
    const withoutNote = section.replace("正解も不正解もありません。", "");
    assert(
      !/正解|不正解/.test(withoutNote),
      `返歌の欄に正誤の印がある: ${withoutNote.replace(/\s+/g, " ").slice(0, 200)}`,
    );

    await ctx.close();
  });

  await test("H", "サーバーが UTC でも、日時は日本時間で出る", async () => {
    // アプリは UTC で動かしてある（test/e2e/server.mjs）。
    // 時間帯を書き忘れた表示なら、ここで9時間ずれる。
    const { rows } = await db.query(
      `select created_at from public.works where id = $1`,
      [seeded.works[0].workId],
    );
    const expected = new Date(rows[0].created_at).toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/works/${seeded.works[0].workId}`);
    const body = (await settledBody(page)).replace(/\s+/g, " ");

    assert(
      body.includes(expected),
      `投稿日が日本時間で出ていない。期待 ${expected} / 画面 `
        + `${(/投稿日[^0-9]*([^\n]{0,30})/.exec(body) ?? [])[1] ?? "（見つからない）"}`,
    );
    await ctx.close();
  });

  /* =====================================================================
   * G. スマホ幅
   * ===================================================================== */

  await test("G", "スマホ幅で、帯が本文に重ならず横スクロールも出ない", async () => {
    const phone = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await phone.newPage();

    await p.goto(`${base}/works`);
    // 測るのは、いちばん上まで戻した状態。
    // 帯は sticky なので、スクロール中は下の内容の前に出る（そういう部品）。
    await p.evaluate(() => window.scrollTo(0, 0));

    const overflow = await p.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow <= 1, `横に ${overflow}px はみ出している`);

    // 見るのは「操作の部品」だけ。**文章の途中にある語のリンクは対象外**
    // （行の高さを44pxにすると文が飛び飛びになる）。
    // 対象は、上下の枠の行き先・ボタン・枠線や地の付いた押せるもの。
    const tabs = await p.evaluate(() =>
      [
        ...document.querySelectorAll(
          "[data-site-nav] a, button, [role=button], a[class*=rounded], label[class*=rounded]",
        ),
      ]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            text: (el.textContent ?? "").trim().slice(0, 20),
            h: Math.round(r.height),
            w: Math.round(r.width),
          };
        })
        .filter((x) => x.h > 0 && x.h < 44),
    );
    assert(
      tabs.length === 0,
      `44px に届かない操作対象が ${tabs.length} 個: ${JSON.stringify(tabs.slice(0, 6))}`,
    );

    await phone.close();
  });

  await test("G", "スマホ幅で、帯の文字が枠から出ない", async () => {
    const phone = await browser.newContext({ viewport: { width: 375, height: 667 } });
    const p = await phone.newPage();
    await p.goto(`${base}/play`);
    await p.selectOption("select[name=timeLimitSeconds]", "1800");
    await p.getByRole("button", { name: "ドラフトを始める" }).click();
    await p.waitForSelector("button[data-card=hidden]", { timeout: 20000 });
    await waitForBar(p);

    await p.evaluate(() => window.scrollTo(0, 0));
    const fit = await p.evaluate(() => {
      const bar = document.querySelector("[data-challenge-bar]");
      const inner = bar.firstElementChild;
      return {
        overflowX: inner.scrollWidth - inner.clientWidth,
        barHeight: bar.getBoundingClientRect().height,
        headerTop: document.querySelector("[data-site-nav]").getBoundingClientRect().top,
        barBottom: bar.getBoundingClientRect().bottom,
      };
    });
    assert(fit.overflowX <= 1, `帯の中身が ${fit.overflowX}px はみ出している`);
    assert(fit.barBottom <= fit.headerTop + 1, "スマホ幅で帯がヘッダーに重なっている");
    assert(fit.barHeight < 200, `帯が ${fit.barHeight}px と高すぎる`);
    await phone.close();
  });

  /* =====================================================================
   * I. D165（全語出題・ビタ当てと2択当て）を画面で通す
   * ===================================================================== */

  await test("I", "お題の全語が出題され、問数が語数と一致する", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();

    const cards = (
      await db.query(
        `select count(*)::int as n from public.prompt_cards where prompt_id = $1`,
        [seeded.hardPromptId],
      )
    ).rows[0].n;
    assert(cards >= 5, `高難度のお題が ${cards} 語（5語以上のはず）`);

    await p.goto(`${base}/works/${seeded.hardWork}`);
    await p
      .locator("fieldset[data-question]")
      .first()
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => null);
    const shown = await p.locator("fieldset[data-question]").count();
    assert(shown === cards, `出題が ${shown} 問（お題の ${cards} 語と同じはず）`);

    // 共有された画面に答えが出ていないこと。**選択肢の外に正解が無いか**を見る。
    //
    // 【script を外す理由】
    //   Next.js は画面を組み立てるためのデータを <script> に埋める。
    //   そこには4択の語がそのまま入っている（画面に出ている以上、当然入る）。
    //   **どれが正解かは入っていない**ので漏洩ではないが、
    //   文字としては全部あるので、外さないと数えられない。
    const outside = await p.evaluate(() => {
      const clone = document.body.cloneNode(true);
      for (const el of clone.querySelectorAll("script, style, template, noscript")) el.remove();
      for (const fs of clone.querySelectorAll("fieldset[data-question]")) fs.remove();
      return clone.textContent;
    });
    const answers = (
      await db.query(
        `select t.label from public.prompt_cards pc join public.tags t on t.id = pc.tag_id
          where pc.prompt_id = $1`,
        [seeded.hardPromptId],
      )
    ).rows.map((r) => r.label);
    const leaked = answers.filter((a) => outside.includes(a));
    assert(leaked.length === 0, `選択肢の外に答えが出ている: ${leaked.join("、")}`);

    await ctx.close();
  });

  await test("I", "2つ選ぶと2択当てになり、片方が当たっていれば的中する", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}/works/${seeded.hardWork}`);

    // 各問で「正解 ＋ 正解ではない1つ」を選ぶ。**どちらかが当たれば的中**
    const groups = p.locator("fieldset[data-question]");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    const n = await groups.count();

    for (let i = 0; i < n; i += 1) {
      const fs = groups.nth(i);
      const slotKey = await fs.getAttribute("data-slot-key");
      const correct = (
        await db.query(
          `select t.label from public.prompt_cards pc join public.tags t on t.id = pc.tag_id
            where pc.prompt_id = $1 and pc.card_slot_key = $2`,
          [seeded.hardPromptId, slotKey],
        )
      ).rows[0].label;

      const boxes = fs.locator("input[type=checkbox]");
      const count = await boxes.count();
      let pickedCorrect = false;
      let pickedOther = false;
      for (let j = 0; j < count; j += 1) {
        const label = await boxes.nth(j).getAttribute("data-choice-label");
        if (label === correct && !pickedCorrect) {
          await boxes.nth(j).check();
          pickedCorrect = true;
        } else if (label !== correct && !pickedOther) {
          await boxes.nth(j).check();
          pickedOther = true;
        }
      }
      assert(pickedCorrect && pickedOther, `${slotKey} で2つ選べなかった`);
    }

    await submitAndSettle(p, p.getByRole("button", { name: "回答する" }));

    await settledBody(p);   // 本文が届くまで待つ（読むのは下の判定）
    await assertBody(
      p,
      new RegExp(`${n}問中 ${n}問 的中`),
      "2択当てで的中しなかった",
    );
    await assertBody(p, /2択当て/, "方式（2択当て）が結果に出ていない");
    await assertBody(p, /2つまでの絞り込みでした/, "断定ではないことが書かれていない");

    const { rows } = await db.query(
      `select ai.answer_mode, count(*)::int as n from public.answer_items ai
         join public.answers a on a.id = ai.answer_id
        where a.work_id = $1 group by 1`,
      [seeded.hardWork],
    );
    assert(rows.length === 1 && rows[0].answer_mode === "pair", "2択当てとして保存されていない");
    assert(rows[0].n === n, `保存された内訳が ${rows[0].n} 件（${n} 件のはず）`);

    await ctx.close();
  });

  await test("I", "問ごとに、いまの答え方が画面に出る（未選択／ビタ当て／2択当て）", async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(`${base}/works/${seeded.hardWork}`);

    const fs = p.locator("fieldset[data-question]").first();
    await fs.waitFor({ state: "attached", timeout: 15000 });
    const state = fs.locator("p.answer-mode-state");
    const boxes = fs.locator("input[type=checkbox]");

    // **見えている文だけを読む。**CSS で1つだけ表示する作りなので、
    // innerText を取れば「いま何と書いてあるか」がそのまま出る。
    const shown = async () => (await state.innerText()).replace(/\s+/g, " ").trim();

    assert(
      /回答を選んでください/.test(await shown()),
      `未選択のときの表示が違う: ${await shown()}`,
    );

    await boxes.nth(0).check();
    assert(
      /ビタ当て/.test(await shown()) && !/2択当て/.test(await shown()),
      `1つ選んだときの表示が違う: ${await shown()}`,
    );
    assert(
      /断定して送ります/.test(await shown()),
      "1つ選んだときに、結果の違いが書かれていない",
    );

    await boxes.nth(1).check();
    assert(
      /2択当て/.test(await shown()),
      `2つ選んだときの表示が違う: ${await shown()}`,
    );
    assert(
      /2つまでしか絞れなかった/.test(await shown()),
      "2つ選んだときに、記録の残り方が書かれていない",
    );

    if ((await boxes.count()) >= 3) {
      await boxes.nth(2).check();
      assert(
        /3つ以上は選べません/.test(await shown()),
        `3つ選んだときの表示が違う: ${await shown()}`,
      );
      await boxes.nth(2).uncheck();
    }

    // 外すと戻る（片道の表示になっていないこと）
    await boxes.nth(1).uncheck();
    assert(/ビタ当て/.test(await shown()), "2つ目を外してもビタ当てに戻らない");
    await boxes.nth(0).uncheck();
    assert(/回答を選んでください/.test(await shown()), "全部外しても未選択に戻らない");

    await ctx.close();
  });

  await test("G", "スマホ幅で、問数が増えても横スクロールせず操作できる", async () => {
    const phone = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await phone.newPage();

    await p.goto(`${base}/works/${seeded.hardWork}`);
    await p.evaluate(() => window.scrollTo(0, 0));

    await p
      .locator("fieldset[data-question]")
      .first()
      .waitFor({ state: "attached", timeout: 15000 })
      .catch(() => null);
    const questions = await p.locator("fieldset[data-question]").count();
    assert(questions >= 5, `出題が ${questions} 問（5問以上のはず）`);

    const overflow = await p.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert(overflow <= 1, `横に ${overflow}px はみ出している`);

    // 選択肢の当たり判定。**44px 未満のものが1つも無いこと**
    const small = await p.evaluate(() =>
      [...document.querySelectorAll("fieldset[data-question] label")]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return { text: (el.textContent ?? "").trim().slice(0, 12), h: Math.round(r.height) };
        })
        .filter((x) => x.h > 0 && x.h < 44),
    );
    assert(
      small.length === 0,
      `44px に届かない選択肢が ${small.length} 個: ${JSON.stringify(small.slice(0, 5))}`,
    );

    // 選択肢どうしが重なっていないこと
    const overlapped = await p.evaluate(() => {
      const rects = [...document.querySelectorAll("fieldset[data-question] label")].map((el) =>
        el.getBoundingClientRect(),
      );
      let n = 0;
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i];
          const b = rects[j];
          if (
            a.left < b.right - 1 && b.left < a.right - 1 &&
            a.top < b.bottom - 1 && b.top < a.bottom - 1
          ) n += 1;
        }
      }
      return n;
    });
    assert(overlapped === 0, `選択肢が ${overlapped} 組重なっている`);

    await phone.close();
  });

  /* =====================================================================
   * N. 次の作品の配給と、一覧の「未回答のみ」（D169）
   *
   * ここで見るのは**画面から触ったときの振る舞い**だけ。
   * 候補の資格や救済帯の作りそのものは DB 側の試験（test:db の N 群）で見る。
   * ===================================================================== */

  /** URL から作品IDを取り出す */
  function workIdFromUrl(url) {
    return /\/works\/([0-9a-f-]{36})/.exec(String(url))?.[1] ?? null;
  }

  /** その作品の部門を DB から読む（画面の表示ではなく、行そのものを見る） */
  async function divisionOf(workId) {
    const { rows } = await db.query(`select division from public.works where id = $1`, [
      workId,
    ]);
    return rows[0]?.division ?? null;
  }

  /** その作品の回答数を DB から数える（控えの列ではなく行を数える） */
  async function answerRows(workId) {
    const { rows } = await db.query(
      `select count(*)::int as n from public.answers where work_id = $1`,
      [workId],
    );
    return rows[0].n;
  }

  /** 新しいゲストの窓を開く。**まだ何もしていない訪問者**の状態から始める */
  async function newGuest() {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    return { ctx, p: await ctx.newPage() };
  }

  /** その作品のクイズに、画面から答える */
  async function answerThroughUi(p, workId) {
    act(`作品 ${workId} に画面から答える`);
    await p.goto(`${base}/works/${workId}`);
    const groups = p.locator("fieldset[data-question]");
    await groups.first().waitFor({ state: "attached", timeout: 15000 });
    const n = await groups.count();
    assert(n > 0, `作品 ${workId} に出題が出ていない`);
    for (let i = 0; i < n; i += 1) {
      await groups.nth(i).locator("input[type=checkbox]").first().check();
    }
    await submitAndSettle(p, p.getByRole("button", { name: "回答する" }));
  }

  /** 「次の作品に答える」を押して、移った先のURLを返す */
  async function pressNext(p) {
    const before = p.url();
    act("「次の作品に答える」を押す");
    await clickSafely(p.getByRole("button", { name: "次の作品に答える" }));
    await p.waitForURL((u) => u.toString() !== before, { timeout: 20000 });
    return p.url();
  }

  /**
   * 一覧に並んでいる作品のIDを、カードのリンクから読む。
   *
   * **中身が出るまで待つ。**この画面には「読み込み中…」の表示があり
   * （`(list)/loading.tsx`）、goto が返った時点ではまだそちらのことがある。
   * 待たずに数えると、0件なのか、まだ出ていないのかを取り違える。
   * 絞り込みの札は本体にしか無いので、それが出たことを目印にする。
   */
  async function listedIds(p, query = "") {
    act(`一覧を開く /works${query}`);
    await p.goto(`${base}/works${query}`);
    await p.waitForSelector("[data-unanswered-filter]", { timeout: 15000 });
    const hrefs = await p.$$eval('a[href^="/works/"]', (as) =>
      as.map((a) => a.getAttribute("href")),
    );
    return hrefs.map((h) => workIdFromUrl(h)).filter(Boolean);
  }

  for (const division of ["original", "fanart", "ai"]) {
    await test("N", `${division} 部門に答えたあとの「次の作品」が、同じ部門になる`, async (t) => {
      const { ctx, p } = await newGuest();
      try {
        const current = seeded.divisionWorks[division][0];
        t.stage(`${division} の作品に答える`);
        await answerThroughUi(p, current);

        t.stage("次の作品へ移る");
        const url = await pressNext(p);
        const landed = workIdFromUrl(url);
        assert(landed !== null, `作品ページ以外へ移った（${url}）`);
        assert(landed !== current, "同じ作品に戻っている");

        const got = await divisionOf(landed);
        assert(
          got === division,
          `${division} から答えたのに ${got} の作品へ移った（部門を引き継いでいない）`,
        );
      } finally {
        await ctx.close();
      }
    });
  }

  await test("N", "回答0件の作品があるときは、その中から出る（第1救済帯が優先される）", async (t) => {
    const [current, withAnswer, zero] = seeded.divisionWorks.ai;

    t.stage("AI部門の1件だけに、別の人の回答を1件付ける");
    const other = await makeMember(db, `nb1-${Date.now() % 100000}`);
    if ((await answerRows(withAnswer)) === 0) {
      await answerWork(db, other, withAnswer);
    }
    assert((await answerRows(withAnswer)) >= 1, "第2帯にする作品へ回答が入っていない");
    assert((await answerRows(zero)) === 0, "第1帯にする作品に回答が付いている（準備の失敗）");

    const { ctx, p } = await newGuest();
    try {
      t.stage("AI部門の作品に答えて、次へ進む");
      await answerThroughUi(p, current);
      const landed = workIdFromUrl(await pressNext(p));
      assert(
        landed === zero,
        `回答0件の作品（${zero}）ではなく ${landed} へ移った`,
      );
    } finally {
      await ctx.close();
    }
  });

  await test("N", "回答0件が無くなると、回答のある作品から出る（第2救済帯）", async (t) => {
    const [current, withAnswer, zero] = seeded.divisionWorks.ai;

    t.stage("AI部門の回答0件を無くす");
    const other = await makeMember(db, `nb2-${Date.now() % 100000}`);
    if ((await answerRows(zero)) === 0) await answerWork(db, other, zero);
    assert((await answerRows(zero)) >= 1, "第1帯を空にできていない");

    const { ctx, p } = await newGuest();
    try {
      t.stage("AI部門の作品に答えて、次へ進む");
      await answerThroughUi(p, current);
      const landed = workIdFromUrl(await pressNext(p));
      assert(
        [withAnswer, zero].includes(landed),
        `第2帯の2件ではなく ${landed} へ移った`,
      );
      assert(
        (await answerRows(landed)) >= 1,
        "第1帯が無いはずなのに、回答0件の作品へ移った",
      );
      assert((await divisionOf(landed)) === "ai", "部門をまたいで移った");
    } finally {
      await ctx.close();
    }
  });

  await test("N", "同じ部門に候補が無くなったら、行き止まりにせず一覧へ送る", async (t) => {
    const [a, b, c] = seeded.divisionWorks.fanart;
    const { ctx, p } = await newGuest();
    try {
      t.stage("ファンアートを全部答える");
      await answerThroughUi(p, b);
      await answerThroughUi(p, c);
      await answerThroughUi(p, a);

      t.stage("次の作品を押す");
      const url = await pressNext(p);
      assert(
        /\/works(\?|$)/.test(new URL(url).pathname + new URL(url).search) ||
          new URL(url).pathname === "/works",
        `候補が無いときに一覧へ送られていない（${url}）`,
      );
      assert(workIdFromUrl(url) === null, `作品ページへ移っている（${url}）`);

      // **0件になったときの一覧が壊れないこと。**
      // この人はファンアートを全部答えたので、その部門の「未回答のみ」は0件になる
      t.stage("0件になる条件で一覧を開く");
      const empty = await listedIds(p, "?tab=fanart&unanswered=1");
      assert(empty.length === 0, `0件のはずが ${empty.length} 件出ている`);
      const body = (await settledBody(p)).replace(/\s+/g, " ");
      await assertBody(p, /まだ答えていない作品はありません/, `0件のときの案内が出ていない。画面: ${body.slice(0, 300)}`);
      assert(
        (await p.locator('[data-unanswered-filter="on"]').count()) === 1,
        "0件になると絞り込みの選択が消えている",
      );
    } finally {
      await ctx.close();
    }
  });

  await test("N", "何もしていない訪問者には「未回答のみ」を押させない（理由を出す）", async (t) => {
    const { ctx, p } = await newGuest();
    try {
      t.stage("一覧を開く");
      await p.goto(`${base}/works`);
      const disabled = p.locator('[data-unanswered-filter="disabled"]');
      await disabled.waitFor({ state: "attached", timeout: 15000 });
      assert(
        (await disabled.count()) === 1,
        "回答履歴を照合できない状態なのに、絞り込みが押せる形で出ている",
      );
      // **理由の文が出ているか。**出ていなければ、そのとき画面に
      // 何が書いてあったかを、そのまま失敗の理由に入れる
      await p.waitForSelector('[data-unanswered-filter="disabled"]', { timeout: 15000 });
      const body = (await settledBody(p)).replace(/\s+/g, " ");
      await assertBody(p, /一度でも回答する/, `押せない理由が画面に書かれていない。画面: ${body.slice(0, 300)}`);
    } finally {
      await ctx.close();
    }
  });

  await test("N", "ゲストが答えると、その作品が「未回答のみ」から消える／OFFなら出る", async (t) => {
    const { ctx, p } = await newGuest();
    try {
      const target = seeded.divisionWorks.original[0];
      t.stage("1件答える");
      await answerThroughUi(p, target);

      t.stage("未回答のみ ON");
      const on = await listedIds(p, "?unanswered=1");
      assert(!on.includes(target), "答えた作品が「未回答のみ」に残っている");
      assert(on.length > 0, "「未回答のみ」で1件も出ていない");

      t.stage("未回答のみ OFF");
      const off = await listedIds(p, "");
      assert(off.includes(target), "OFF なのに答えた作品が出ていない");

      t.stage("ONの表示とURLが残る（再読込）");
      await p.goto(`${base}/works?unanswered=1`);
      await p.reload();
      await p.waitForSelector("[data-unanswered-filter]", { timeout: 15000 });
      assert(
        (await p.locator('[data-unanswered-filter="on"]').count()) === 1,
        "再読込すると絞り込みの選択が外れている",
      );
      assert(/unanswered=1/.test(p.url()), `再読込後のURLから条件が消えた（${p.url()}）`);
    } finally {
      await ctx.close();
    }
  });

  await test("N", "「未回答のみ」を、部門・完成度・並び順・ページ送りと同時に使える", async (t) => {
    const { ctx, p } = await newGuest();
    try {
      const answeredFanart = seeded.divisionWorks.fanart[0];
      t.stage("ファンアートを1件答える");
      await answerThroughUi(p, answeredFanart);

      t.stage("部門と併用");
      const fanart = await listedIds(p, "?tab=fanart&unanswered=1");
      assert(!fanart.includes(answeredFanart), "部門と併用すると回答済みが残る");
      for (const id of fanart) {
        assert(
          (await divisionOf(id)) === "fanart",
          "ファンアートのタブに別部門が混ざっている",
        );
      }

      t.stage("AI部門と併用");
      const ai = await listedIds(p, "?tab=ai&unanswered=1");
      for (const id of ai) {
        assert((await divisionOf(id)) === "ai", "AIのタブに別部門が混ざっている");
      }

      t.stage("完成度と併用");
      const sketch = await listedIds(p, "?done=sketch&unanswered=1");
      assert(
        sketch.includes(seeded.sketchWork),
        "落書きの絞り込みと併用すると、未回答の落書きが出ない",
      );

      t.stage("並び順と併用");
      for (const sort of ["likes", "answers"]) {
        const ids = await listedIds(p, `?sort=${sort}&unanswered=1`);
        assert(ids.length > 0, `並び ${sort} と併用すると0件になる`);
      }

      t.stage("ページ送りが条件を持ち越す");
      await p.goto(`${base}/works?unanswered=1&page=2`);
      await p.waitForSelector("[data-unanswered-filter]", { timeout: 15000 });
      const prev = await p
        .locator('a:has-text("前のページ")')
        .first()
        .getAttribute("href");
      assert(
        prev !== null && /unanswered=1/.test(prev),
        `ページ送りのリンクが条件を落としている（${prev}）`,
      );
    } finally {
      await ctx.close();
    }
  });

  await test("N", "作品を開いただけでは、「未回答のみ」から消えない", async (t) => {
    const { ctx, p } = await newGuest();
    try {
      t.stage("1件答えて、利用者を確定させる");
      await answerThroughUi(p, seeded.divisionWorks.original[2]);

      const opened = seeded.divisionWorks.original[3];
      t.stage("別の1件を開くだけ（答えない）");
      await p.goto(`${base}/works/${opened}`);
      await p.waitForSelector("fieldset[data-question]", { timeout: 15000 });

      t.stage("一覧に戻る");
      const ids = await listedIds(p, "?unanswered=1");
      assert(
        ids.includes(opened),
        "開いただけの作品が「未回答のみ」から消えている（回答以外を見ている）",
      );
    } finally {
      await ctx.close();
    }
  });

  await test("N", "スマホ幅で「未回答のみ」を押せる（44px以上・はみ出し無し）", async (t) => {
    const ctx = await browser.newContext({
      viewport: { width: 375, height: 667 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    try {
      t.stage("スマホ幅で1件答える");
      await answerThroughUi(p, seeded.divisionWorks.original[4]);

      t.stage("一覧を開く");
      await p.goto(`${base}/works`);
      await p.waitForSelector("[data-unanswered-filter]", { timeout: 15000 });

      const filter = p.locator('[data-unanswered-filter="off"]');
      // 出るのを待ってから測る。**出ているかと、測れるかは別のこと。**
      await filter.waitFor({ state: "visible", timeout: 15000 });
      assert((await filter.count()) === 1, "スマホ幅で絞り込みが出ていない");

      const box = await filter.boundingBox();
      assert(
        box !== null,
        `絞り込みの当たり判定が取れない。画面: ${(await p.innerText("body"))
          .replace(/\s+/g, " ")
          .slice(0, 300)}`,
      );
      assert(box.height >= 44, `絞り込みの高さが ${Math.round(box.height)}px（44px 以上のはず）`);

      const overflow = await p.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert(overflow <= 1, `一覧が横に ${overflow}px はみ出している`);

      // 絞り込みの行が、ほかの部品と重なっていないこと。
      // 重なると、押したつもりの場所で別のものが反応する
      const overlapped = await p.evaluate(() => {
        const el = document.querySelector("[data-unanswered-filter]");
        if (!el) return -1;
        const siblings = [...el.parentElement.children];
        const rects = siblings.map((x) => x.getBoundingClientRect());
        let n = 0;
        for (let i = 0; i < rects.length; i += 1) {
          for (let j = i + 1; j < rects.length; j += 1) {
            const a = rects[i];
            const b = rects[j];
            if (
              a.left < b.right - 1 && b.left < a.right - 1 &&
              a.top < b.bottom - 1 && b.top < a.bottom - 1
            ) n += 1;
          }
        }
        return n;
      });
      assert(overlapped === 0, `絞り込みの行で ${overlapped} 組が重なっている`);

      t.stage("押して ON になる");
      await clickSafely(filter);
      await p.waitForURL((u) => /unanswered=1/.test(u.toString()), { timeout: 20000 });
      await p
        .locator('[data-unanswered-filter="on"]')
        .waitFor({ state: "attached", timeout: 15000 })
        .catch(() => null);
      assert(
        (await p.locator('[data-unanswered-filter="on"]').count()) === 1,
        "スマホ幅で押しても ON にならない",
      );

      // ON のときも、重なりやはみ出しが出ないこと
      const overflowOn = await p.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      assert(overflowOn <= 1, `ON のとき横に ${overflowOn}px はみ出している`);
    } finally {
      await ctx.close();
    }
  });

  /* =====================================================================
   * P. 引かなかったカードの開示と、お題の放棄（spec 4-4 / D171）
   *
   * 【この2つは、ボタンが無いと存在しないのと同じ】
   *   DB の関数だけ作っても、利用者は押せない。ここで見るのは
   *   **画面から押せて、押した結果が DB に残り、読み直しても残っているか。**
   * ===================================================================== */

  await test("P", "本人には「他の候補を見る」が出て、押すと引かなかったカードが開く", async (t) => {
    t.stage("新しいお題を1件だけ確定する");
    const promptId = await drawFreshPrompt(m, base, db, seeded.viewer);

    t.stage("開く前の状態を見る");
    assert(
      (await m.locator('[data-unchosen="closed"]').count()) === 1,
      "開く前なのに、引かなかったカードの欄が閉じていない",
    );
    assert(
      (await m.locator("[data-reveal-candidates]").count()) === 1,
      "本人の画面に「他の候補を見る」が出ていない",
    );
    assert(
      (await m.locator('[data-unchosen-card]').count()) === 0,
      "押す前から引かなかったカードが見えている",
    );

    // **押す前にもう1枚開いておく。**あとで「古い画面から二度押されたとき」を
    // 試すため。押したあとに開いたのでは、古い画面が作れない。
    const stale = await m.context().newPage();
    await stale.goto(`${base}/prompt/${promptId}`);
    await stale.waitForSelector("[data-reveal-candidates]", { timeout: 15000 });

    t.stage("押す");
    await submitAndSettle(m, m.locator("[data-reveal-candidates]"));
    await m.waitForSelector('[data-unchosen="open"]', { timeout: 15000 });

    const shown = await m.locator("[data-unchosen-card]").count();
    assert(shown >= 1, `開いたのに引かなかったカードが ${shown} 枚`);
    assert(
      (await m.locator("[data-reveal-candidates]").count()) === 0,
      "開いたあとも「他の候補を見る」が残っている（同じ操作が二度出ている）",
    );

    const first = await db.query(
      `select reveal_reason as r, candidates_revealed_at as at, status as s
         from public.prompts where id = $1`,
      [promptId],
    );
    assert(first.rows[0].r === "manual", `開示の理由が ${first.rows[0].r}（manual のはず）`);
    assert(
      first.rows[0].s === "active",
      `開いただけで状態が ${first.rows[0].s} になっている（active のままのはず）`,
    );

    t.stage("読み直しても開いたまま");
    await m.reload();
    await m.waitForSelector('[data-unchosen="open"]', { timeout: 15000 });
    assert(
      (await m.locator("[data-unchosen-card]").count()) === shown,
      "読み直したら、開いたカードの枚数が変わった",
    );
    await assertBody(m, /このお題で描いた作品を投稿する/, "開いたら投稿の入口が消えた（仮定A9 に反する）");

    t.stage("古い画面からもう一度押しても壊れない");
    await submitAndSettle(stale, stale.locator("[data-reveal-candidates]"));
    await settledBody(stale);
    await stale.waitForSelector('[data-unchosen="open"]', { timeout: 15000 });
    assert(
      (await stale.locator("[data-unchosen-card]").count()) === shown,
      "二度目の開示でカードの枚数が変わった",
    );

    const again = await db.query(
      `select reveal_reason as r, candidates_revealed_at as at from public.prompts where id = $1`,
      [promptId],
    );
    assert(
      String(again.rows[0].at) === String(first.rows[0].at),
      `二度目の開示で時刻が ${first.rows[0].at} → ${again.rows[0].at} へ書き換わった`,
    );
    assert(again.rows[0].r === "manual", `二度目で理由が ${again.rows[0].r} になった`);
    await stale.close();
  });

  await test("P", "他人のお題では、開く操作そのものが出ない（画面ごと 404）", async (t) => {
    t.stage("本人がお題を1件持っている状態にする");
    const promptId = await drawFreshPrompt(m, base, db, seeded.viewer);

    t.stage("別の登録者としてサインインする");
    const otherCtx = await browser.newContext();
    const o = await otherCtx.newPage();
    try {
      await signInAs(o, base, seeded.hintReaderEmail);

      t.stage("他人のお題の URL を開く");
      await o.goto(`${base}/prompt/${promptId}`);
      const body = await settledBody(o);

      assert(
        (await o.locator("[data-reveal-candidates]").count()) === 0,
        "他人の画面に「他の候補を見る」が出ている",
      );
      assert(
        (await o.locator("[data-abandon-prompt]").count()) === 0,
        "他人の画面に「このお題は描かない」が出ている",
      );
      assert(
        (await o.locator("[data-unchosen-card]").count()) === 0,
        "他人に引かなかったカードが見えている",
      );
      assert(
        /ページが見つかりません/.test(body),
        `他人のお題が 404 になっていない: ${body.replace(/\s+/g, " ").slice(0, 200)}`,
      );
      assert(
        !/権限/.test(body),
        "「権限がありません」と答えている（お題の実在を教えてしまう。D40）",
      );
    } finally {
      await otherCtx.close();
    }
  });

  await test("P", "「このお題は描かない」を押すと、投稿できなくなり候補が開く", async (t) => {
    t.stage("新しいお題を1件だけ確定する");
    const promptId = await drawFreshPrompt(m, base, db, seeded.viewer);

    assert(
      (await m.locator("[data-abandon-prompt]").count()) === 1,
      "本人の画面に「このお題は描かない」が出ていない",
    );

    t.stage("押す");
    await submitAndSettle(m, m.locator("[data-abandon-prompt]"));
    await m.waitForSelector('[data-unchosen="open"]', { timeout: 15000 });

    const { rows } = await db.query(
      `select status as s, reveal_reason as r, abandoned_at as a
         from public.prompts where id = $1`,
      [promptId],
    );
    assert(rows[0].s === "abandoned", `状態が ${rows[0].s}（abandoned のはず）`);
    assert(rows[0].r === "abandoned", `開示の理由が ${rows[0].r}（abandoned のはず）`);
    assert(rows[0].a !== null, "放棄の時刻が入っていない");

    const shown = await m.locator("[data-unchosen-card]").count();
    assert(shown >= 1, `やめたのに引かなかったカードが ${shown} 枚`);

    const afterBody = await settledBody(m);
    assert(
      !/このお題で描いた作品を投稿する/.test(afterBody),
      "やめたのに投稿の入口が残っている",
    );
    assert(
      (await m.locator("[data-abandon-prompt]").count()) === 0,
      "やめたあとも「このお題は描かない」が残っている",
    );
    assert(/新しいお題を引く/.test(afterBody), "やめたあとに次への行き先が無い");

    t.stage("読み直しても状態が残る");
    await m.reload();
    await m.waitForSelector('[data-unchosen="open"]', { timeout: 15000 });
    const reloaded = await settledBody(m);
    assert(
      (await m.locator("[data-unchosen-card]").count()) === shown,
      "読み直したら、開いたカードの枚数が変わった",
    );
    assert(
      !/このお題で描いた作品を投稿する/.test(reloaded),
      "読み直したら投稿の入口が戻ってきた",
    );

    t.stage("URL を直に叩いても投稿できない");
    await m.goto(`${base}/works/new?promptId=${promptId}`);
    const newBody = await settledBody(m);
    assert(
      /描かない/.test(newBody),
      `やめたお題の投稿画面が断っていない: ${newBody.replace(/\s+/g, " ").slice(0, 200)}`,
    );
    assert(
      (await m.locator("input[type=file]").count()) === 0,
      "やめたお題なのに投稿の欄が出ている",
    );

    t.stage("ドラフトが続いていない");
    await m.goto(`${base}/play`);
    await settledBody(m);
    assert(
      (await m.locator("button[data-card=hidden]").count()) === 0,
      "やめたのに、めくりかけの盤面が残っている",
    );
    const live = await db.query(
      `select count(*)::int as n from public.draft_sessions
        where user_id = $1 and status = 'in_progress'`,
      [seeded.viewer],
    );
    assert(live.rows[0].n === 0, `進行中のドラフトが ${live.rows[0].n} 件残っている`);
  });

  /* =====================================================================
   * Q. メールの確認を、別のタブで開いたとき（D171）
   *
   * 【受信箱は持てない。だから印だけ借りる】
   *   本物では確認リンクは利用者の受信箱に届く。試験は受信箱を持てないので、
   *   検証用の Supabase が作った印を1つ借りてリンクを組み立てる。
   *   **開いたあとに通る道は本物と同じ**（/auth/confirm → verifyOtp → Cookie）。
   *
   * 【何を見ているか】
   *   合図が届いたかどうかではなく、**元のタブの表示がサーバーの答えに
   *   合わせて変わったか。**合図は「聞き直せ」と言うだけの役目しか持たない。
   * ===================================================================== */

  /** ゲストとして登録を始め、確認の印を1つ受け取るところまで進める */
  async function startGuestRegistration(page, base, email) {
    // ゲストのIDは、遊び始めて初めて作られる。/account を開くだけでは
    // 「まだサインインしていません」のままで、昇格の入口が出ない
    await drawThroughUi(page, base, { timeLimit: "3600" });

    await page.goto(`${base}/account`);
    await settledBody(page);
    await assertBody(page, /ゲストとして遊んでいます/, "ゲストになっていない");

    const form = "form:has(button:has-text('このゲストのまま登録する'))";
    await page.locator(`${form} input[name=email]`).fill(email);
    await page.locator(`${form} input[name=password]`).fill("dummy-password-1");
    await submitAndSettle(
      page,
      page.getByRole("button", { name: "このゲストのまま登録する" }),
    );

    await assertBody(page, /確認メールを送りました/, "確認メールの案内が出ていない");
    // **リンクを開く前に登録済みにしない。**ここが崩れると、以降の試験に意味が無い
    await assertBody(
      page,
      /ゲストとして遊んでいます/,
      "リンクを開く前なのに登録済みの表示になっている",
    );

    const token = app.mock.lastConfirmToken();
    assert(token, "確認の印が1つも作られていない（メールが送られていない）");
    return token;
  }

  await test("Q", "同じブラウザの別タブで確認すると、元のタブが自分で切り替わる", async (t) => {
    const ctx = await browser.newContext();
    const t1 = await ctx.newPage();
    try {
      t.stage("元のタブで登録を始める");
      const email = `e2e-two-tab-${Date.now()}@example.test`;
      const token = await startGuestRegistration(t1, base, email);

      t.stage("別のタブで確認リンクを開く");
      const t2 = await ctx.newPage();
      await t2.goto(`${base}/auth/confirm?token_hash=${token}&type=email`);
      await t2.waitForURL(/\/account/, { timeout: 25000 });
      await settledBody(t2);
      await assertBody(t2, /登録が完了しました/, "確認したタブに完了の面が出ていない");

      t.stage("元のタブを、触らないまま見張る");
      // **読み込み直さない。**ここで reload すると、合図が効いたのか
      // ただ読み直しただけなのかが区別できなくなる。
      await t1
        .getByText("登録ユーザーとしてサインインしています")
        .first()
        .waitFor({ state: "visible", timeout: 30000 });

      const afterSignal = await settledBody(t1);
      assert(
        afterSignal.includes(email),
        `元のタブに登録したメール（${email}）が出ていない`,
      );
      assert(
        !/ゲストとして遊んでいます/.test(afterSignal),
        "元のタブにゲストの表示が残っている",
      );

      t.stage("元のタブを前面に戻す");
      await t1.bringToFront();
      await settledBody(t1);
      assert(
        (await t1.getByText("登録ユーザーとしてサインインしています").count()) >= 1,
        "前面に戻したら登録済みの表示が消えた",
      );

      t.stage("確認したタブを閉じても、元のタブは使える");
      await t2.close();
      const profileForm = "form:has(button:has-text('プロフィールを保存する'))";
      await t1.locator(`${profileForm} input[name=displayName]`).fill("二枚のタブ");
      await submitAndSettle(
        t1,
        t1.getByRole("button", { name: "プロフィールを保存する" }),
      );
      await assertBody(t1, /プロフィールを更新しました/, "元のタブで編集を続けられない");

      const { rows } = await db.query(
        `select p.display_name as n
           from public.profiles p
           join auth.users u on u.id = p.id
          where u.email = $1`,
        [email],
      );
      assert(
        rows[0]?.n === "二枚のタブ",
        `元のタブでの編集が保存されていない（${JSON.stringify(rows)}）`,
      );
    } finally {
      await ctx.close();
    }
  });

  await test("Q", "合図だけでは登録済みにならない（別の端末で開いた場合を含む）", async (t) => {
    const ctx = await browser.newContext();
    const t1 = await ctx.newPage();
    let otherDevice = null;
    try {
      t.stage("元のタブで登録を始める");
      const email = `e2e-other-device-${Date.now()}@example.test`;
      const token = await startGuestRegistration(t1, base, email);

      t.stage("嘘の合図を投げる");
      // 本物の確認は一切していない状態で、合図だけを流す。
      // 受け取ったタブがすることは「サーバーへ聞き直す」だけなので、
      // **答えが変わらない以上、表示も変わってはいけない。**
      await t1.evaluate(() => {
        const bc = new BroadcastChannel("dpq-auth");
        bc.postMessage("confirmed");
        bc.close();
      });
      await t1.waitForTimeout(3000);
      await settledBody(t1);
      assert(
        (await t1.getByText("登録ユーザーとしてサインインしています").count()) === 0,
        "嘘の合図だけで登録済みの表示になった（合図を証拠に使っている）",
      );
      await assertBody(t1, /ゲストとして遊んでいます/, "嘘の合図でゲストの表示が消えた");

      t.stage("別の端末に当たるところで確認リンクを開く");
      // 別の context は Cookie も合図の道も共有しない。
      // 実機の「PCで登録してスマホでメールを開く」に当たる。
      otherDevice = await browser.newContext();
      const d = await otherDevice.newPage();
      await d.goto(`${base}/auth/confirm?token_hash=${token}&type=email`);
      await d.waitForURL(/\/account/, { timeout: 25000 });
      await settledBody(d);
      await assertBody(d, /登録が完了しました/, "別の端末で確認が通っていない");
      // 別の端末には「元の画面は自動では切り替わらない」と書いてあること
      await assertBody(
        d,
        /自動では\s*切り替わりません|自動では切り替わりません/,
        "別の端末で開いた人に、元の画面が切り替わらないことを伝えていない",
      );

      t.stage("元のタブは、触らないかぎり切り替わらない");
      await t1.waitForTimeout(4000);
      const still = await settledBody(t1);
      assert(
        !/登録ユーザーとしてサインインしています/.test(still),
        "合図が届かないはずの別端末なのに、元のタブが勝手に切り替わった",
      );

      t.stage("読み込み直せば、元のタブでも登録済みになる");
      await t1.reload();
      await settledBody(t1);
      assert(
        (await t1.getByText("登録ユーザーとしてサインインしています").count()) >= 1,
        "読み込み直しても元のタブが登録済みにならない",
      );
    } finally {
      if (otherDevice) await otherDevice.close();
      await ctx.close();
    }
  });

  /* =====================================================================
   * !. 記録の自己試験（E2E_FORCE_FAIL=1 のときだけ動く）
   *
   * **失敗したときに、試験名と原因が記録に残るか**を、本物の失敗で確かめる。
   * 作り物の例外ではなく、実際に「在るはずのない部品」を待って時間切れにする。
   * ふだんの実行では1件も増えない。
   * ===================================================================== */
  if (process.env.E2E_FORCE_FAIL === "1") {
    await test("!", "自己試験: わざと落とす（落ちるのが正しい）", async (t) => {
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      t.stage("在るはずのない部品を待つ");
      await p.goto(`${base}/works?unanswered=1`);
      await p.waitForSelector("[data-this-element-never-exists]", { timeout: 3000 });
      await ctx.close();
    });
  }

  await guest.close();
  await memberCtx.close();
}

// **重い検査は1つずつ。**同時に走ると計算機を奪い合い、
// 「画面が出ない」という形でアプリと無関係に落ちる。
const releaseHeavyLock = await acquireHeavyLock("ブラウザ試験（test:e2e）");

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = e;
}

if (browser) {
  try {
    await browser.close();
  } catch {
    /* すでに落ちている */
  }
}
if (app) await app.close();
releaseHeavyLock();

// 記録係は main() の中で作る。そこへ届く前に落ちたら、ここで作る
if (!recorder) recorder = createRecorder({ runName: "e2e", probe: seeNow });

if (fatal) {
  // **試験の失敗と、試験そのものが立ち上がらなかったことを分けて数える。**
  recorder.add({
    group: "!",
    name: "試験そのものが止まった",
    ok: false,
    message: fatal.stack ?? fatal.message ?? String(fatal),
  });
}

// --- ブラウザが外へ出した通信の判定 -----------------------------------------
{
  const bad = [...externalRequests.entries()].filter(
    ([host]) => !E2E_ALLOWED_EXTERNAL.has(host),
  );
  const allowedExternal = [...externalRequests.entries()].filter(([host]) =>
    E2E_ALLOWED_EXTERNAL.has(host),
  );

  recorder.add({
    group: "Z",
    name: "ブラウザが許可外のホストへ通信していない",
    ok: bad.length === 0,
    message: bad.map(([h, n]) => `${h}（${n}件）`).join(" / "),
  });

  if (allowedExternal.length > 0) {
    console.log(
      `\n（名前で許可した外部通信: ${allowedExternal
        .map(([h, n]) => `${h} ${n}件`)
        .join(" / ")}）`,
    );
  }
}

// --- 記録を書き切る。**合格でも全件ぶん残す** -------------------------------
const { payload, jsonFile, textFile, failed } = recorder.finish({
  serverRestarted: (app?.logs ?? []).join("").includes(
    "approaching the used memory threshold",
  ),
});

console.log(`\n記録: ${textFile}`);
console.log(`      ${jsonFile}`);

if (failed.length > 0) {
  console.log("\n===== 不合格の中身 =====");
  for (const r of failed) {
    console.log(`\n✗ [${r.group}] ${r.name}`);
    console.log(`   種類: ${r.category}`);
    console.log(`   段:   ${r.failedStage}`);
    if (r.url) console.log(`   URL:  ${r.url}`);
    console.log(`   時刻: ${r.startedAt} 〜 ${r.endedAt}`);
    for (const c of r.error ?? []) {
      console.log(`   原因: ${c.name}: ${c.message}${c.code ? `（${c.code}）` : ""}`);
    }
    if (r.serverLogTail) {
      console.log("   --- そのあいだの検証用サーバーの出力 ---");
      for (const l of r.serverLogTail.split("\n").slice(-20)) console.log(`   ${l}`);
    }
  }
}

console.log(
  `\n合計 ${payload.total} 件 / 合格 ${payload.passed} 件 / 不合格 ${payload.failed} 件`,
);

// 文書に書いた件数と突き合わせられるように、実測を残す。
// **わざと落とす回（E2E_FORCE_FAIL）は数えない。**1件多くなるため
if (process.env.E2E_FORCE_FAIL !== "1") recordCount("ブラウザ試験", payload.total);
process.exit(failed.length === 0 ? 0 : 1);
