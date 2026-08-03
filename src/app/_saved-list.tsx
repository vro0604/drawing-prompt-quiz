import Image from "next/image";
import Link from "next/link";
import { workImageUrl } from "@/features/work/rpc";
import { divisionLabel } from "@/features/work/types";
import {
  WORK_STATUS_LABELS,
  type SavedWork,
} from "@/features/profile/types";

/**
 * お気に入り一覧の見た目。/saves（自分用）と /u/[handle]（他人用）で共用する。
 *
 * 【お題の答えを出す条件】
 *   `prompt_answer` が入っているときだけ。入れるかどうかは **DB が決める**
 *   （その閲覧者がその作品へ回答済みか）。ここで判定しない。
 *   お気に入りに入れただけで答えが見えるなら、保存 → 一覧を開く の2手で
 *   クイズを迂回できてしまう（spec 12-1）。
 *
 * 【状態の表示】
 *   `showStatus` は自分の一覧でだけ true。作者が非公開にしたり削除したりした
 *   作品が黙って消えると、消したのか隠れたのか分からない。
 *   他人の一覧には公開中の作品しか来ないので、出しても意味が無い。
 *
 * 【いいねを出さない】
 *   お気に入りといいねは別の機能として扱う（spec 12-1）。
 *   DB 側もこの一覧のために likes を読んでいない。
 */

const statusTone: Record<string, string> = {
  public: "text-black/40 dark:text-white/40",
  private: "text-amber-700 dark:text-amber-300",
  review: "text-amber-700 dark:text-amber-300",
  deleted: "text-rose-700 dark:text-rose-300",
};

function SavedCard({ item, showStatus }: { item: SavedWork; showStatus: boolean }) {
  const savedAt = new Date(item.saved_at).toLocaleDateString("ja-JP");
  const gone = item.work_status === "deleted";

  const body = (
    <>
      <div className="h-20 w-20 shrink-0 overflow-hidden rounded-xl bg-black/[0.03] dark:bg-white/5">
        <Image
          src={workImageUrl(item.image_path)}
          alt={item.title}
          width={item.image_width}
          height={item.image_height}
          className="h-20 w-20 object-cover"
          sizes="80px"
        />
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-bold">{item.title}</p>
        <p className="truncate text-xs text-black/50 dark:text-white/50">
          {item.author_display_name}
          {item.author_handle ? `（@${item.author_handle}）` : ""}
        </p>
        <p className="text-xs text-black/40 dark:text-white/40">
          {divisionLabel(item.division)}・保存 {savedAt}
          {showStatus ? (
            <span className={statusTone[item.work_status] ?? statusTone.public}>
              ・{WORK_STATUS_LABELS[item.work_status]}
            </span>
          ) : null}
        </p>
      </div>
    </>
  );

  return (
    <li className="space-y-2 border-b border-black/10 py-4 last:border-b-0 dark:border-white/10">
      {gone ? (
        <div className="flex items-start gap-4 opacity-60">{body}</div>
      ) : (
        <Link
          href={`/works/${item.work_id}`}
          className="flex items-start gap-4 hover:opacity-80"
        >
          {body}
        </Link>
      )}

      {/* 回答済みの人にだけ、DB がお題の答えを入れてくる */}
      {item.prompt_answer ? (
        <div className="ml-24 flex flex-wrap gap-x-4 gap-y-1 text-xs text-black/50 dark:text-white/50">
          <span className="text-black/35 dark:text-white/35">お題</span>
          {item.prompt_answer.map((card) => (
            <span key={card.card_slot_key}>
              {card.slot_label}: <strong className="font-bold">{card.tag_label}</strong>
            </span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

export function SavedList({
  items,
  showStatus,
  emptyMessage,
}: {
  items: SavedWork[];
  showStatus: boolean;
  emptyMessage: string;
}) {
  if (items.length === 0) {
    return <p className="text-sm text-black/55 dark:text-white/55">{emptyMessage}</p>;
  }

  return (
    <ul>
      {items.map((item) => (
        <SavedCard key={item.work_id} item={item} showStatus={showStatus} />
      ))}
    </ul>
  );
}
