"use server";

import { headers } from "next/headers";

import { callCreateShare, recordShareEvent } from "@/features/share/rpc";
import { isCrawlerUserAgent } from "@/features/share/card";
import type { ShareChannel, ShareEventKey } from "@/features/share/types";

/**
 * 共有まわりのサーバー側の入口。
 *
 * 【どれも画面を動かさない】
 *   ここにある関数は、記録するだけで移動も再描画もしない。
 *   共有そのもの（X の投稿画面を開く・コピーする）はブラウザ側が
 *   押した操作の中で行う。**サーバーの返事を待たせない**のがこの形の要点で、
 *   待たせるとブラウザの共有機能とコピーが「操作の中ではない」と見なされて
 *   断られる（W3C Web Share の仕様が transient activation を要求する）。
 *
 * 【失敗しても共有を止めない】
 *   記録に失敗しても、利用者から見た共有はもう終わっている。
 *   ここで例外を投げると、成功した操作に失敗と出る。
 */

const CHANNELS: ShareChannel[] = ["x", "bluesky", "native", "copy"];

const EVENT_KEYS: ShareEventKey[] = [
  "share_modal_open",
  "share_question_select",
  "share_landing",
  "share_answer_submit",
  "share_result_view",
  "share_continue",
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanUuid(value: string | null | undefined): string | null {
  return typeof value === "string" && UUID.test(value) ? value : null;
}

function cleanQuestionId(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 共有を1件記録する。**実際に共有した瞬間にだけ呼ばれる**（利用者の指示 14）。
 *
 * shareId はブラウザが押した瞬間に作ったもの。ここでは形だけ確かめて渡す。
 * **この値で見えるものは1つも増えない**（利用者の指示 18）。
 * 公開されていない作品なら DB 側が断り、行すら作られない。
 */
export async function createShareAction(input: {
  workId: string;
  questionId: number | null;
  channel: string;
  shareId: string;
}): Promise<{ ok: boolean }> {
  const workId = cleanUuid(input.workId);
  const shareId = cleanUuid(input.shareId);
  const channel = CHANNELS.find((c) => c === input.channel) ?? null;

  if (!workId || !shareId || !channel) return { ok: false };

  try {
    await callCreateShare(workId, cleanQuestionId(input.questionId), channel, shareId);
    return { ok: true };
  } catch {
    // 共有そのものはブラウザ側でもう済んでいる。記録できなかっただけ
    return { ok: false };
  }
}

/**
 * 共有の道すじを1件記録する。
 *
 * 【クローラーを人の流入として数えない】（利用者の指示 34）
 *   この関数はブラウザで画面が描かれたあとに呼ばれるので、
 *   JavaScript を動かさないクローラーは**そもそも届かない。**
 *   それでも名乗りを見て弾くのは、網を2枚にするため。
 *   名乗りは詐称できるので、これは補助であって根拠ではない。
 */
export async function recordShareEventAction(input: {
  eventKey: string;
  workId?: string | null;
  questionId?: number | null;
  shareId?: string | null;
  channel?: string | null;
}): Promise<void> {
  const eventKey = EVENT_KEYS.find((k) => k === input.eventKey) ?? null;
  if (!eventKey) return;

  const ua = (await headers()).get("user-agent");
  if (isCrawlerUserAgent(ua)) return;

  await recordShareEvent(eventKey, {
    workId: cleanUuid(input.workId),
    questionId: cleanQuestionId(input.questionId),
    shareId: cleanUuid(input.shareId),
    channel: CHANNELS.find((c) => c === input.channel) ?? null,
  });
}
