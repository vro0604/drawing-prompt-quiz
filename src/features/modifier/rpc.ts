import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { SUB_DIRECTIVE_KEY_PATTERN } from "@/features/modifier/types";

/**
 * サブ指令（D193）を書き込む、ただ1つの経路。サーバー専用。
 *
 * 【なぜ普通の呼び出しではないのか】
 *   ふだんの DB 呼び出しは、その人のサインインの証明書を持って行う。
 *   ところがその証明書はブラウザから読み取れる（部品の既定が httpOnly: false）。
 *   だからサブ指令の鍵を普通の窓口の引数に置くと、画面を通さず直接叩いて
 *   好きな鍵を自分のドラフトへ書けてしまう。実際にその形になっていた。
 *   出所: ユーザー指示（2026-09-10）「sub_directive_key を authenticated利用者が
 *   呼べるRPCの引数に置かない。」
 *
 *   ここではサーバーだけが持つ秘密の鍵で書く。**その鍵はブラウザへ渡らない。**
 *   だから、捏造した鍵を持ち込む口がそもそも無い。
 *
 * 【秘密の鍵は守りを素通りする】
 *   だから相手の DB 関数の側で、誰の・どのドラフトの・どの世代の・どの枠の・
 *   どの語かを5つとも突き合わせている。1つでも食い違えば1行も書かれない。
 *
 * 【失敗しても、お題は成立させる】
 *   カードを決めるのとサブ指令を書くのは2つの操作になる。後半だけ失敗しても
 *   正式なお題は正しく決まっており、サブ指令が付かないだけ。
 *   出所: ユーザー指示（2026-09-10）「正式カードまで失敗扱いにしない。
 *   ただし失敗を握り潰して原因不明にせず、サーバーログ等で検出できる形を維持する。」
 */

export type SubDirectiveWrite = {
  userId: string;
  sessionId: string;
  /** 決めたときの世代。引き直しが割り込むとここが食い違い、書かれない */
  generation: number;
  cardSlotKey: string;
  /** 決めたときにその枠に入っていた正式な語。食い違えば書かれない */
  tagId: number;
  key: string;
};

/**
 * 書けたら true。書かなかった／書けなかったときは false。
 *
 * **投げない。**呼ぶ側はカードを決め終えた後なので、
 * ここで投げるとお題が成立したのに画面が失敗表示になる。
 */
export async function writeSubDirective(w: SubDirectiveWrite): Promise<boolean> {
  // 形の確認はここでも行う。ここを通らない値は DB へ届かない
  if (!SUB_DIRECTIVE_KEY_PATTERN.test(w.key)) {
    console.error("[sub-directive] 形が合わない鍵を渡そうとしました", { key: w.key });
    return false;
  }

  const admin = createSupabaseAdminClient();
  if (admin === null) {
    // 秘密の鍵が設定されていない環境。お題は普通に成立し、サブ指令だけ付かない
    console.warn("[sub-directive] サーバーの鍵が無いので書きませんでした");
    return false;
  }

  const { data, error } = await admin.rpc("set_draft_slot_sub_directive", {
    p_user_id: w.userId,
    p_session_id: w.sessionId,
    p_generation: w.generation,
    p_card_slot_key: w.cardSlotKey,
    p_tag_id: w.tagId,
    p_sub_directive_key: w.key,
  });

  if (error) {
    // 握り潰さない。原因を追えるように残す
    console.error("[sub-directive] 書き込みに失敗しました", {
      sessionId: w.sessionId,
      cardSlotKey: w.cardSlotKey,
      message: error.message,
    });
    return false;
  }

  if (data !== true) {
    // 引き直しが割り込んだ、または同じ枠が既に埋まっていた。**異常ではない**
    console.info("[sub-directive] 状態が変わっていたので書きませんでした", {
      sessionId: w.sessionId,
      cardSlotKey: w.cardSlotKey,
    });
    return false;
  }

  return true;
}
