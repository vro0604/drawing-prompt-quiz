import {
  TIME_LIMIT_CHOICES,
  formatDuration,
  type DraftMode,
  type DraftSlot,
  type DraftState,
} from "@/features/draft/types";
import { SubmitButton } from "@/app/_pending";
import {
  abandonDraftAction,
  completeDraftAction,
  rerollDraftAction,
  revealCardAction,
  startDraftAction,
} from "./actions";
import { field, surface } from "@/app/_surface";

/**
 * /play の見た目の部品。
 *
 * すべて Server Component で、状態は DB にしか持たない。
 * ボタンは form の submit で、押すと Server Action が動いて画面が再描画される。
 * JavaScript が無効でも動く（表示・操作の両方がサーバー側で完結する）。
 */

export function ErrorBox({ message }: { message: string }) {
  return (
    <p className="rounded-xl bg-danger-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-danger">
      {message}
    </p>
  );
}

/** モードと制作時間を選んでドラフトを始める */
export function StartForm({ modes }: { modes: DraftMode[] }) {
  if (modes.length === 0) {
    return (
      <div className={surface}>
        <p className="text-sm">
          使えるモードがありません。マスタデータが入っているか確認してください。
        </p>
      </div>
    );
  }

  return (
    <form action={startDraftAction} className={`${surface} space-y-6`}>
      <div className="space-y-3">
        <h2 className="text-sm font-bold">モード</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {modes.map((mode, i) => (
            <label
              key={mode.mode_key}
              className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-4 hover:bg-sunken has-checked:border-line-active"
            >
              <input
                type="radio"
                name="modeKey"
                value={mode.mode_key}
                defaultChecked={i === 0}
                className="mt-1"
              />
              <span className="space-y-1">
                <span className="block text-base font-bold">{mode.label}</span>
                <span className="block text-xs text-faint">
                  {/* 「3項目 × 候補3枚」のように、枠数と1枠あたりの枚数を分けて示す（D16） */}
                  候補 {mode.candidate_count} 枚／枠・引き直し {mode.max_rerolls} 回・
                  クイズ {mode.quiz_question_count} 問
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-bold">制作時間</h2>
        <select
          name="timeLimitSeconds"
          defaultValue="3600"
          className={field}
        >
          {TIME_LIMIT_CHOICES.map((c) => (
            <option key={c.label} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-faint">
          時間は運任せにせず自分で決める（D5）。あとから変更はできない。
        </p>
      </div>

      <SubmitButton
        pendingLabel="始めています…"
        className="w-full rounded-xl bg-accent px-5 py-3 text-sm font-bold text-on-accent hover:opacity-85"
      >
        ドラフトを始める
      </SubmitButton>
    </form>
  );
}

/** 伏せカード1枚。めくる前は中身を持っていない */
function CandidateButton({
  sessionId,
  slot,
  candidateIndex,
  revealed,
  isChosen,
  label,
  selectable,
}: {
  sessionId: string;
  slot: DraftSlot;
  candidateIndex: number;
  revealed: boolean;
  isChosen: boolean;
  label: string | null;
  selectable: boolean;
}) {
  const base =
    "flex h-24 w-full items-center justify-center rounded-xl border text-center text-sm font-bold transition";

  if (isChosen) {
    return (
      <div
        className={`${base} border-success-tint/50 bg-success-tint/10 text-success`}
      >
        {label}
      </div>
    );
  }

  if (revealed) {
    return (
      <div className={`${base} border-ink/10 bg-sunken text-faint`}>
        {label}
      </div>
    );
  }

  if (!selectable) {
    return (
      <div className={`${base} border-dashed border-ink/15 text-decor`}>
        ?
      </div>
    );
  }

  return (
    <form action={revealCardAction}>
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="cardSlotKey" value={slot.card_slot_key} />
      <input type="hidden" name="candidateIndex" value={candidateIndex} />
      {/* data-card が検査の手がかり。「?」という**文字**を数えさせない。
          めくる前のカードをどんな見た目にしても、枚数の検査は通る。 */}
      <SubmitButton
        pendingLabel="…"
        title="このカードをめくる"
        data={{ "data-card": "hidden" }}
        className={`${base} cursor-pointer border-line-firm hover:border-ink/60 hover:bg-hover`}
      >
        ?
      </SubmitButton>
    </form>
  );
}

/** 1つの枠と、その伏せカード一式 */
function SlotRow({ state, slot }: { state: DraftState; slot: DraftSlot }) {
  const decided = slot.candidates.some((c) => c.is_chosen);

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-bold">
          {slot.slot_order}. {slot.card_slot_label}
        </h3>
        {decided ? (
          <span className="text-xs text-success">決定</span>
        ) : slot.is_current ? (
          <span className="text-xs font-bold">← いまここ。1枚めくると確定します</span>
        ) : (
          <span className="text-xs text-faint">順番待ち</span>
        )}
      </div>

      <div
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${slot.candidates.length}, minmax(0, 1fr))` }}
      >
        {slot.candidates.map((c) => (
          <CandidateButton
            key={c.candidate_index}
            sessionId={state.session_id}
            slot={slot}
            candidateIndex={c.candidate_index}
            revealed={c.revealed}
            isChosen={c.is_chosen}
            label={c.label}
            selectable={slot.is_current && !decided}
          />
        ))}
      </div>
    </section>
  );
}

/** 進行中のドラフト盤面 */
export function DraftBoard({ state }: { state: DraftState }) {
  return (
    <div className="space-y-8">
      {/* 進み具合は data-* にも出す。以前の検査は「0 / 5 枠 決定」という
          **文言**で盤面が出たことを確かめていたので、言い回しを変えると落ちた。 */}
      <div
        data-board=""
        data-chosen={state.chosen_count}
        data-slots={state.slot_count}
        className={`${surface} space-y-2`}
      >
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-base font-bold">{state.mode_label}</span>
          <span className="text-xs text-faint">
            制作時間 {formatDuration(state.time_limit_seconds)}
          </span>
          <span className="text-xs text-faint">
            {state.chosen_count} / {state.slot_count} 枠 決定
          </span>
          <span className="text-xs text-faint">
            引き直し 残り {state.rerolls_left} 回
          </span>
        </div>
        <p className="text-xs text-faint">
          めくったカードがそのまま答えになります。順番に1枚ずつ選んでください。
        </p>
      </div>

      <div className="space-y-8">
        {state.slots.map((slot) => (
          <SlotRow key={slot.card_slot_key} state={state} slot={slot} />
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        {state.is_ready_to_complete ? (
          <form action={completeDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton
              pendingLabel="確定しています…"
              className="rounded-xl bg-accent px-6 py-3 text-sm font-bold text-on-accent hover:opacity-85"
            >
              このお題で確定する
            </SubmitButton>
          </form>
        ) : null}

        {state.rerolls_left > 0 ? (
          <form action={rerollDraftAction}>
            <input type="hidden" name="sessionId" value={state.session_id} />
            <SubmitButton
              pendingLabel="引き直しています…"
              className="rounded-xl border border-line-firm px-6 py-3 text-sm font-bold hover:bg-hover"
            >
              全部引き直す（残り {state.rerolls_left} 回）
            </SubmitButton>
          </form>
        ) : null}

        <form action={abandonDraftAction}>
          <input type="hidden" name="sessionId" value={state.session_id} />
          <SubmitButton
            pendingLabel="捨てています…"
            className="rounded-xl px-6 py-3 text-sm text-faint hover:text-muted"
          >
            このドラフトを捨てる
          </SubmitButton>
        </form>
      </div>

      <p className="text-xs text-faint">
        引き直すと選んだカードは白紙に戻り、1番目の枠からやり直しになります。
      </p>
    </div>
  );
}
