import { NextResponse } from "next/server";
import {
  callDeletePushSubscription,
  callSavePushSubscription,
} from "@/features/notify/rpc";

/**
 * /api/push ／ ブラウザのプッシュの宛先を登録する・外す。
 *
 * 【ブラウザが持ってくる3つ】
 *   endpoint … その端末のブラウザ宛の住所（製造元のサーバー上）
 *   p256dh   … 中身を暗号化するための、その端末の公開鍵
 *   auth     … 同じく共有秘密
 *   3つとも**ブラウザが作る**。こちらは預かって、送るときに使うだけ。
 *
 * 【許可を勝手に求めない】
 *   ここは登録の受け口であって、許可を求める場所ではない。
 *   許可を求めるのは、利用者が説明を読んでボタンを押したときだけ（_push-optin.tsx）。
 */

export const dynamic = "force-dynamic";

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0, must-revalidate",
  Vary: "Cookie",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  const host = request.headers.get("host");
  try {
    const from = new URL(origin).host;
    if (host && from === host) return true;
    return from === new URL(request.url).host;
  } catch {
    return false;
  }
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: "この操作は受け付けられません。" }, 403);
  }

  let body: { endpoint?: unknown; p256dh?: unknown; auth?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "送られた内容を読めませんでした。" }, 400);
  }

  const endpoint = str(body.endpoint);
  const p256dh = str(body.p256dh);
  const auth = str(body.auth);

  if (endpoint === "" || p256dh === "" || auth === "") {
    return json({ error: "通知の宛先がそろっていません。" }, 400);
  }

  try {
    await callSavePushSubscription({
      endpoint,
      p256dh,
      auth,
      userAgent: request.headers.get("user-agent"),
    });
    return json({ saved: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: "この操作は受け付けられません。" }, 403);
  }

  let endpoint = "";
  try {
    endpoint = str(((await request.json()) as { endpoint?: unknown }).endpoint);
  } catch {
    return json({ error: "送られた内容を読めませんでした。" }, 400);
  }

  if (endpoint === "") return json({ error: "宛先がありません。" }, 400);

  try {
    await callDeletePushSubscription(endpoint);
    return json({ deleted: true });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}
