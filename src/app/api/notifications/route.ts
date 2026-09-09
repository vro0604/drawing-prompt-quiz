import { NextResponse } from "next/server";
import {
  callAcknowledgeNotification,
  fetchMyNotifications,
} from "@/features/notify/rpc";

/**
 * /api/notifications ／ 未確認の知らせを読む・確認する窓口。
 *
 * 【なぜ Server Component ではなくここなのか】
 *   知らせは全ページの上に出す。共通レイアウトの中で Cookie を読むと、
 *   **すべてのページがリクエストごとの生成に変わる**（帯と同じ理由）。
 *   ブラウザ側から取りに行けば、ページの作り方は今までのままで済む。
 *
 * 【キャッシュに混ざらないこと】
 *   force-dynamic ／ no-store, private ／ Vary: Cookie の3つを必ず書く。
 *   1つでも欠けると、途中の中継が他人の知らせを返しうる。
 *
 * 【POST は「確認しました」】
 *   Cookie は他のサイトからの POST にも付くので、送り主を Origin で見る。
 *   Route Handler には Server Action のような自動の検査が無い。
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

export async function GET() {
  const notifications = await fetchMyNotifications(20);
  return json({ notifications });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: "この操作は受け付けられません。" }, 403);
  }

  let id: unknown = null;
  try {
    id = ((await request.json()) as { id?: unknown }).id;
  } catch {
    return json({ error: "送られた内容を読めませんでした。" }, 400);
  }

  if (typeof id !== "number" || !Number.isInteger(id)) {
    return json({ error: "どの知らせかが分かりません。" }, 400);
  }

  try {
    const notifications = await callAcknowledgeNotification(id);
    return json({ notifications });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}
