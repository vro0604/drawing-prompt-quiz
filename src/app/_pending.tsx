"use client";

import Link from "next/link";
import { useLinkStatus } from "next/link";
import { useState } from "react";
import { useFormStatus } from "react-dom";

/**
 * 押したことが分かるボタン（共通部品）。
 *
 * 【なぜ要るか】
 *   Server Action は押してから画面が変わるまでにサーバーの往復が入る。
 *   その間、既定では**画面が一切変わらない**。
 *   利用者は「押せていない」と判断して、もう一度押す。
 *
 *   本番で実際にそれが起きた。アカウント登録で2回目の送信が飛び、
 *   1回目で確定したパスワードと同じ値を送ったため
 *   Supabase が same_password を返した。
 *
 *   **押したことが見えないことが、二重送信の原因。**
 *   時間で抑える（debounce）のではなく、
 *   **送信中という状態そのもの**で塞ぐ。
 *
 * 【時間で抑えない理由】
 *   debounce は「速すぎる2回目」しか止められない。
 *   1.5秒後の2回目は通ってしまう。実際に観測されたのは
 *   **2.4秒あいた2回目**だった。
 *   状態で塞げば、終わるまで何秒でも塞がる。
 *
 * 【Enter とクリックが重なっても1回になる理由】
 *   どちらも同じ form の submit を通る。useFormStatus は
 *   その form の送信中を返すので、経路が違っても同じ錠が掛かる。
 */

/** 回っている印。大きさを固定して、出し入れで行がずれないようにする */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent align-[-2px]"
    />
  );
}

/**
 * 送信ボタン。form の中に置く。
 *
 * pendingLabel は「登録中…」のように、**何が進んでいるか**を書く。
 * 「処理中…」だと、どのボタンを押したのか分からなくなる。
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "",
  name,
  value,
  title,
  data,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  name?: string;
  value?: string;
  title?: string;
  /**
   * 検査の手がかり。`{ "data-card": "hidden" }` のように渡す。
   *
   * 【なぜ要るか】
   *   検査がボタンの**見た目**を手がかりにしていた。伏せカードの枚数を
   *   `>?</button>` の個数で数えていたので、「?」を絵柄に変えると
   *   検査が落ちる。**見た目を変えると検査が落ちる状態では、
   *   見た目を試せない。**
   *
   *   手がかりを属性に移すと、中身も見た目も自由に変えられる。
   */
  data?: Record<`data-${string}`, string>;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      name={name}
      value={value}
      title={title}
      {...data}
      // 送信中は押せない。失敗して画面が戻れば、部品が作り直されるので
      // pending は false に戻り、もう一度押せるようになる。
      disabled={pending}
      aria-busy={pending}
      className={[
        className,
        // 押し込みが分かる見た目。Safari は :hover が効かない場面があるので、
        // **:active を必ず付ける**（指で触ったことが分かるように）。
        "transition active:scale-[0.98] active:opacity-80",
        "disabled:cursor-progress disabled:opacity-60",
        "inline-flex items-center justify-center gap-2",
      ].join(" ")}
    >
      {pending ? (
        <>
          <Spinner />
          <span>{pendingLabel}</span>
        </>
      ) : (
        children
      )}
    </button>
  );
}

/** Link の中で遷移中かどうかを読む。Link の子孫でないと動かない */
function NavInner({
  children,
  pendingLabel,
  clicked,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  clicked: boolean;
}) {
  const { pending } = useLinkStatus();
  const busy = pending || clicked;

  return busy ? (
    <>
      <Spinner />
      <span>{pendingLabel}</span>
    </>
  ) : (
    <>{children}</>
  );
}

/**
 * 画面を移るボタン。
 *
 * 【Link に disabled は無い】
 *   `<a>` は disabled を持たない。押せなくするには
 *   pointer-events を切る。ここでは**押したことを表示しつつ**、
 *   同じ場所を連打しても2回目が届かないようにしている。
 *
 * 【useLinkStatus だけに頼らない理由】
 *   行き先が prefetch 済みだと pending が立たないまま遷移する。
 *   それ自体は速くて良いことだが、**遅いときだけ表示が出る**と
 *   動きが読めない。自前の clicked と両方見る。
 *
 * 【loading.tsx との関係】
 *   ページ側の loading.tsx が本命（JavaScript が動く前でも出る）。
 *   こちらは「押した瞬間、そのボタンの上で」反応を返す担当。
 */
export function NavButton({
  href,
  children,
  pendingLabel,
  className = "",
  prefetch,
}: {
  href: string;
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  prefetch?: boolean;
}) {
  const [clicked, setClicked] = useState(false);

  return (
    <Link
      href={href}
      prefetch={prefetch}
      onClick={() => setClicked(true)}
      aria-busy={clicked}
      className={[
        className,
        "transition active:scale-[0.98] active:opacity-80",
        "inline-flex items-center justify-center gap-2",
        clicked ? "pointer-events-none opacity-60" : "",
      ].join(" ")}
    >
      <NavInner pendingLabel={pendingLabel} clicked={clicked}>
        {children}
      </NavInner>
    </Link>
  );
}
