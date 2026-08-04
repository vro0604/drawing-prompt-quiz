import { NextResponse, type NextRequest } from "next/server";
import { runCleanup } from "@/features/cleanup/run";

/**
 * /api/cron/cleanup ／ 定期的な掃除の入口（Step 16）。
 *
 * Vercel Cron が1日1回 GET で叩く。vercel.json に時刻を書いてある。
 *
 * 【誰が叩けるか】
 *   **CRON_SECRET を知っている人だけ。**
 *   この経路は Secret key で動く（RLS を迂回する）ので、
 *   誰でも叩けると「掃除」を装ってデータを消させられる。
 *
 *   Vercel Cron は Authorization: Bearer $CRON_SECRET を付けて呼ぶ。
 *
 * 【CRON_SECRET が未設定のとき】
 *   **通さない。**「設定していないから素通し」にすると、
 *   設定し忘れたまま公開したときに誰でも叩けてしまう。
 *   開発中に手で試したいときは .env.local に書く。
 *
 * 【失敗しても 200 を返す場合がある】
 *   job が1つ失敗しても、ほかが片づいていれば掃除は前に進んでいる。
 *   全部失敗したときだけ 500 にする。Cron が「毎回失敗」と報せてくるのは、
 *   本当に止まっているときだけにしたい。
 */

export const dynamic = "force-dynamic";

/** 比較にかかる時間から鍵を推測されないようにする */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET ?? "";

  if (secret.trim() === "") {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET が未設定です" },
      { status: 503 },
    );
  }

  const given = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  if (!safeEqual(given, expected)) {
    // 何が違うかは返さない
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const result = await runCleanup();

  // 何も片づかず、しかも全部失敗しているときだけ 500
  const nothingDone = Object.values(result.jobs).every(
    (v) => typeof v === "string" || v === 0,
  );
  const allFailed = result.errors.length > 0 && nothingDone;

  return NextResponse.json(result, { status: allFailed ? 500 : 200 });
}
