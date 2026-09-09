"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";

import { SubmitButton } from "@/app/_pending";
import { btnPrimary, btnQuiet, btnSecondary, surface } from "@/app/_surface";
import {
  CONFIRM_FEEDBACK_MS,
  HOLD_MS,
  IDLE,
  advance,
  cancel,
  gaugeFraction,
  press,
  release,
  type Hold,
} from "@/features/quiz/hold";
import {
  afterCommit,
  commitExact,
  commitPair,
  missingQuestions,
  toggleTentative,
  type Picked,
  type PickedMap,
} from "@/features/quiz/answering";
import type { AnswerMode, QuizQuestion, WorkQuiz } from "@/features/quiz/types";

import { submitAnswerAction } from "./actions";

/**
 * 回答の画面（1セクションずつ・長押しで確定）。
 *
 * 【この部品ができるまでの形】
 *   問が縦に全部並んでいて、下まで読みながら全部にチェックを入れ、
 *   最後に1回送信していた。絵は**ページのいちばん上に1回だけ**あるので、
 *   3問目を読むころには画面から消えている。
 *   絵を当てる遊びなのに、絵を見ずに答える形になっていた。
 *
 * 【いまの形】
 *   絵が上に貼り付いたまま動かない。下半分だけが1セクションずつ入れ替わる。
 *   確定はカードの長押し（1.5秒）で、押している間、円のゲージが満ちる。
 *   満ちた瞬間に確定し、少し見せてから次のセクションへ移る。
 *   全部答えると最終確認が出て、そこで初めてサーバーへ送る。
 *
 * 【どこからどこへ値が渡るか】
 *   出題（quiz）はサーバーから props で降りてくる。正解は入っていない。
 *   選んだ語はこの部品の中だけに溜まり、DB へは一切行かない。
 *   最終確認で「回答する」を押すと、溜めた語が hidden の入力欄として
 *   フォームに並び、submitAnswerAction（サーバー側）へ渡る。
 *   採点は今までどおり DB の中だけで行われる。
 *
 *   つまり**書き込みは最後の1回だけ。**途中のセクションでは何も保存しない。
 *   1作品1回という決まりを増やしも減らしもしない。
 *
 * 【JavaScript が無いとき】
 *   この部品は動かない。そのときのために、今までの
 *   「全部並べてチェックする」フォームを noscript の中に残してある
 *   （page.tsx を見ること）。答える手段が消えることはない。
 */

/**
 * 途中経過をブラウザに預ける鍵。
 *
 * **これは DB ではない。**同じタブを読み込み直したときに戻るだけで、
 * 別の端末・別のブラウザには何も残らない。
 * 途中回答をサーバーに置く仕組みは、いまの DB に無い（後述の報告参照）。
 */
function draftKey(workId: string): string {
  return `dpq:answer:${workId}`;
}

/* ===========================================================================
 * 円のゲージ
 * ===========================================================================
 *
 * 【左回りにしている】
 *   時計回りは「時間が過ぎる」の絵で、待たされている感じが出る。
 *   左回りは巻き取っている感じになる。仕様として左回りが指定されている。
 *   向きは `scale(-1 1)` で鏡にして作る（角度の計算を反転させない。
 *   反転を式に混ぜると、満ちる量と向きの2つを同じ数式で追うことになる）。
 *
 * 【見た目の曲線と、確定の時刻は別】
 *   fraction には ease-out を掛けた値が来る。**確定は必ず1.5秒。**
 *   曲線を変えても確定時刻は動かない（features/quiz/hold.ts）。
 */
function Gauge({ fraction, done }: { fraction: number; done: boolean }) {
  const r = 12;
  const circumference = 2 * Math.PI * r;

  return (
    <svg viewBox="0 0 32 32" className="size-8 shrink-0" aria-hidden>
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        className="stroke-line-mid"
      />
      <circle
        cx="16"
        cy="16"
        r={r}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className={done ? "stroke-success" : "stroke-accent"}
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - fraction)}
        transform="rotate(-90 16 16) scale(-1 1) translate(-32 0)"
      />
    </svg>
  );
}

/* ===========================================================================
 * 長押しの受け口
 * ===========================================================================
 *
 * 【timer を1つしか作らない】
 *   カードごとに timer を持つと、速く押したり離したりしたときに
 *   古い timer が生き残って、離したあとに勝手に確定する。
 *   ここでは**画面全体で1本の requestAnimationFrame** だけを回し、
 *   「いまどのカードを押しているか」を1つの入れ物に持つ。
 *   別のカードを押したら、前のカードの分はその場で捨てられる。
 *
 * 【押した時間は時計から取る。数え上げない】
 *   フレームごとに1ずつ足す作りだと、機械が重いときに遅く満ちる。
 *   performance.now() の差だけで進めるので、重さは満ちる速さを変えない。
 */
function useHold(onComplete: (key: string) => void) {
  const [view, setView] = useState<{ key: string | null; hold: Hold }>({
    key: null,
    hold: IDLE,
  });

  const live = useRef<{ key: string | null; hold: Hold; raf: number }>({
    key: null,
    hold: IDLE,
    raf: 0,
  });

  // onComplete を loop の外に置く。中で参照すると、
  // 親が描き直されるたびに loop が作り直されて raf が二重になる。
  const done = useRef(onComplete);
  useEffect(() => {
    done.current = onComplete;
  }, [onComplete]);

  // 名前付きの関数式にしてある。**自分の名前で自分を予約できる**ので、
  // 次のフレームを頼むために外側の変数を先読みしなくて済む。
  const loop = useCallback(function step() {
    live.current.raf = 0;
    const now = performance.now();
    const next = advance(live.current.hold, now);
    live.current.hold = next;
    setView({ key: live.current.key, hold: next });

    if (next.phase === "done") {
      const key = live.current.key;
      live.current = { key: null, hold: IDLE, raf: 0 };
      if (key) done.current(key);
      return;
    }
    if (next.phase === "idle") {
      live.current.key = null;
      return;
    }
    live.current.raf = requestAnimationFrame(step);
  }, []);

  const kick = useCallback(() => {
    if (live.current.raf === 0) live.current.raf = requestAnimationFrame(loop);
  }, [loop]);

  const down = useCallback(
    (key: string) => {
      const now = performance.now();
      // 別のカードへ移ったら、前のカードの溜まりは引き継がない
      if (live.current.key !== key) {
        live.current.key = key;
        live.current.hold = { phase: "idle", progress: 0, at: now };
      }
      live.current.hold = press(live.current.hold, now);
      setView({ key, hold: live.current.hold });
      kick();
    },
    [kick],
  );

  const up = useCallback(
    (key: string, aborted: boolean) => {
      if (live.current.key !== key) return;
      const now = performance.now();
      live.current.hold = aborted
        ? cancel(live.current.hold, now)
        : release(live.current.hold, now);
      setView({ key, hold: live.current.hold });
      kick();
    },
    [kick],
  );

  // 部品が消えるときに回しっぱなしにしない
  useEffect(() => {
    const held = live;
    return () => {
      if (held.current.raf) cancelAnimationFrame(held.current.raf);
      held.current.raf = 0;
    };
  }, []);

  return { view, down, up };
}

/* ===========================================================================
 * 長押しできるボタン
 * ===========================================================================
 *
 * 【button のままにしている】
 *   div に押下の処理を付けると、キーボードの人と読み上げの人に
 *   「押せるもの」として届かなくなる。button なら Tab で回ってくるし、
 *   Space / Enter でも押せる。**長押ししか手段が無い形にしない**ため、
 *   キーボードの押しっぱなしも同じ1.5秒として受ける
 *   （keydown は押しっぱなしで繰り返し来るので、2回目以降は捨てる）。
 *
 * 【mouse に依存しない】
 *   pointer 系だけを見る。指でもペンでもマウスでも同じ道を通る。
 *   指が外へ滑った（pointerleave）、通知が割り込んだ（pointercancel）は
 *   どちらも「確定しない」側へ倒す。
 */
function HoldButton({
  holdKey,
  active,
  fraction,
  done,
  onDown,
  onUp,
  className,
  children,
  data,
  ariaLabel,
}: {
  holdKey: string;
  active: boolean;
  fraction: number;
  done: boolean;
  onDown: (key: string) => void;
  onUp: (key: string, aborted: boolean) => void;
  className?: string;
  children: React.ReactNode;
  data?: Record<`data-${string}`, string>;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      {...data}
      data-hold-key={holdKey}
      data-hold-progress={String(Math.round(fraction * 100))}
      data-hold-active={active ? "1" : "0"}
      /*
        **見た目の充填量と、確定したかどうかは別に出す。**
        充填の曲線は終盤ほど遅いので、見た目は 100% に見えていても
        まだ 1.5 秒に届いていないことがある。届いたかどうかを
        見た目の丸めた数字から読むと、届く手前で読み違える。
      */
      data-hold-done={done ? "1" : "0"}
      className={className}
      onPointerDown={(e) => {
        // 押している間に文字が選択されると、指を滑らせたときに
        // 選択が始まって押下が切れる
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onDown(holdKey);
      }}
      onPointerUp={() => onUp(holdKey, false)}
      onPointerCancel={() => onUp(holdKey, true)}
      onPointerLeave={() => onUp(holdKey, true)}
      onKeyDown={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault(); // Space での画面送りと、離した瞬間の click を止める
        if (e.repeat) return; // 押しっぱなしの2回目以降は捨てる（timer を増やさない）
        onDown(holdKey);
      }}
      onKeyUp={(e) => {
        if (e.key !== " " && e.key !== "Enter") return;
        e.preventDefault();
        onUp(holdKey, false);
      }}
      onBlur={() => onUp(holdKey, true)}
    >
      <Gauge fraction={fraction} done={done} />
      <span className="min-w-0 flex-1 text-left">{children}</span>
    </button>
  );
}

/* ===========================================================================
 * セクション1つ
 * ===========================================================================
 */

const cardShape =
  "flex w-full min-h-14 items-center gap-3 rounded-xl border px-4 py-3 text-sm transition select-none touch-none";

function Section({
  question,
  index,
  total,
  mode,
  picked,
  tentative,
  holdKey,
  holdFraction,
  holdDone,
  onDown,
  onUp,
  onMode,
  onTentative,
  onPrev,
}: {
  question: QuizQuestion;
  index: number;
  total: number;
  mode: AnswerMode;
  picked: Picked | undefined;
  tentative: number[];
  holdKey: string | null;
  holdFraction: number;
  holdDone: boolean;
  onDown: (key: string) => void;
  onUp: (key: string, aborted: boolean) => void;
  onMode: (mode: AnswerMode) => void;
  onTentative: (tagId: number) => void;
  onPrev: (() => void) | null;
}) {
  const pairReady = tentative.length === 2;

  return (
    <div
      data-section={question.question_id}
      data-section-index={String(index)}
      data-section-total={String(total)}
      data-slot-key={question.card_slot_key}
      data-section-mode={mode}
      data-section-answered={picked ? "1" : "0"}
      className="space-y-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs text-faint" data-section-position>
          セクション {index + 1} / {total}
        </p>
        {picked ? (
          <p className="text-xs text-success">
            回答済み（{picked.mode === "exact" ? "ビタ当て" : "複勝"}）
          </p>
        ) : null}
      </div>

      <h3 className="text-base font-bold">{question.card_slot_label} はどれ？</h3>

      {/* 答え方の切り替え。**確定済みの回答はここでは消えない。**
          消えるのは、まだ確定していない仮の選択だけ */}
      <div className="flex gap-2" role="group" aria-label="答え方">
        {(["exact", "pair"] as const).map((m) => (
          <button
            key={m}
            type="button"
            data-mode-button={m}
            aria-pressed={mode === m}
            onClick={() => onMode(m)}
            className={[
              "inline-flex min-h-11 items-center rounded-full px-4 text-xs font-bold",
              mode === m
                ? "bg-accent text-on-accent"
                : "border border-line-mid hover:bg-hover",
            ].join(" ")}
          >
            {m === "exact" ? "ビタ当て" : "複勝"}
          </button>
        ))}
      </div>

      <p className="text-xs text-faint">
        {mode === "exact"
          ? "1語を長押しすると、その語で確定します。"
          : "2語を選んでから、下のボタンを長押しすると確定します。どちらかが当たれば的中で、記録には「2択当て」として残ります。"}
      </p>

      <div className="grid gap-2 sm:grid-cols-2">
        {question.choices.map((c) => {
          const key = `q${question.question_id}:${c.tag_id}`;
          const isPicked = picked?.tags.includes(c.tag_id) ?? false;
          const isTentative = tentative.includes(c.tag_id);

          if (mode === "pair") {
            // 複勝は「まず2語を選び、それから確定」。
            // ここを押しても何も確定しない（選ぶだけ）
            return (
              <button
                key={c.tag_id}
                type="button"
                data-answer-card={String(c.tag_id)}
                data-choice-label={c.label}
                data-tentative={isTentative ? "1" : "0"}
                aria-pressed={isTentative}
                onClick={() => onTentative(c.tag_id)}
                className={[
                  cardShape,
                  isTentative
                    ? "border-line-active bg-hover font-bold"
                    : "border-line hover:bg-sunken",
                ].join(" ")}
              >
                <span
                  aria-hidden
                  className={[
                    "inline-flex size-8 shrink-0 items-center justify-center rounded-full border text-xs",
                    isTentative ? "border-line-active" : "border-line-mid",
                  ].join(" ")}
                >
                  {isTentative ? "✓" : ""}
                </span>
                <span className="min-w-0 flex-1 text-left">{c.label}</span>
              </button>
            );
          }

          const active = holdKey === key;
          return (
            <HoldButton
              key={c.tag_id}
              holdKey={key}
              active={active}
              fraction={active ? holdFraction : 0}
              done={active && holdDone}
              onDown={onDown}
              onUp={onUp}
              ariaLabel={`${c.label} を長押しして確定`}
              data={{
                "data-answer-card": String(c.tag_id),
                "data-choice-label": c.label,
              }}
              className={[
                cardShape,
                isPicked
                  ? "border-line-active bg-hover font-bold"
                  : "border-line hover:bg-sunken",
              ].join(" ")}
            >
              {c.label}
            </HoldButton>
          );
        })}
      </div>

      {mode === "pair" ? (
        <div className="space-y-2">
          <HoldButton
            holdKey={`pair${question.question_id}`}
            active={holdKey === `pair${question.question_id}`}
            fraction={holdKey === `pair${question.question_id}` ? holdFraction : 0}
            done={holdKey === `pair${question.question_id}` && holdDone}
            onDown={pairReady ? onDown : () => {}}
            onUp={pairReady ? onUp : () => {}}
            ariaLabel="選んだ2語で確定"
            data={{ "data-pair-commit": pairReady ? "ready" : "waiting" }}
            className={[
              cardShape,
              "justify-center",
              pairReady
                ? "border-line-firm font-bold"
                : "border-line text-faint",
            ].join(" ")}
          >
            {pairReady
              ? "この2語で確定（長押し）"
              : `あと ${2 - tentative.length} 語選んでください`}
          </HoldButton>
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-2">
        {onPrev ? (
          <button
            type="button"
            data-prev-section
            onClick={onPrev}
            className={btnSecondary}
          >
            ← 前へ
          </button>
        ) : (
          <span />
        )}
        <p className="text-xs text-faint">
          押している間だけ進みます。離すとゆっくり戻ります。
        </p>
      </div>
    </div>
  );
}

/* ===========================================================================
 * 最終確認
 * ===========================================================================
 *
 * 【ここで初めてサーバーへ行く】
 *   セクションで確定したものは、まだこのブラウザの中にしかない。
 *   **送るのはこの画面の1回だけ。**戻って直せるのもここまで。
 */
function Confirm({
  quiz,
  picked,
  onEdit,
  onBack,
}: {
  quiz: WorkQuiz;
  picked: PickedMap;
  onEdit: (index: number) => void;
  onBack: () => void;
}) {
  const labelOf = (question: QuizQuestion, tagId: number) =>
    question.choices.find((c) => c.tag_id === tagId)?.label ?? String(tagId);

  const missing = missingQuestions(
    picked,
    quiz.questions.map((q) => q.question_id),
  );

  return (
    /*
      預けてある途中経過は**送ったあとも消さない。**
      送信が断られて画面が戻ったとき（すでに答えている・通信が切れた等）に
      消してあると、選び直した内容がまるごと消える。
      答え終わった作品ではこの部品自体が出ないので、残っていても読まれない。
    */
    <form action={submitAnswerAction} data-confirm-stage className="space-y-4">
      <input type="hidden" name="workId" value={quiz.work_id} />

      <div className="space-y-1">
        <h3 className="text-base font-bold">この内容で送ります</h3>
        <p className="text-xs text-faint">
          送ると採点され、正解が表示されます。答えられるのは1回だけで、
          やり直しはできません。
        </p>
      </div>

      <ul className="space-y-2">
        {quiz.questions.map((q, i) => {
          const p = picked[q.question_id];
          return (
            <li
              key={q.question_id}
              data-answer-row={String(q.question_id)}
              data-picked-mode={p?.mode ?? ""}
              data-picked-tags={(p?.tags ?? []).join(",")}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-xl border border-line px-4 py-3"
            >
              <span className="text-xs text-faint">{q.card_slot_label}</span>
              <span className="text-sm">
                {p ? (
                  <>
                    <span className="font-bold">{labelOf(q, p.tags[0])}</span>
                    {p.tags[1] !== undefined ? (
                      <>
                        <span className="px-1 text-faint">か</span>
                        <span className="font-bold">{labelOf(q, p.tags[1])}</span>
                      </>
                    ) : null}
                    <span className="pl-2 text-xs text-faint">
                      {p.mode === "exact" ? "ビタ当て" : "複勝"}
                    </span>
                  </>
                ) : (
                  <span className="text-danger">未回答</span>
                )}
              </span>
              <button
                type="button"
                data-edit-section={String(i)}
                onClick={() => onEdit(i)}
                className={btnQuiet}
              >
                戻って直す
              </button>
              {p?.tags.map((t) => (
                <input
                  key={t}
                  type="hidden"
                  name={`q_${q.question_id}`}
                  value={t}
                />
              ))}
            </li>
          );
        })}
      </ul>

      {missing.length > 0 ? (
        <p className="text-xs text-danger" data-confirm-missing={String(missing.length)}>
          まだ答えていないセクションが {missing.length} 個あります。
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={onBack} className={btnSecondary}>
          ← セクションへ戻る
        </button>
        <SubmitButton
          pendingLabel="採点しています…"
          className={`${btnPrimary} flex-1`}
          disabled={missing.length > 0}
        >
          回答する
        </SubmitButton>
      </div>

      <p className="text-xs text-faint">
        サインインしていない場合、送信した時点でゲストとして記録されます。
        アカウント登録は不要です。
      </p>
    </form>
  );
}

/* ===========================================================================
 * 全体
 * ===========================================================================
 */

export function AnswerFlow({
  quiz,
  imageSrc,
  imageWidth,
  imageHeight,
  title,
}: {
  quiz: WorkQuiz;
  /**
   * 画像の場所（できあがった URL）。
   *
   * **組み立てはサーバー側でやって、ここへは結果だけ渡す。**
   * 組み立ての関数は Supabase につなぐ側の部品と同じファイルにあり、
   * ブラウザへ持ち込むと接続の道具まで一緒に運ばれてしまう。
   */
  imageSrc: string;
  imageWidth: number;
  imageHeight: number;
  title: string;
}) {
  const total = quiz.questions.length;

  const [index, setIndex] = useState(0);
  const [stage, setStage] = useState<"sections" | "confirm">("sections");
  const [picked, setPicked] = useState<PickedMap>({});
  const [modes, setModes] = useState<Record<number, AnswerMode>>({});
  const [tentative, setTentative] = useState<Record<number, number[]>>({});
  const [restored, setRestored] = useState(false);
  const [justConfirmed, setJustConfirmed] = useState<number | null>(null);

  const advanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const question = quiz.questions[Math.min(index, Math.max(0, total - 1))];
  const mode: AnswerMode = question ? modes[question.question_id] ?? "exact" : "exact";

  /* --- 途中経過の預かり（このタブの中だけ） ------------------------------ */

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(draftKey(quiz.work_id));
      if (raw) {
        const saved = JSON.parse(raw) as {
          picked?: PickedMap;
          modes?: Record<number, AnswerMode>;
          tentative?: Record<number, number[]>;
          index?: number;
          stage?: "sections" | "confirm";
        };
        // 出題が入れ替わっていたら捨てる（別の問のIDを持ち込まない）
        const ids = new Set(quiz.questions.map((q) => q.question_id));
        const kept: PickedMap = {};
        for (const [k, v] of Object.entries(saved.picked ?? {})) {
          if (ids.has(Number(k))) kept[Number(k)] = v;
        }
        /*
          ここだけ「効果の中で状態を入れる」形になる。
          sessionStorage は React の外にある入れ物で、**サーバー側には
          存在しない。**組み立て直後の画面と食い違わせないために、
          描いたあとで1回だけ読み込んで入れ直している。
          読むのは最初の1回だけなので、描き直しが連鎖することはない。
        */
        /* eslint-disable react-hooks/set-state-in-effect */
        setPicked(kept);
        setModes(saved.modes ?? {});
        setTentative(saved.tentative ?? {});
        setIndex(Math.min(saved.index ?? 0, Math.max(0, total - 1)));
        setStage(saved.stage === "confirm" ? "confirm" : "sections");
        /* eslint-enable react-hooks/set-state-in-effect */
      }
    } catch {
      // 使えない設定のブラウザでは、ただ復元しないだけ
    }
    setRestored(true);
  }, [quiz.work_id, quiz.questions, total]);

  useEffect(() => {
    if (!restored) return;
    try {
      sessionStorage.setItem(
        draftKey(quiz.work_id),
        JSON.stringify({ picked, modes, tentative, index, stage }),
      );
    } catch {
      // 預けられなくても回答そのものは続けられる
    }
  }, [restored, quiz.work_id, picked, modes, tentative, index, stage]);

  /* --- 長押しが満ちたとき ------------------------------------------------ */

  const onComplete = useCallback(
    (key: string) => {
      if (!question) return;
      const qid = question.question_id;

      // 何を確定するかの決まりは features/quiz/answering.ts が持つ。
      // ここは押された鍵を読み替えて渡すだけ
      const isPair = key.startsWith("pair");
      const tagId = Number(key.split(":")[1]);
      const tags = tentative[qid] ?? [];

      // **新しい中身を先に作ってから入れる。**
      // 入れる関数の中で「変わったか」を見ようとすると、その関数が呼ばれるのは
      // 次に画面を描くときなので、直後に読んでも答えが出ていない。
      const next = isPair
        ? commitPair(picked, qid, tags)
        : Number.isFinite(tagId)
          ? commitExact(picked, qid, tagId)
          : picked;

      // 2語そろっていない複勝など、確定できない押下はここで終わる。
      // 次のセクションへも進まない
      if (next === picked) return;

      setPicked(next);
      setJustConfirmed(qid);

      // 進む予定は常に1つだけ。押し直しても2つにならない
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
      advanceTimer.current = setTimeout(() => {
        advanceTimer.current = null;
        setJustConfirmed(null);
        setIndex((i) => {
          const to = afterCommit(i, total);
          if (to.stage === "confirm") setStage("confirm");
          return to.index;
        });
      }, CONFIRM_FEEDBACK_MS);
    },
    [question, tentative, picked, total],
  );

  useEffect(
    () => () => {
      if (advanceTimer.current) clearTimeout(advanceTimer.current);
    },
    [],
  );

  const { view, down, up } = useHold(onComplete);
  const fraction = gaugeFraction(view.hold.progress);
  const holdDone = view.hold.phase === "done";

  /* --- 操作 -------------------------------------------------------------- */

  const setMode = (m: AnswerMode) => {
    if (!question) return;
    const qid = question.question_id;
    setModes((prev) => ({ ...prev, [qid]: m }));
    // 未確定の仮選択だけ片付ける。**確定済みの回答には触らない**
    if (m === "exact") setTentative((prev) => ({ ...prev, [qid]: [] }));
  };

  const pickTentative = (tagId: number) => {
    if (!question) return;
    const qid = question.question_id;
    setTentative((prev) => ({
      ...prev,
      [qid]: toggleTentative(prev[qid] ?? [], tagId),
    }));
  };

  const answered = quiz.questions.filter((q) => picked[q.question_id]).length;

  if (total === 0) {
    return (
      <div className={surface}>
        <p className="text-sm">この作品にはまだ問題が用意されていません。</p>
      </div>
    );
  }

  return (
    <section
      data-answer-flow
      data-answered-count={String(answered)}
      data-stage={stage}
      className="overflow-hidden rounded-2xl border border-line bg-surface"
    >
      {/*
        絵は貼り付いたまま動かない。**下だけが入れ替わる。**
        高さを画面の 42% までに抑えているのは、下の回答欄が
        スマホでも1画面に収まるようにするため。
      */}
      <div className="sticky top-14 z-10 border-b border-line bg-surface px-4 py-3">
        <Image
          src={imageSrc}
          alt={title}
          width={imageWidth}
          height={imageHeight}
          sizes="(max-width: 768px) 100vw, 768px"
          className="mx-auto h-auto max-h-[42vh] w-auto object-contain"
        />
      </div>

      <div className="space-y-4 p-4 sm:p-6">
        <div className="flex items-center gap-2">
          {quiz.questions.map((q, i) => (
            <span
              key={q.question_id}
              aria-hidden
              className={[
                "h-1.5 flex-1 rounded-full",
                picked[q.question_id]
                  ? "bg-accent"
                  : i === index && stage === "sections"
                    ? "bg-line-active"
                    : "bg-sunken-strong",
              ].join(" ")}
            />
          ))}
        </div>

        {stage === "sections" && question ? (
          <>
            <Section
              question={question}
              index={index}
              total={total}
              mode={mode}
              picked={picked[question.question_id]}
              tentative={tentative[question.question_id] ?? []}
              holdKey={view.key}
              holdFraction={fraction}
              holdDone={holdDone}
              onDown={down}
              onUp={up}
              onMode={setMode}
              onTentative={pickTentative}
              onPrev={index > 0 ? () => setIndex(index - 1) : null}
            />

            {justConfirmed === question.question_id ? (
              <p
                data-just-confirmed
                aria-live="polite"
                className="rounded-xl bg-success-tint/10 px-4 py-2 text-xs text-success"
              >
                この回答で確定しました
              </p>
            ) : null}

            {answered === total ? (
              <button
                type="button"
                data-to-confirm
                onClick={() => setStage("confirm")}
                className={`${btnPrimary} w-full`}
              >
                最終確認へ
              </button>
            ) : null}
          </>
        ) : (
          <Confirm
            quiz={quiz}
            picked={picked}
            onEdit={(i) => {
              setIndex(i);
              setStage("sections");
            }}
            onBack={() => setStage("sections")}
          />
        )}
      </div>
    </section>
  );
}

/** 長押しの秒数を画面の説明文に出すため（1か所から取る） */
export const HOLD_SECONDS = HOLD_MS / 1000;
