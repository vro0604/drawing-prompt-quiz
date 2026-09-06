import { SubmitButton } from "@/app/_pending";
import { btnPrimary, btnSecondary, noticeError, noticeMuted, surface } from "@/app/_surface";
import { formatDuration, formatRemaining, type PromptTimer } from "@/features/draft/types";
import { clock } from "@/features/challenge/types";
import { formatShortDateTime } from "@/lib/datetime";
import type { PromptCard } from "@/features/draft/types";
import { MAX_CARRY_PER_SAVE } from "@/features/carry/types";
import { carryFromPromptAction, renewDeadlineAction } from "./actions";

/**
 * 確定したお題の画面のうち、時間と持ち出しの部分（D163 / D161）。
 *
 * 【秒が動くのは画面いちばん上の帯】
 *   1秒ごとの表示は共通レイアウトの帯（_challenge-bar.tsx）が受け持つ。
 *   帯はサーバー時刻と自分を同期させたうえで秒を描き、
 *   タブが背面にいた時間も、閉じていた時間も経過に入る。
 *
 *   **ここは動かない値だけを出す。**開いた瞬間の経過・残り・期限の時刻と、
 *   更新の意味の説明。動く数と動かない数が同じ場所に並ぶと、
 *   どちらが本当か読めなくなるので、役割で分ける。
 *
 * 【無制限は別のものとして出す（D163）】
 *   残り時間も、更新のボタンも、猶予の説明も出さない。
 *   「無制限＝残り時間が非常に長い」ではなく、そもそも別の扱いなので、
 *   同じ枠の中に数字を出さない。経過だけを出す。
 */

/**
 * 時刻を「9月4日 23:42」の形にする。
 *
 * **時間帯を明示している。**この関数はサーバー側で動く（Server Component）。
 * サーバーの時計は UTC なので、指定しないと日本の利用者に9時間ずれた時刻が出る。
 * 期限の表示でずれると、そのまま「間に合ったつもりで間に合わない」事故になる。
 */
function at(iso: string | null): string {
  return formatShortDateTime(iso);
}

export function TimerBox({
  promptId,
  timer,
}: {
  promptId: string;
  timer: PromptTimer;
}) {
  // --- 無制限（D163）--------------------------------------------------------
  if (timer.is_unlimited) {
    return (
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">制作時間</h2>
        <p className="text-lg font-bold">無制限</p>
        <p className="text-sm tabular-nums" data-field="elapsed">
          開始からの経過 {clock(timer.elapsed_seconds)}
          <span className="pl-2 text-xs text-faint">（この画面を開いた時点）</span>
        </p>
        <p className="text-xs text-faint">
          このお題に期限はありません。時間切れで挑戦が終わることもありません。
          経過時間は画面いちばん上の帯で秒ごとに進みます。
        </p>
      </section>
    );
  }

  // --- 期限を持たない古いお題 -----------------------------------------------
  //
  // オーバー更新制が入る前に引かれたお題には期限が入っていない。
  // **数字を作らない。**「無制限」とも書かない（選んだのは有限の時間なので）。
  if (!timer.has_deadline) {
    return (
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">制作時間</h2>
        <p className="text-lg font-bold">{formatDuration(timer.time_limit_seconds)}</p>
        <p className="text-xs text-faint">
          このお題には期限が設定されていません。時間切れにはなりません。
        </p>
      </section>
    );
  }

  // --- 投稿して終わった -----------------------------------------------------
  //
  // 時計は止まっている。かかった時間を結果として出す。
  if (timer.status === "submitted") {
    return (
      <section className={`${surface} space-y-2`}>
        <h2 className="text-sm font-bold">この挑戦は終わりました</h2>
        <p className="text-lg font-bold tabular-nums" data-field="elapsed">
          かかった時間 {clock(timer.elapsed_seconds)}
        </p>
        <p className="text-xs text-faint">
          {formatDuration(timer.time_limit_seconds)}枠
          {timer.renew_count > 0 ? `・${timer.renew_count} 回延長` : ""}
        </p>
      </section>
    );
  }

  // --- 挑戦が終わっている ---------------------------------------------------
  //
  // status が 'failed' になるのは掃除が回ったあと。それを待たずに
  // **その場で計算した is_expired** で終了を出す。
  // 待つと「投稿ボタンは出ているのに押すと断られる」画面になる。
  if (timer.status === "failed" || timer.is_expired) {
    return (
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">この挑戦は終了しました</h2>
        <p className={noticeError}>
          時間を延ばさないまま猶予を過ぎたため、このお題では投稿できません。
          描いた絵やこれまでの記録が消えることはありません。
        </p>
        <p className="text-xs text-faint">
          新しいお題を引くと、また最初から始められます。
        </p>
      </section>
    );
  }

  const left = timer.seconds_left ?? 0;
  const overrun = left < 0;

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">制作時間</h2>
        <p
          data-timer=""
          data-seconds-left={left}
          data-can-renew={timer.can_renew ? "1" : "0"}
          className="text-2xl font-bold tabular-nums"
        >
          {overrun ? `${formatRemaining(left)}` : `残り ${formatRemaining(left)}`}
        </p>
        <p className="text-sm tabular-nums" data-field="elapsed">
          {formatDuration(timer.time_limit_seconds)}枠・開始からの経過{" "}
          {clock(timer.elapsed_seconds)}
        </p>
        <p className="text-xs text-faint">
          期限 {at(timer.deadline_at)}
          {timer.renew_count > 0 ? `・${timer.renew_count} 回延長` : ""}
        </p>
        <p className="text-xs text-faint">
          経過は「お題を引き始めた時刻」から数えます。カードをめくっていた時間も
          入っていて、時間を延ばしても戻りません。秒は画面いちばん上の帯で進みます。
        </p>
      </div>

      {overrun ? (
        <p className={noticeError}>
          期限を過ぎています。{at(timer.grace_ends_at)} までに時間を延ばさないと、
          この挑戦は終了します。作品や記録が消えることはありません。
        </p>
      ) : null}

      {timer.can_renew ? (
        <form action={renewDeadlineAction} className="space-y-2">
          <input type="hidden" name="promptId" value={promptId} />
          <SubmitButton
            pendingLabel="延ばしています…"
            className={overrun ? btnPrimary : btnSecondary}
          >
            制作時間を延ばす
          </SubmitButton>
          <p className="text-xs text-faint">
            押した時刻から、元の制限時間の 3/4 が新しい期限になります。
            いま残っている時間は繰り越されません。回数に上限はありません。
          </p>
        </form>
      ) : (
        <p className={noticeMuted}>
          {at(timer.renew_opens_at)} から「制作時間を延ばす」を押せるようになります。
          押せる間に延ばせば、何度でも続けられます。
        </p>
      )}
    </section>
  );
}

/**
 * 自分のお題から要素を持ち出す（D161 ＋ 2026-09-05 の3区分）。
 *
 * 【ここから持ち出す意味】
 *   引いたお題が気に入ったが、いまは描かない。あるいは、
 *   1つの語だけ残して残りは引き直したい。そのための入口。
 *   持ち出した要素は、次にお題を引くときに使う。
 *
 * 【ゲストにも出す】
 *   ゲストの持ち出しは「いまの流れの中だけ」で、次のお題を確定した時点で
 *   手元から無くなる。**欄を隠すのではなく、何が起きるかを書く。**
 */
export function CarryFromPromptBox({
  promptId,
  cards,
  canPersist,
}: {
  promptId: string;
  cards: PromptCard[];
  /** 別のセッションへ残せるか（＝登録者か） */
  canPersist: boolean;
}) {
  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">要素を持ち出す</h2>
        <p className="text-xs text-faint">
          {MAX_CARRY_PER_SAVE}個まで選べます。次にお題を引くとき、
          選んだ要素を最初から入れた状態で始められます。
        </p>
      </div>

      <form action={carryFromPromptAction} className="space-y-4">
        <input type="hidden" name="promptId" value={promptId} />

        <div className="flex flex-wrap gap-2">
          {cards.map((c) => (
            <label
              key={c.card_slot_key}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-lg border border-line px-3 py-2 text-xs has-checked:border-line-active has-checked:bg-hover"
            >
              <input type="checkbox" name="tagId" value={c.tag_id} className="mr-2" />
              <span className="text-faint">{c.card_slot_label}</span>
              <span className="pl-2 font-bold">{c.tag_label}</span>
            </label>
          ))}
        </div>

        <SubmitButton pendingLabel="持ち出しています…" className={btnSecondary}>
          選んだ要素を持ち出す
        </SubmitButton>

        {canPersist ? (
          <p className="text-xs text-faint">
            これは自分のお題からの持ち出しなので「自分のお題から」の枠に入り、
            別の日に開いても残ります。枠がいっぱいのときは、
            先に要らないものを捨ててください。
          </p>
        ) : (
          <p className="text-xs text-faint">
            ゲストのままでも持ち出せます。ただし残るのは
            <span className="font-bold">いまの流れの中だけ</span>で、
            次のお題を確定した時点で手元から無くなります。
          </p>
        )}
      </form>
    </section>
  );
}
