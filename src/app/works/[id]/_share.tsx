"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { btnPrimary, btnQuiet, btnSecondary } from "@/app/_surface";
import {
  CARD_HEIGHT,
  CARD_WIDTH,
  SHARE_PARAM_SHARE_ID,
  SHARE_PARAM_SOURCE,
  blueskyIntentUrl,
  shareCardImageUrl,
  shareUrl,
  xIntentUrl,
} from "@/features/share/card";
import {
  SHARE_CHANNEL_LABEL,
  SHARE_CHANNEL_ORDER,
  type ShareChannel,
  type ShareQuestionOption,
} from "@/features/share/types";

import { createShareAction, recordShareEventAction } from "./share-actions";

/**
 * 作品ページの共有の面と、共有から来た人を数える部品。
 *
 * 【この画面の中で答えさせない】（利用者の指示 1 / 39）
 *   ここで選ぶのは「どの問いを出すか」だけ。選択肢は1つも出さない。
 *   答えるのはサイトの中（作品ページの回答）であって、共有の面ではない。
 *
 * 【下見は本番の画像そのもの】（利用者の指示 9）
 *   下の <img> が指しているのは /api/og/work/[id] で、
 *   SNS のクローラーが取りに来るのと**同じ1枚**。
 *   下見用の絵を別に作っていないので、見たものと流れたものがずれない。
 *
 * 【値がどこからどこへ渡るか】
 *   問いの一覧はサーバー（作品ページ）から props で降りてくる。
 *   選んだ問いはこの部品の中だけにあり、閉じると消える。
 *   共有を押すと、この場で共有IDを作り、URL を組み立て、
 *   その場で X を開く／コピーする。**記録はそのあとに送る。**
 *   送り先は share-actions.ts で、そこから DB の create_share へ渡る。
 */

/* ===========================================================================
 * 共有IDを、押した瞬間に作る
 * ===========================================================================
 *
 * 【なぜサーバーに作らせないか】
 *   ブラウザの共有機能とコピーは「押した操作の中で呼ぶこと」を求める。
 *   サーバーへ問い合わせて返事を待つと、その条件から外れて断られうる
 *   （W3C Web Share は transient activation が無ければ NotAllowedError と
 *   定めており、有効時間は「せいぜい数秒」としか書かれていない）。
 *
 *   作る時点は変わらない。面を開いただけ・問いを選び直しただけでは作らない。
 *   **押した瞬間に作る**という決まり（利用者の指示 14）は守られている。
 */
function newShareId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();

  // 古い環境向けの控え。randomUUID が無くても乱数は取れる
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h
    .slice(6, 8)
    .join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/* ===========================================================================
 * 共有の面
 * =========================================================================== */

export function ShareDialog({
  workId,
  siteUrl,
  questions,
}: {
  workId: string;
  /** 正規のURL。組み立てはサーバー側で済ませ、ここへは結果だけ渡す */
  siteUrl: string;
  /**
   * 公開されている問いの一覧。**選択肢は含まない。**
   *
   * 1件も無いときは、問い無しの通常の作品共有へそのまま落ちる
   * （共有できなくしない。利用者の指示 8）。
   */
  questions: ShareQuestionOption[];
}) {
  const ref = useRef<HTMLDialogElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  const [open, setOpen] = useState(false);

  // 選んでいる問い。**開くたびに先頭に戻す**（利用者の指示 15）。
  // 前に選んだものを覚えない
  const [picked, setPicked] = useState<number | null>(questions[0]?.question_id ?? null);

  /**
   * 下見の絵が出来ているか。
   *
   * 【「出来た／出来ていない」を旗で持たない】
   *   旗にすると、面を開いたときや問いを選び直したときに**戻し忘れ・
   *   戻しすぎ**が起きる。実際、開くたびに旗を false へ戻していたせいで、
   *   先に読み終わっていた絵が二度と「出来た」にならなかった
   *   （実測: 絵は出ているのに共有のボタンが押せないままだった）。
   *
   *   そこで「どのURLの絵が出来ているか」を持ち、
   *   いま出したいURLと同じかどうかで判断する。
   *   問いを変えればURLが変わり、出来ていない状態に自然に戻る。
   */
  const [readySrc, setReadySrc] = useState<string | null>(null);
  // 2回試しても絵が出来なかった。絵は諦めるが、共有そのものは続けられるようにする
  const [gaveUp, setGaveUp] = useState(false);
  // 作り直した回数。1回だけやり直す（利用者の指示 9 / 37）
  const [retry, setRetry] = useState(0);
  // 2回とも駄目だった。問い無しの通常カードへ落とす
  const [fellBack, setFellBack] = useState(false);

  // 共有の処理中。同じボタンの連打を止める（利用者の指示 14 / 37）
  const [busy, setBusy] = useState<ShareChannel | null>(null);
  // 「コピーしました」を出している間だけ true（利用者の指示 10）
  const [copied, setCopied] = useState(false);
  // ブラウザの共有機能が使えるか。使えない環境では項目そのものを消す
  const [canNativeShare, setCanNativeShare] = useState(false);
  // 共有できなかったときに出す一言
  const [failure, setFailure] = useState<string | null>(null);

  const effectiveQuestion = fellBack ? null : picked;
  const previewSrc =
    shareCardImageUrl(workId, effectiveQuestion, null) +
    (retry > 0 ? (effectiveQuestion === null ? "?" : "&") + `r=${retry}` : "");
  const previewReady = gaveUp || readySrc === previewSrc;

  /* --- 開け閉め ---------------------------------------------------------- */

  const doOpen = useCallback(() => {
    // ブラウザの共有機能が使えるかは、**開くときに確かめる**（利用者の指示 10）。
    // 最初に描くときに確かめられないのは、サーバー側に navigator が無いため。
    // 効果の中で入れ直すのではなく、開く操作の中で1回見る
    setCanNativeShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );

    // 開くたびに最初の状態へ戻す（利用者の指示 15）。
    // **絵が出来たかどうかはここで触らない。**触ると、先に読み終わっていた絵が
    // 二度と「出来た」にならない
    setPicked(questions[0]?.question_id ?? null);
    setRetry(0);
    setFellBack(false);
    setCopied(false);
    setFailure(null);
    setBusy(null);
    setOpen(true);

    ref.current?.showModal();

    // 記録は開いたことが確定してから。**開こうとした時点では数えない**
    void recordShareEventAction({
      eventKey: "share_modal_open",
      workId,
      questionId: questions[0]?.question_id ?? null,
    });
  }, [questions, workId]);

  const doClose = useCallback(() => {
    setOpen(false);
    ref.current?.close();
    // 閉じたら選んだ状態を捨てる（利用者の指示 15）
    setPicked(questions[0]?.question_id ?? null);
    openerRef.current?.focus();
  }, [questions]);

  // Esc と、面の外を押したとき（利用者の指示 16）。
  // Esc は <dialog> が自分で閉じるので、閉じたことを受け取って状態を合わせる
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onCancel = () => setOpen(false);
    const onCloseEvent = () => setOpen(false);
    el.addEventListener("cancel", onCancel);
    el.addEventListener("close", onCloseEvent);
    return () => {
      el.removeEventListener("cancel", onCancel);
      el.removeEventListener("close", onCloseEvent);
    };
  }, []);

  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDialogElement>) => {
      // <dialog> そのものを押したときだけ＝中身の外側。
      // 中の要素を押したときは e.target が中の要素になる
      if (e.target === ref.current) doClose();
    },
    [doClose],
  );

  /* --- 問いを選ぶ -------------------------------------------------------- */

  const choose = useCallback(
    (questionId: number) => {
      if (questionId === picked) return;
      setPicked(questionId);
      setFellBack(false);
      setRetry(0);
      setGaveUp(false);
      // 選んだ瞬間に下見のURLが変わる＝出来ていない状態に戻る。
      // **確定のボタンを挟まない**（利用者の指示 8）
      setFailure(null);

      void recordShareEventAction({
        eventKey: "share_question_select",
        workId,
        questionId,
      });
    },
    [picked, workId],
  );

  /* --- 下見の絵 ---------------------------------------------------------- */

  const onPreviewError = useCallback(() => {
    if (retry === 0) {
      // 1回だけやり直す
      setRetry(1);
      return;
    }
    // それでも駄目。問い無しの通常カードへ落とす（利用者の指示 9 / 37）
    if (!fellBack) {
      setFellBack(true);
      setRetry(0);
      return;
    }
    // 通常カードも出ない。絵を諦めて、共有そのものは続けられるようにする
    setGaveUp(true);
    setFailure("共有カードの絵を作れませんでした。リンクの共有はそのままできます。");
  }, [retry, fellBack]);

  /**
   * 下見の絵ができたかを、画面の <img> ではなく**別に1枚読んで**確かめる。
   *
   * 【画面の <img> の onLoad を当てにしない】
   *   この面は最初の HTML に入っているので、絵の読み込みは
   *   **React が動き出す前に始まり、前に終わることがある。**
   *   終わっていると onLoad はもう呼ばれず、絵は出ているのに
   *   「作っている最中」のまま共有のボタンが押せなくなる
   *   （実測: 手元の検証で complete=true・naturalWidth=1200 なのに
   *    ready=0 のままだった）。
   *
   *   別に1枚読めば、読み始めるのはこの部品が動き出したあとなので、
   *   終わりを必ず受け取れる。中身は同じURLなので、
   *   ブラウザの控えから返り、通信は増えない。
   */
  useEffect(() => {
    let alive = true;
    const probe = new window.Image();
    probe.onload = () => {
      if (alive) setReadySrc(previewSrc);
    };
    probe.onerror = () => {
      if (alive) onPreviewError();
    };
    probe.src = previewSrc;
    return () => {
      alive = false;
      probe.onload = null;
      probe.onerror = null;
    };
  }, [previewSrc, onPreviewError]);

  /* --- 共有する ---------------------------------------------------------- */

  const runShare = useCallback(
    (channel: ShareChannel) => {
      if (busy !== null) return; // 連打よけ
      setBusy(channel);
      setFailure(null);

      // 1. 押した瞬間に共有IDを作る
      const shareId = newShareId();
      // 2. 共有URLを組み立てる
      const url = shareUrl(siteUrl, workId, effectiveQuestion, shareId);
      const line = effectiveQuestion
        ? (questions.find((q) => q.question_id === effectiveQuestion)?.text ?? null)
        : null;

      // 3. 共有そのものを、押した操作の中で実行する
      let done = true;
      try {
        if (channel === "x") {
          window.open(xIntentUrl(line, url), "_blank", "noopener,noreferrer");
        } else if (channel === "bluesky") {
          window.open(blueskyIntentUrl(line, url), "_blank", "noopener,noreferrer");
        } else if (channel === "native") {
          // 押した操作の中で呼ぶ。await を先に挟まない
          const p = navigator.share({ url });
          void p.catch(() => {
            // 利用者が選ぶのをやめた場合もここへ来る。**失敗として出さない**
          });
        } else {
          const p = navigator.clipboard.writeText(url);
          void p.then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            },
            () => {
              setFailure(`このブラウザではコピーできませんでした。URL: ${url}`);
            },
          );
        }
      } catch {
        done = false;
        setFailure(`共有できませんでした。URL: ${url}`);
      }

      // 4. 記録は最後。**共有の成否とは別に、操作を始めたことだけを残す**
      //    （利用者の指示 35。X の投稿画面を開いたことを「投稿された」と書かない）
      if (done) {
        void createShareAction({
          workId,
          questionId: effectiveQuestion,
          channel,
          shareId,
        });
      }

      // 面は閉じない（利用者の指示 15）
      window.setTimeout(() => setBusy(null), 600);
    },
    [busy, siteUrl, workId, effectiveQuestion, questions],
  );

  /* --- 見た目 ------------------------------------------------------------ */

  const showPicker = questions.length > 1;
  const channels = SHARE_CHANNEL_ORDER.filter((c) => c !== "native" || canNativeShare);

  return (
    <>
      <button
        type="button"
        ref={openerRef}
        onClick={doOpen}
        className={btnSecondary}
        data-share-open
      >
        この作品を共有する
      </button>

      <dialog
        ref={ref}
        className="dpq-sheet"
        aria-labelledby="share-dialog-title"
        onClick={onBackdropClick}
        data-share-dialog
        data-share-open-state={open ? "1" : "0"}
      >
        {/* 中身の全体が1つだけ動く（利用者の指示 16）。
            問いの一覧に別のスクロールを作らない */}
        <div className="dpq-sheet-body p-6 space-y-6">
          <div className="flex items-start justify-between gap-4">
            <h2 id="share-dialog-title" className="text-base font-bold">
              作品を共有
            </h2>
            <button
              type="button"
              onClick={doClose}
              aria-label="共有の面を閉じる"
              data-share-close
              className="min-h-11 min-w-11 rounded-xl text-faint hover:text-muted"
            >
              ×
            </button>
          </div>

          {/* ── 共有する問題を選ぶ（2件以上のときだけ） ── */}
          {showPicker ? (
            <div className="space-y-3">
              <h3 className="text-sm font-bold" data-share-picker-title>
                共有する問題を選ぶ
              </h3>
              {/* 1つだけ選べる。役目は「選ぶ」なので radiogroup として伝える */}
              <div role="radiogroup" aria-label="共有する問題" className="space-y-2">
                {questions.map((q) => {
                  const on = q.question_id === picked && !fellBack;
                  return (
                    <button
                      key={q.question_id}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => choose(q.question_id)}
                      data-share-question={q.question_id}
                      className={[
                        "flex min-h-11 w-full flex-col items-start justify-center gap-0.5 rounded-xl border px-4 py-3 text-left text-sm",
                        on
                          ? "border-line-active bg-hover font-bold"
                          : "border-line-mid hover:bg-hover",
                      ].join(" ")}
                    >
                      <span>{q.text}</span>
                      {/* 同じ文が並ぶときだけ、何問目かを小さく添える。
                          **カードに載る文は上の1行のまま**（利用者の指示 8） */}
                      {q.note ? (
                        <span className="text-xs font-normal text-faint">{q.note}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* ── 共有プレビュー ── */}
          <div className="space-y-2">
            <h3 className="text-sm font-bold">共有プレビュー</h3>
            <div
              className="relative w-full overflow-hidden rounded-xl border border-line"
              style={{ aspectRatio: `${CARD_WIDTH} / ${CARD_HEIGHT}` }}
              data-share-preview
              data-share-preview-ready={previewReady ? "1" : "0"}
            >
              {previewReady ? null : (
                <div
                  className="dpq-preview-skeleton absolute inset-0"
                  aria-hidden
                  data-share-skeleton
                />
              )}
              {/* SNS が取りに来るのと同じ1枚。next/image は使わない
                  （最適化を挟むと、流れる絵と違うものを見せることになる） */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={previewSrc}
                src={previewSrc}
                alt="共有カードの下見"
                className="absolute inset-0 h-full w-full"
              />
            </div>
            <p className="text-xs text-faint">
              SNS に出るのはこの絵です。答えも回答数も載りません。
            </p>
          </div>

          {failure ? (
            <p className="text-xs text-danger" data-share-failure>
              {failure}
            </p>
          ) : null}

          {/* ── 共有先。アイコンだけにしない（利用者の指示 10） ── */}
          <div className="space-y-2">
            {channels.map((c) => {
              const label =
                c === "copy" && copied ? "コピーしました" : SHARE_CHANNEL_LABEL[c];
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => runShare(c)}
                  // 下見が出来るまでは押させない。コピーだけは常に使える
                  // （利用者の指示 10）
                  disabled={busy !== null || (!previewReady && c !== "copy")}
                  data-share-channel={c}
                  className={`${c === "x" ? btnPrimary : btnSecondary} w-full disabled:opacity-50`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          <div className="flex justify-end">
            <button type="button" onClick={doClose} className={btnQuiet}>
              閉じる
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}

/* ===========================================================================
 * 共有から来た人を数える
 * ===========================================================================
 *
 * 【クローラーはここへ来ない】（利用者の指示 34）
 *   この部品はブラウザが画面を描いたあとに動く。
 *   共有カードを取りに来るだけのクローラーは JavaScript を実行しないので、
 *   1件も数に入らない。名乗りでの判定はサーバー側に別にあるが、
 *   そちらは補助で、**本体はこの「描いたあとに動く」という置き場所のほう。**
 *
 * 【同じ流入を2回数えない】
 *   数えたことをこのタブの中に控える。読み込み直しでは増えない。
 */
export function ShareTracker({
  workId,
  questionId,
  shareId,
  phase,
}: {
  workId: string;
  questionId: number | null;
  shareId: string | null;
  /** answered なら結果を見ている。そうでなければ入ってきたところ */
  phase: "landing" | "answered";
}) {
  useEffect(() => {
    const key = `dpq:share:${shareId ?? "none"}:${workId}:${phase}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, "1");
    } catch {
      // 使えない設定のブラウザでは、毎回数えることになる。止めはしない
    }

    void recordShareEventAction({
      eventKey: phase === "answered" ? "share_result_view" : "share_landing",
      workId,
      questionId,
      shareId,
    });
  }, [workId, questionId, shareId, phase]);

  // 結果のあと、次へ進んだことを数える（利用者の指示 32 の share_continue）。
  // 進み先は1つではないので、**進む口に印を付けて、その印を拾う。**
  useEffect(() => {
    if (phase !== "answered") return;

    let sent = false;
    const onClick = (e: MouseEvent) => {
      if (sent) return;
      const el = e.target as HTMLElement | null;
      if (!el?.closest?.("[data-share-continue]")) return;
      sent = true;
      void recordShareEventAction({
        eventKey: "share_continue",
        workId,
        questionId,
        shareId,
      });
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [phase, workId, questionId, shareId]);

  return null;
}

/**
 * 回答を送るときに、共有から来たことを一緒に送るための隠し入力。
 *
 * **回答そのものの決まりは1つも変えない**（利用者の指示 19 / 22）。
 * 誰が答えたか・2回目を断るかは今までどおり DB が決める。
 * ここで足すのは「どの共有から来た人の回答か」という印だけ。
 */
export function ShareAnswerFields({
  shareId,
  questionId,
}: {
  shareId: string | null;
  questionId: number | null;
}) {
  if (!shareId && questionId === null) return null;
  return (
    <>
      {shareId ? <input type="hidden" name={SHARE_PARAM_SHARE_ID} value={shareId} /> : null}
      {questionId !== null ? (
        <input type="hidden" name="shareQuestionId" value={String(questionId)} />
      ) : null}
      <input type="hidden" name={SHARE_PARAM_SOURCE} value="share" />
    </>
  );
}
