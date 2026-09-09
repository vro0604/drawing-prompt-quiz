import Link from "next/link";
import { fetchFounderList } from "@/features/billing/rpc";
import { founderLabel, founderRowText } from "@/features/billing/types";
import { surface } from "@/app/_surface";

/**
 * /founder/members ／ Founder 一覧。
 *
 * 【何を出して、何を出さないか】
 *   出すのは番号と、出してよい表示名だけ。
 *   金額・購入日時・決済の ID・利用者の ID は**この画面に届いていない**。
 *   DB の list_founders が、そもそも返さない。
 *
 * 【3つの見え方】
 *   #001 表示名   … 本人が「名前を出す」を選んでいる
 *   #002 匿名希望 … 本人が非公開のまま／退会して名前が引けない
 *   #003 欠番     … 返金・申し立てで取り消しになった
 *
 *   **匿名希望の人を一覧から消さない。**消すと番号が飛び、
 *   欠番と見分けが付かなくなる。番号と位置はそのまま残す。
 *
 * 【欠番と匿名希望を同じ言葉にしない】
 *   「匿名希望」は本人がそう選んだという事実、
 *   「欠番」はその枠がもう誰のものでもないという事実。別のことなので別に書く。
 */

export const metadata = {
  title: "Founder 一覧",
};

export default async function FounderMembersPage() {
  const rows = await fetchFounderList();

  return (
    <main className="mx-auto w-full max-w-2xl space-y-8 p-6 sm:p-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-bold">Founder 一覧</h1>
        <p className="text-sm text-faint">
          Founding Creator を購入してくださった方を、番号の順に並べています。
          名前を出すかどうかは、それぞれの方が選べます。
        </p>
      </header>

      {rows.length === 0 ? (
        <div className={surface}>
          <p className="text-sm">まだどなたも購入されていません。</p>
        </div>
      ) : (
        <ol className={`${surface} divide-y divide-line`}>
          {rows.map((row) => (
            <li
              key={row.founder_number}
              className="flex items-baseline gap-4 py-3 first:pt-0 last:pb-0"
            >
              <span className="w-16 shrink-0 font-mono text-sm font-bold">
                {founderLabel(row.founder_number)}
              </span>
              <span
                className={`text-sm ${row.kind === "public" ? "" : "text-faint"}`}
                data-founder-kind={row.kind}
              >
                {row.kind === "public" && row.handle ? (
                  <Link href={`/u/${row.handle}`} className="underline">
                    {founderRowText(row)}
                  </Link>
                ) : (
                  founderRowText(row)
                )}
              </span>
            </li>
          ))}
        </ol>
      )}

      <p className="text-sm">
        <Link href="/founder" className="underline">
          Founding Creator について
        </Link>
      </p>
    </main>
  );
}
