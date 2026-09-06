"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { clock, frameLabel, type ActiveChallenge } from "@/features/challenge/types";

/**
 * 全ページの上に出る「制作挑戦の時計」。
 *
 * 【どこに出るか】
 *   共通レイアウト（layout.tsx）の本文より前。position: sticky なので
 *   スクロールしても上に残るが、**場所を占める**ので本文にもヘッダーにも重ならない。
 *   挑戦をしていない人には、帯そのものが出ない（高さ0）。
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

  const renew = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/challenge", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
      });
      const body = (await res.json()) as { challenge?: ActiveChallenge; error?: string };

      if (!res.ok || body.error) {
        // **サーバーが受け取ったと確認できないものを、成功として出さない**
        setMessage(body.error ?? "時間を延ばせませんでした。");
        await load();
        return;
      }

      const next = body.challenge ?? null;
      offset.current = next ? Date.parse(next.server_now) - Date.now() : 0;
      setChallenge(next);
      setNow(Date.now() + offset.current);
      setStale(false);
      setMessage("制作時間を延ばしました。");
      channel.current?.postMessage("renewed");
    } catch {
      setMessage("通信できませんでした。時間は延びていません。");
      setStale(true);
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (!challenge) return null;

  // --- サーバー時刻に合わせて数を作る ---------------------------------------
  const nowMs = now;
  const startedMs = Date.parse(challenge.started_at);
  const deadlineMs = challenge.deadline_at ? Date.parse(challenge.deadline_at) : null;
  const graceEndMs = challenge.grace_ends_at ? Date.parse(challenge.grace_ends_at) : null;
  const renewOpenMs = challenge.renew_opens_at ? Date.parse(challenge.renew_opens_at) : null;

  const elapsed = challenge.is_finished
    ? challenge.elapsed_seconds
    : Math.max(0, Math.floor((nowMs - startedMs) / 1000));

  const left = deadlineMs === null ? null : Math.floor((deadlineMs - nowMs) / 1000);
  const graceLeft = graceEndMs === null ? null : Math.floor((graceEndMs - nowMs) / 1000);

  const expired =
    !challenge.is_finished && graceEndMs !== null && nowMs > graceEndMs;

  const canRenew =
    !challenge.is_finished &&
    !expired &&
    challenge.has_deadline &&
    renewOpenMs !== null &&
    graceEndMs !== null &&
    nowMs >= renewOpenMs &&
    nowMs <= graceEndMs;

  const overrun = left !== null && left < 0;

  // 色は3段階だけ。期限内／超過・猶予中／終了
  const tone = challenge.is_finished
    ? "border-line bg-sunken"
    : expired
      ? "border-danger-tint/50 bg-danger-tint/10"
      : overrun
        ? "border-danger-tint/40 bg-danger-tint/5"
        : "border-line bg-sunken";

  return (
    <div
      data-challenge-bar=""
      data-kind={challenge.kind}
      data-elapsed={elapsed}
      data-expired={expired ? "1" : "0"}
      data-finished={challenge.is_finished ? "1" : "0"}
      data-stale={stale ? "1" : "0"}
      className={`sticky top-0 z-40 border-b ${tone}`}
      role="status"
      aria-live="off"
    >
      <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-xs sm:px-10">
        <span className="font-bold">
          {challenge.is_finished ? "挑戦を終えました" : expired ? "挑戦が終了しました" : "制作中"}
        </span>

        <span className="text-faint">{frameLabel(challenge.time_limit_seconds)}</span>

        <span className="tabular-nums" data-field="elapsed">
          経過 {clock(elapsed)}
        </span>

        {challenge.is_unlimited || !challenge.has_deadline ? (
          <span className="text-faint">期限なし</span>
        ) : challenge.is_finished ? null : expired ? (
          <span className="font-bold text-danger">時間切れ</span>
        ) : overrun ? (
          <>
            <span className="tabular-nums text-danger" data-field="overrun">
              超過 {clock(left ?? 0)}
            </span>
            <span className="tabular-nums" data-field="grace">
              猶予残り {clock(graceLeft ?? 0)}
            </span>
          </>
        ) : (
          <span className="tabular-nums" data-field="left">
            残り {clock(left ?? 0)}
          </span>
        )}

        {challenge.renew_count > 0 ? (
          <span className="text-faint">{challenge.renew_count} 回延長</span>
        ) : null}

        <span className="ml-auto flex items-center gap-2">
          {stale ? (
            <span className="text-faint" data-field="stale">
              未同期
            </span>
          ) : null}

          {canRenew ? (
            <button
              type="button"
              onClick={() => void renew()}
              disabled={busy}
              data-action="renew"
              className="inline-flex min-h-11 items-center rounded-full border border-line-active px-4 font-bold hover:bg-hover disabled:opacity-60"
            >
              {busy ? "延ばしています…" : "制作時間を延ばす"}
            </button>
          ) : null}

          <Link
            href={challenge.href}
            data-action="back"
            className="inline-flex min-h-11 items-center rounded-full border border-line-mid px-4 hover:bg-hover"
          >
            {challenge.is_finished ? "結果を見る" : "いまの挑戦へ戻る"}
          </Link>
        </span>

        {message ? (
          <span className="w-full text-faint" data-field="message">
            {message}
          </span>
        ) : null}

        {expired ? (
          <span className="w-full text-danger" data-field="expired-note">
            時間を延ばさないまま猶予を過ぎたため、このお題では投稿できません。
            描いた絵も記録も消えません。新しいお題を引くと、また始められます。
          </span>
        ) : null}
      </div>
    </div>
  );
}
