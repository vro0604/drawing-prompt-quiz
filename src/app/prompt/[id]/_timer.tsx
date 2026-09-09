import { SubmitButton } from "@/app/_pending";
import { btnPrimary, btnSecondary, noticeError, noticeMuted, surface } from "@/app/_surface";
import { formatDuration, type PromptTimer } from "@/features/draft/types";
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
 *   **このページでは、その帯が大きい形になる（P5）。**残り時間が
 *   画面いちばん上に、いちばん大きな字で出る。ここはその下に置かれる面なので、
 *   同じ数を二重に出さないことがいっそう大事になる。
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
        <p className="text-xs text-faint">
          このお題に期限はありません。時間切れで挑戦が終わることもありません。
          経過時間は画面いちばん上の帯に出ます。
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

  // --- 長い放置で自動破棄された ---------------------------------------------
  //
  // 掃除が status を 'discarded' にするのを待たずに、
  // **その場で計算した is_discarded** で出す。
  // 待つと「投稿ボタンは出ているのに押すと断られる」画面になる。
  //
  // 【予定終了時刻の超過ではここへ来ない（2026-09-09）】
  //   超過しても挑戦は続く。ここへ来るのは、48時間何も操作しなかったときだけ。
  if (timer.status === "discarded" || timer.status === "failed" || timer.is_discarded) {
    return (
      <section className={`${surface} space-y-3`}>
        <h2 className="text-sm font-bold">この制作は自動的に破棄されました</h2>
        <p className={noticeError}>
          2日間操作がなかったため、制作途中のお題を自動的に破棄しました。
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
        {/*
          【2026-09-07 に静止表示を外した（D171）】
            残り時間と経過は、画面いちばん上の帯が1秒ごとに描いている。
            同じ数を動く側と動かない側の2か所に出すと、
            **どちらが本当か読めなくなる**（利用者からの指摘）。
            ここに残すのは、帯が出していない「期限の時刻」だけ。

            data-* の印は消さずにこの行へ移した。
            本番の検査がこの印でお題ページを見ているため。
        */}
        <p
          data-timer=""
          data-seconds-left={left}
          data-can-renew={timer.can_renew ? "1" : "0"}
          className="text-sm"
        >
          {formatDuration(timer.time_limit_seconds)}枠・期限 {at(timer.deadline_at)}
          {timer.renew_count > 0 ? `・${timer.renew_count} 回延長` : ""}
        </p>
        <p className="text-xs text-faint">
          残り時間と経過は、画面いちばん上の帯に出ます。
          経過は「お題を引き始めた時刻」から数え、時間を延ばしても戻りません。
        </p>
      </div>

      {overrun ? (
        <p className={noticeError} data-field="overrun-note">
          制作予定時間を超過しています。
          <strong>制作はそのまま続けられます。</strong>
          必要なら下のボタンで延長できます。超過しても、この挑戦が失敗になることは
          ありません。
        </p>
      ) : null}

      {timer.auto_discard_at ? (
        <p className={noticeMuted} data-field="discard-note">
          制作途中のお題は、最後の操作から2日間まったく操作が無いと自動的に
          破棄されます（いまの予定は {at(timer.auto_discard_at)}）。
          制作を続けているあいだは、この期限は数え直されます。
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
            いまの終了予定に、元の制限時間の 3/4 が足されます。
            残っている時間は捨てられません。超過中に押したときは、
            押した時刻から数え直します。押せる時刻の決まりは無く、回数に上限も
            ありません。
          </p>
        </form>
      ) : (
        <p className={noticeMuted}>
          制作時間が無制限のお題なので、延長はありません。
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
