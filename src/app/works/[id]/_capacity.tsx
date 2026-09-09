import { SubmitButton } from "@/app/_pending";
import { btnPrimary, btnSecondary, noticeMuted, surface } from "@/app/_surface";
import {
  GRANT_SOURCE_LABEL,
  NOTICE_LABEL,
  remainingPercent,
  type WorkImportState,
} from "@/features/quiz/capacity";

import { importAnswersAction, setAutoImportAction } from "./actions";

/**
 * 取り込み枠の状態と履歴（作者だけ）。
 *
 * 【何のための面か】
 *   無料で見える結果は、回答が何件あっても全部で出る。
 *   区画を押して掘り下げるほうは、取り込んだ回答だけを相手にする。
 *   **その2つの母数が違うことを、ここで数字にして並べる。**
 *   「100件の結果」を「1023件の結果」と読み違えないようにするため。
 *
 * 【買う場所はまだ無い】
 *   決済業者も金額もパックの件数も決まっていない。だから購入のボタンは
 *   出していない。枠を増やせるのは運営の鍵を持っている側だけで、
 *   その入口は画面に無い。ここには、将来その導線が入る場所だけ空けてある。
 */

/** 日時を日本時間で「9月8日 16:47」の形にする */
function when(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** 母数の内訳。無料と高度分析で数が違うことを、そのまま並べる */
export function AnalysisScope({ state }: { state: WorkImportState }) {
  const rows: { label: string; value: number; note?: string }[] = [
    { label: "全回答", value: state.answers_total, note: "無料の集計はこの数で出ます" },
    { label: "取り込み済み", value: state.imported },
    { label: "未インポート", value: state.unimported },
    { label: "分析から外している", value: state.excluded },
    {
      label: "高度分析の対象",
      value: state.advanced,
      note: "区画を押しての掘り下げはこの数で出ます",
    },
  ];

  return (
    <dl
      className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3"
      data-analysis-scope
      data-answers-total={String(state.answers_total)}
      data-imported={String(state.imported)}
      data-unimported={String(state.unimported)}
      data-advanced={String(state.advanced)}
    >
      {rows.map((r) => (
        <div key={r.label}>
          <dt className="text-xs text-faint">{r.label}</dt>
          <dd className="text-base font-bold tabular-nums">{r.value}件</dd>
          {r.note ? <p className="text-xs text-faint">{r.note}</p> : null}
        </div>
      ))}
    </dl>
  );
}

export function CapacityPanel({
  workId,
  state,
}: {
  workId: string;
  state: WorkImportState;
}) {
  const percent = remainingPercent(state);

  return (
    <section className={`${surface} space-y-5`} data-capacity-panel>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">分析に使う回答の枠</h2>
        <p className="text-xs text-faint">
          回答は全部そのまま残っています。枠が要るのは、区画を押して
          「その人たちが何を選んだか」まで掘り下げるときだけです。
        </p>
      </div>

      <AnalysisScope state={state} />

      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-t border-ink/10 pt-4">
        <div data-remaining={String(state.remaining)}>
          <p className="text-xs text-faint">残りの枠</p>
          <p className="text-base font-bold tabular-nums">
            {state.remaining}件
            {percent === null ? "" : `（${percent}%）`}
          </p>
        </div>
        <div>
          <p className="text-xs text-faint">これまでに足した枠</p>
          <p className="text-base font-bold tabular-nums">{state.granted_total}件</p>
        </div>
      </div>

      {/* --- 自動で取り込むか ------------------------------------------- */}
      <form
        action={setAutoImportAction}
        className="space-y-2 border-t border-ink/10 pt-4"
      >
        <input type="hidden" name="workId" value={workId} />
        <input type="hidden" name="on" value={state.auto_import ? "off" : "on"} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold" data-auto-import={state.auto_import ? "1" : "0"}>
              新しい回答を自動で取り込む … {state.auto_import ? "入" : "切"}
            </p>
            <p className="text-xs text-faint">
              入にすると、いま溜まっている回答を古い順に取り込み、そのあとに来た
              回答も1件ずつ取り込みます。枠を使い切ると自動で切れます。
            </p>
          </div>
          <SubmitButton
            pendingLabel="切り替えています…"
            className={state.auto_import ? btnSecondary : btnPrimary}
            data={{ "data-toggle-auto": state.auto_import ? "off" : "on" }}
            disabled={!state.auto_import && state.remaining === 0}
          >
            {state.auto_import ? "自動をやめる" : "自動にする"}
          </SubmitButton>
        </div>

        {!state.auto_import && state.remaining === 0 ? (
          <p className="text-xs text-faint">
            枠が残っていないので、自動にはできません。
          </p>
        ) : null}
      </form>

      {/* --- 手で取り込む ----------------------------------------------- */}
      <form action={importAnswersAction} className="space-y-2 border-t border-ink/10 pt-4">
        <input type="hidden" name="workId" value={workId} />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold">残りの枠を使って、古い回答から取り込む</p>
            <p className="text-xs text-faint">
              これは購入ではありません。すでに持っている枠を使うだけです。
              取り込む順番は、答えた時刻の古い順に固定されています。
            </p>
          </div>
          <SubmitButton
            pendingLabel="取り込んでいます…"
            className={btnPrimary}
            data={{ "data-import-now": "1" }}
            disabled={state.remaining === 0 || state.unimported === 0}
          >
            取り込む
          </SubmitButton>
        </div>

        {state.unimported > 0 ? (
          <p className="text-xs text-faint" data-unimported-range>
            未インポートの回答は {state.unimported}件。いちばん古いものが{" "}
            {when(state.oldest_unimported_at)}、いちばん新しいものが{" "}
            {when(state.latest_unimported_at)} です。
            中身（何を選んだか）は、取り込むまで出しません。
          </p>
        ) : (
          <p className="text-xs text-faint">未インポートの回答はありません。</p>
        )}
      </form>

      {/* --- 枠を増やす場所（まだ無い）----------------------------------- */}
      <div className="border-t border-ink/10 pt-4" data-purchase-slot>
        <p className={noticeMuted}>
          枠を増やす方法は、まだ用意していません。金額も決まっていないので、
          購入の画面も出していません。用意できたら、ここに入口が出ます。
        </p>
      </div>

      {/* --- 履歴 --------------------------------------------------------- */}
      {state.grants.length > 0 ? (
        <div className="space-y-2 border-t border-ink/10 pt-4">
          <h3 className="text-xs text-faint">枠を足した記録</h3>
          <ul className="space-y-1 text-xs" data-grant-history>
            {state.grants.map((g) => (
              <li
                key={g.id}
                data-grant={String(g.id)}
                className="flex flex-wrap items-baseline justify-between gap-x-4"
              >
                <span>
                  {when(g.created_at)}
                  <span className="pl-2 text-faint">{GRANT_SOURCE_LABEL[g.source_type]}</span>
                </span>
                <span className="font-bold tabular-nums">+{g.quantity}件</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {state.notifications.length > 0 ? (
        <div className="space-y-2 border-t border-ink/10 pt-4">
          <h3 className="text-xs text-faint">残りが少なくなったときの知らせ</h3>
          <ul className="space-y-1 text-xs" data-capacity-notices>
            {state.notifications.map((n) => (
              <li
                key={`${n.epoch}-${n.kind}`}
                data-notice={n.kind}
                data-notice-epoch={String(n.epoch)}
                className="flex flex-wrap items-baseline justify-between gap-x-4"
              >
                <span>
                  {when(n.created_at)}
                  <span className="pl-2">{NOTICE_LABEL[n.kind]}</span>
                </span>
                <span className="text-faint tabular-nums">
                  残り {n.remaining} / {n.base}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-faint">
            この知らせは、いまのところこの画面にだけ出ます。
            メールで送る仕組みはまだありません。
          </p>
        </div>
      ) : null}
    </section>
  );
}
