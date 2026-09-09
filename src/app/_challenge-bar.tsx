"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 描き終える前に走らせたい処理。
 *
 * useLayoutEffect はブラウザが描く**前**に走るので、そこで高さを決めれば
 * 画面が一度も動かない。ただしサーバー側には描く工程が無く、
 * そこで使うと警告が出るので、サーバーでは通常の effect に落とす。
 */
const useBeforePaint = typeof window === "undefined" ? useEffect : useLayoutEffect;
import {
  clock,
  frameLabel,
  hhmm,
  spanLabel,
  type ActiveChallenge,
  type RenewResult,
} from "@/features/challenge/types";
import {
  isWorse,
  shouldBlink,
  warnAnnouncement,
  warnLabel,
  warnLevel,
  type WarnLevel,
} from "@/features/challenge/warning";

/**
 * 全ページの上に出る「制作挑戦の時計」。
 *
 * 【2つの形がある（P5）】
 *   ・いま描いているお題のページ … **大きい帯。**画面いちばん上、横幅いっぱい、
 *     不透明。残り時間をいちばん大きな字で出す。本文とは線で完全に切る
 *   ・それ以外のページ           … **細い帯。**残り時間と「制作へ戻る」だけ
 *
 *   どちらの帯かは、いま開いているページが「いまの挑戦へ戻る」の行き先と
 *   同じかどうかで決める。**時計の出どころは1つのまま**で、
 *   変わるのは大きさと出す項目だけ。
 *
 * 【どこに出るか】
 *   共通レイアウト（layout.tsx）の本文より前。position: fixed で画面に貼り付き、
 *   スクロールしても動かない。fixed は場所を占めないので、
 *   **同じ高さの空きを下に置いて**本文が潜らないようにしている。
 *   透ける帯にしない（下の文字が透けると、どちらも読めなくなる）。
 *   挑戦をしていない人には、帯も空きも出ない（高さ0）。
 *
 * 【残り時間が減ると、見た目が強まる】
 *   段階は features/challenge/warning.ts が1か所で決める。
 *   **この画面にしきい値の数を書かない。**最終段階では赤くして点滅させるが、
 *   点滅は「動きを減らす」設定で止まる（globals.css）。
 *   止まっても、色と「まもなく期限」の文言で危険度は伝わる。
 *
 * 【読み上げソフトへは、節目だけ知らせる】
 *   秒を毎秒読み上げると、他の案内が全部埋もれる。
 *   段階が変わった瞬間だけ1文を差し替える。時計そのものは aria-live で読ませない。
 *
 * 【時計の持ち主はサーバー】
 *   開始時刻・期限・更新できるか・失効したか・投稿できるかは、すべて DB が決める。
 *   この画面がやるのは「サーバーの時計に自分を合わせて、秒を描く」ことだけ。
 *
 *   合わせ方は、受け取った server_now と手元の時計の差（offset）を取っておき、
 *   以降は Date.now() + offset をサーバー時刻として使う。
 *   **1秒ごとに数を1ずつ足していく方式にしない。**その方式だと、
 *   タブが背面に回っている間にタイマーが止まり、戻ったときに時間が巻き戻る。
 *   ここでは常に「開始時刻からの差」を計算し直すので、
 *   背面にいた時間も、閉じていた時間も、そのまま経過に入る。
 *
 * 【いつ取り直すか】
 *   ・最初の描画
 *   ・ページを移ったとき（pathname が変わったとき）
 *   ・画面のどこかで送信が起きたとき（お題を引く・確定する・投稿する…）
 *   ・タブが前面に戻ったとき（visibilitychange）
 *   ・ウィンドウに焦点が戻ったとき（focus）
 *   ・戻る/進むで復帰したとき（pageshow）
 *   ・時間を延ばしたあと
 *   ・他のタブが延ばしたとき（BroadcastChannel）
 *   ・30秒に1回の保険
 *
 *   送信のたびに取り直すのは、**挑戦が始まる瞬間がまさに送信だから。**
 *   これが無いと、「ドラフトを始める」を押しても帯が出ず、
 *   次の保険の取り直しまで（最大30秒）何も出ないまま待つことになる
 *   （実測でそうなった）。送信先は同じ URL のことが多く、
 *   ページを移った合図だけでは拾えない。
 *
 *   **表示のために毎秒問い合わせない。**秒は手元で描く。
 *
 * 【通信できないとき】
 *   最後に同期した時刻からの経過を出し続けたうえで、「未同期」と書く。
 *   延長ボタンを押して応答が返らなかったときは、成功と書かない。
 */

/** 取り直しの間隔（保険）。表示のためではない */
const RESYNC_MS = 30_000;

export function ChallengeBar() {
  const pathname = usePathname();
  const [challenge, setChallenge] = useState<ActiveChallenge | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /**
   * 帯の高さ。**下に置く空きの高さに使う。**
   *
   * 【なぜ測るのか】
   *   帯は position: fixed なので場所を占めない。同じ高さの空きを
   *   下に置かないと、本文の頭が帯の裏へ潜る。
   *   高さを決め打ちにすると、画面の幅・文字の大きさ・出ている行数で
   *   ずれる（警告の文言や猶予の行は、出る場合と出ない場合がある）。
   *   **実際に描かれた高さを測って、そのぶん空ける。**
   */
  const barRef = useRef<HTMLDivElement | null>(null);
  const [barHeight, setBarHeight] = useState(0);
  // 【0から始めて、描く前に測る】
  //   目安の高さから始めると、測ったあとに本文が跳ねる。
  //   跳ねている最中に押した指は、狙ったものと違うところに当たる
  //   （実測: 2026-09-09 に、カードを押しても何も起きない試験が1件落ちた）。

  /**
   * いまのサーバー時刻（ミリ秒）。**描画のたびに時計を読まない。**
   * 読むと同じ描画のたびに値が変わり、React が「純粋でない」と扱う。
   * 秒を進めるのは下のタイマーで、そこで1回だけ読む。
   */
  const [now, setNow] = useState(0);
  /** サーバー時刻 − 手元の時計。同期のたびに入れ替える */
  const offset = useRef(0);
  const channel = useRef<BroadcastChannel | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/challenge", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { "x-requested-with": "challenge-bar" },
      });
      if (!res.ok) throw new Error(String(res.status));

      const body = (await res.json()) as {
        challenge: ActiveChallenge | null;
        error?: string;
      };

      // 読めなかったときは、前の値を消さずに「未同期」にする
      if (body.error) {
        setStale(true);
        return;
      }

      offset.current = body.challenge
        ? Date.parse(body.challenge.server_now) - Date.now()
        : 0;

      setChallenge(body.challenge);
      setNow(Date.now() + offset.current);
      setStale(false);
    } catch {
      setStale(true);
    }
  }, []);

  // --- 取り直しのきっかけ ---------------------------------------------------
  useEffect(() => {
    // 最初の1回。effect の本体から直接 setState を呼ばないように、
    // いったんタイマーへ逃がす
    const first = window.setTimeout(() => void load(), 0);

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    const onShow = () => void load();

    /**
     * 送信のあと。**サーバーの処理が終わるのを待ってから**取りに行く。
     * すぐ取りに行くと、まだ始まっていない状態を読んでしまう。
     * 1回では取りこぼすことがあるので、少し置いてもう1回だけ見る。
     */
    const afterSubmit = () => {
      window.setTimeout(() => void load(), 700);
      window.setTimeout(() => void load(), 2500);
    };

    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("submit", afterSubmit, true);
    window.addEventListener("focus", onShow);
    window.addEventListener("pageshow", onShow);
    const timer = window.setInterval(() => void load(), RESYNC_MS);

    // 複数のタブで同じ挑戦を開いているとき、片方で延ばしたら両方に効かせる
    let bc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      bc = new BroadcastChannel("challenge");
      bc.onmessage = () => void load();
      channel.current = bc;
    }

    return () => {
      window.clearTimeout(first);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("submit", afterSubmit, true);
      window.removeEventListener("focus", onShow);
      window.removeEventListener("pageshow", onShow);
      window.clearInterval(timer);
      bc?.close();
      channel.current = null;
    };
    // pathname を見るのは、ページを移ったときに取り直すため
  }, [load, pathname]);

  // --- 秒を描く -------------------------------------------------------------
  //
  // 1秒ごとに「サーバー時刻はいまいくつか」を1回だけ計算する。
  // 数を1ずつ足していく方式にしないのは、タブが背面にいる間に
  // タイマーが間引かれても、経過が実際の時間からずれないため。
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + offset.current), 1000);
    return () => window.clearInterval(id);
  }, []);

  // 帯の高さを測り続ける。中身が変わっても空きが合うようにする。
  // **描く前に測る。**描いたあとに測ると、本文が一度下がってから上がる
  useBeforePaint(() => {
    const el = barRef.current;
    if (!el) {
      setBarHeight(0);
      return;
    }
    const measure = () => setBarHeight(el.getBoundingClientRect().height);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
    // 中身が増えたときの測り直しは ResizeObserver が受け持つ。
    // ここで見るのは「帯そのものが出たか消えたか」だけ
  }, [challenge]);

  const renew = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/challenge", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await res.json()) as { challenge?: RenewResult; error?: string };

      if (!res.ok || body.error) {
        // **サーバーが受け取ったと確認できないものを、成功として出さない。**
        // 理由は DB 側が文にして返す。黙って何も起きない状態にしない
        setMessage(body.error ?? "時間を延ばせませんでした。理由が分かりません。");
        await load();
        return;
      }

      const next = body.challenge ?? null;
      offset.current = next ? Date.parse(next.server_now) - Date.now() : 0;
      setChallenge(next);
      setNow(Date.now() + offset.current);
      setStale(false);

      // 何分延びて、新しい終了予定がいつになったかを書く。
      // 「延長しました」だけだと、押した人は本当に効いたのか確かめられない
      const granted = next?.granted_seconds ?? 0;
      const until = hhmm(next?.deadline_after ?? null);
      setMessage(
        granted > 0
          ? `${spanLabel(granted)} 延長しました。新しい終了予定は ${until} です。`
          : "制作時間を延ばしました。",
      );
      channel.current?.postMessage("renewed");
    } catch {
      setMessage("通信できませんでした。時間は延びていません。");
      setStale(true);
    } finally {
      setBusy(false);
    }
  }, [load]);

  // --- 節目だけ読み上げる ---------------------------------------------------
  //
  // 段階が変わった瞬間にだけ文を差し替える。**毎秒は読ませない。**
  // 前の段階を控えておき、危険側へ進んだときだけ知らせる。
  const [announcement, setAnnouncement] = useState<string | null>(null);

  /** 最後に知らせた段階。**描画では読まない**（読むと毎秒描き直すことになる） */
  const announced = useRef<WarnLevel>("calm");

  // --- サーバー時刻に合わせて数を作る ---------------------------------------
  //
  // **早い return より前に置く。**下に useEffect があるので、
  // 帯が出ない人だけ hook の数が変わる、という形にはできない。
  const nowMs = now;
  const startedMs = challenge ? Date.parse(challenge.started_at) : 0;
  const deadlineMs = challenge?.deadline_at ? Date.parse(challenge.deadline_at) : null;

  const elapsed = !challenge
    ? 0
    : challenge.is_finished
      ? challenge.elapsed_seconds
      : Math.max(0, Math.floor((nowMs - startedMs) / 1000));

  const left = deadlineMs === null ? null : Math.floor((deadlineMs - nowMs) / 1000);

  // 予定終了時刻を過ぎてからの秒。**過ぎても挑戦は続いている**
  const overrun = Boolean(challenge && !challenge.is_finished && left !== null && left < 0);
  const overrunSeconds = left !== null && left < 0 ? -left : 0;

  // 消えるのは、長い放置で自動破棄されたときだけ。超過では消えない
  const discarded = Boolean(challenge && !challenge.is_finished && challenge.is_discarded);

  // **押せる時刻の窓は無い。**判断はサーバーが持っていて、ここは写すだけ
  const canRenew = Boolean(challenge && challenge.can_renew && !discarded);

  // --- 危険度 ---------------------------------------------------------------
  //
  // しきい値はここに書かない。features/challenge/warning.ts が持っている。
  const level: WarnLevel =
    !challenge || challenge.is_finished
      ? "calm"
      : warnLevel(
          challenge.is_unlimited || !challenge.has_deadline ? null : left,
          challenge.time_limit_seconds,
          discarded,
        );

  // 段階が危険側へ進んだ瞬間だけ、読み上げ用の1文を差し替える。
  // **描画の中で状態を変えない。**変えると毎秒の描画が連鎖する
  useEffect(() => {
    if (!isWorse(level, announced.current)) return;
    announced.current = level;
    setAnnouncement(warnAnnouncement(level));
  }, [level]);

  if (!challenge) return null;

  // 【自動破棄されたら、帯も「制作へ戻る」も出さない】
  //   古いままの画面を活きているものとして扱わない。
  //   サーバーの get_active_challenge も破棄済みは返さないが、
  //   取り直しの合間にここへ来ることがあるので、画面側でも消す。
  //   何が起きたかは知らせの帯（_notices.tsx）が伝える。
  if (discarded) return null;

  const blink = shouldBlink(level);
  const note = warnLabel(level);

  // 制作中のページか。**「いまの挑戦へ戻る」の行き先と同じなら、そこが制作中**
  const onWorkPage = pathname === challenge.href;

  // 段階ごとの地と縁。**色だけで伝えない**（下に文言を必ず出す）
  //
  // 【地を二重にしている理由】
  //   帯は不透明でなければならない。下の本文が透けると、
  //   数字も本文も両方読めなくなる。ところが段階の色（danger-tint/10 など）は
  //   薄く敷くための半透明の色で、そのままでは透ける。
  //   そこで**外側に不透明な地を1枚敷き、その上に段階の色を重ねる。**
  //   結果として、透けないまま段階の色が付く。
  const toneBorder = challenge.is_finished
    ? "border-line"
    : level === "over" || level === "danger"
      ? "border-danger-tint"
      : level === "warn"
        ? "border-notice-tint"
        : "border-line";

  const toneBg = challenge.is_finished
    ? "bg-sunken"
    : level === "over"
      ? "bg-danger-tint/15"
      : level === "danger"
        ? "bg-danger-tint/10"
        : level === "warn"
          ? "bg-notice-tint/10"
          : "bg-sunken";

  const heading = challenge.is_finished
    ? "挑戦を終えました"
    : overrun
      ? "制作中（予定時間を超過）"
      : "制作中";

  /**
   * 大きく出す数字。
   *
   * 【超過中は「超過した量」を出す】
   *   残りを負の数で出しても、どれだけ過ぎたのかが読み取りにくい。
   *   **数字は超過した量そのものにして、見出しで「超過」と言う。**
   *   タイマーを消したり「失敗」に切り替えたりはしない。
   */
  const timeText =
    challenge.is_unlimited || !challenge.has_deadline
      ? clock(elapsed)
      : challenge.is_finished
        ? clock(challenge.elapsed_seconds)
        : overrun
          ? clock(overrunSeconds)
          : clock(left ?? 0);

  const timeCaption =
    challenge.is_unlimited || !challenge.has_deadline
      ? "経過（期限なし）"
      : challenge.is_finished
        ? "かかった時間"
        : overrun
          ? "制作時間の超過"
          : "残り";

  /** 帯に共通で付ける印。**検査はこの印を見る** */
  const marks = {
    "data-challenge-bar": "",
    "data-kind": challenge.kind,
    "data-elapsed": elapsed,
    "data-phase": challenge.phase,
    "data-overrun": overrun ? "1" : "0",
    "data-overrun-seconds": overrunSeconds,
    "data-finished": challenge.is_finished ? "1" : "0",
    "data-stale": stale ? "1" : "0",
    "data-level": level,
    "data-blink": blink ? "1" : "0",
    "data-form": onWorkPage ? "large" : "thin",
  } as const;

  const renewButton = canRenew ? (
    <button
      type="button"
      onClick={() => void renew()}
      disabled={busy}
      data-action="renew"
      className="inline-flex min-h-11 items-center rounded-full border border-line-active px-4 font-bold hover:bg-hover disabled:opacity-60"
    >
      {busy ? "延ばしています…" : "制作時間を延ばす"}
    </button>
  ) : null;

  // 読み上げ用。**時計そのものは読ませない。**節目の1文だけ
  const liveRegion = (
    <p data-field="announce" role="status" aria-live="polite" className="sr-only">
      {announcement ?? ""}
    </p>
  );

  // ==========================================================================
  // 制作中のページ … 大きい帯
  // ==========================================================================
  if (onWorkPage) {
    return (
      <>
        <div
          {...marks}
          ref={barRef}
          className={`fixed inset-x-0 top-0 z-50 border-b-2 ${toneBorder}`}
          style={{ backgroundColor: "var(--surface)" }}
        >
          <div className={`w-full ${toneBg}`}>
            <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-1 px-4 py-4 sm:px-10">
              <span className="text-sm font-bold tracking-wide">{heading}</span>

              {/* 何の時間かを、数の**すぐ上**に置く。
                  離すと「00:29:58」が何の数字か分からなくなる */}
              <span className="text-xs text-faint">{timeCaption}</span>

              <span
                data-field="time"
                className={`text-5xl font-bold tabular-nums sm:text-6xl ${
                  level === "over" || level === "danger" ? "text-danger" : ""
                } ${blink ? "dpq-timer-blink" : ""}`}
              >
                {timeText}
              </span>

              <span className="text-xs text-faint">
                {frameLabel(challenge.time_limit_seconds)}・経過{" "}
                <span data-field="elapsed" className="tabular-nums">
                  {clock(elapsed)}
                </span>
                {challenge.renew_count > 0 ? `・${challenge.renew_count} 回延長` : ""}
              </span>

              {note ? (
                <span
                  data-field="warn-note"
                  className={`text-xs font-bold ${
                    level === "warn" ? "text-notice" : "text-danger"
                  }`}
                >
                  {note}
                </span>
              ) : null}

              {overrun ? (
                <span data-field="overrun-note" className="text-xs text-danger">
                  制作時間を {clock(overrunSeconds)} 超過しています。
                  制作はそのまま続けられます。必要なら延長できます。
                </span>
              ) : null}

              {challenge.seconds_until_discard !== null
              && challenge.seconds_until_discard < 24 * 3600 ? (
                <span data-field="discard-note" className="text-xs text-faint">
                  操作が無いまま {clock(challenge.seconds_until_discard)} が過ぎると、
                  制作途中のお題は自動的に破棄されます。
                </span>
              ) : null}

              <span className="flex flex-wrap items-center justify-center gap-2 pt-1 text-xs">
                {renewButton}
                {stale ? (
                  <span className="text-faint" data-field="stale">
                    未同期
                  </span>
                ) : null}
              </span>

              {message ? (
                <span className="text-xs text-faint" data-field="message">
                  {message}
                </span>
              ) : null}

              {liveRegion}
            </div>
          </div>
        </div>

        {/* 帯は場所を占めないので、測った高さと同じ空きを置く。
            測れないうちは大きめに取る（本文が潜るより、空きすぎるほうがまし） */}
        <div aria-hidden="true" style={{ height: barHeight }} />
      </>
    );
  }

  // ==========================================================================
  // それ以外のページ … 細い帯
  // ==========================================================================
  return (
    <>
      <div
        {...marks}
        ref={barRef}
        className={`fixed inset-x-0 top-0 z-50 border-b ${toneBorder}`}
        style={{ backgroundColor: "var(--surface)" }}
      >
        <div className={`w-full ${toneBg}`}>
          <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs sm:px-10">
            <span className="font-bold">{heading}</span>

            <span
              data-field="time"
              className={`tabular-nums font-bold ${
                level === "over" || level === "danger" ? "text-danger" : ""
              } ${blink ? "dpq-timer-blink" : ""}`}
            >
              {timeCaption} {timeText}
            </span>

            {note ? (
              <span
                data-field="warn-note"
                className={level === "warn" ? "text-notice" : "text-danger"}
              >
                {note}
              </span>
            ) : null}

            {overrun ? (
              <span data-field="overrun-note" className="text-danger">
                制作時間を {clock(overrunSeconds)} 超過しています
              </span>
            ) : null}

            <span data-field="elapsed" className="tabular-nums text-faint">
              経過 {clock(elapsed)}
            </span>

            <span className="ml-auto flex items-center gap-2">
              {stale ? (
                <span className="text-faint" data-field="stale">
                  未同期
                </span>
              ) : null}
              {renewButton}
              <Link
                href={challenge.href}
                data-action="back"
                className="inline-flex min-h-11 items-center rounded-full border border-line-mid px-4 font-bold hover:bg-hover"
              >
                {challenge.is_finished ? "結果を見る" : "制作へ戻る"}
              </Link>
            </span>

            {message ? (
              <span className="w-full text-faint" data-field="message">
                {message}
              </span>
            ) : null}

            {liveRegion}
          </div>
        </div>
      </div>

      <div aria-hidden="true" style={{ height: barHeight }} />
    </>
  );
}
