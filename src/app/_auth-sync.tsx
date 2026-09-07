"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * メールの確認が終わったことを、同じブラウザの他のタブへ伝える（D171）。
 *
 * 【なぜ要るか】
 *   登録はPCのタブで始め、確認のメールは別のタブ（または別の端末）で開く。
 *   確認そのものはサーバー側で終わるが、**最初のタブは何も知らない。**
 *   読み込み直すまで、ゲストのままの画面が出続ける。
 *
 * 【どう伝えるか】
 *   BroadcastChannel は、同じブラウザ・同じサイトのタブ同士だけに届く
 *   合図の道。挑戦の帯（_challenge-bar.tsx）が、時間を延ばしたことを
 *   他のタブへ伝えるのに既に使っている。**同じ作法をもう1つ増やすだけ。**
 *   道の名前は分けてある（帯は "challenge"、こちらは "dpq-auth"）。
 *
 * 【合図を信用しない】
 *   受け取ったタブがすることは「もう一度サーバーに聞き直す」ことだけ。
 *   **合図そのものを、認証が済んだ証拠として使わない。**
 *   誰がサインインしているかの判定は、今までどおりサーバー側にある。
 *   偽の合図が来ても、聞き直した結果が変わらないので何も起きない。
 *
 * 【別の端末で開いたとき】
 *   合図は届かない。届かないことを異常として扱わない。
 *   最初のタブはゲストのままで、画面には読み込み直す案内を出す。
 *   **勝手に「認証済み」とは表示しない。**
 */

/** 合図の道の名前。帯とは別にする */
const CHANNEL = "dpq-auth";

/** 送る合図。増やすときはここに足す */
const CONFIRMED = "confirmed";

/**
 * 確認が終わった画面に置く。開いた瞬間に1回だけ合図を送る。
 */
export function AuthConfirmedBeacon() {
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage(CONFIRMED);
    bc.close();
  }, []);

  return null;
}

/**
 * 全ページに置く。合図が来たらサーバーへ聞き直す。
 *
 * router.refresh() はサーバー側の描画をやり直すだけで、
 * 入力中の文字は消えない。
 */
export function AuthSyncWatcher() {
  const router = useRouter();

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = (e) => {
      if (e.data === CONFIRMED) router.refresh();
    };
    return () => bc.close();
  }, [router]);

  return null;
}
