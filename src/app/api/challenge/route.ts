import { NextResponse } from "next/server";
import { fetchActiveChallenge, callRenewCurrentChallenge } from "@/features/challenge/rpc";

/**
 * /api/challenge ／ 全ページの上に出る帯が読む窓口。
 *
 * 【なぜ Server Component ではなくここなのか】
 *   帯は共通レイアウトに置く。レイアウトの中で Cookie を読むと、
 *   **すべてのページがリクエストごとの生成に変わる。**静的に配れていた
 *   トップや作品一覧まで、1人ぶんの状態を含む扱いになる。
 *   帯だけをブラウザ側から取りに行けば、ページの作り方は今までのままで、
 *   帯の中身は取った人のものだけになる。
 *
 * 【キャッシュに混ざらないこと】
 *   ・force-dynamic … 前もって作らない
 *   ・no-store, private … ブラウザにも中継にも残さない
 *   ・Vary: Cookie … 別の人の応答を使い回さない
 *   3つとも書く。1つでも欠けると、途中の中継が他人の帯を返しうる。
 *
 * 【返すもの】
 *   時刻と秒数と戻り先の URL だけ。お題の語は1文字も返さない
 *   （DB の get_active_challenge が正解に触れない形で作ってある）。
 *
 * 【POST は「時間を延ばす」】
 *   延ばす操作は、押した人のセッションでしか成立しない。
 *   Cookie は他のサイトからの POST にも付くので、
 *   **送り主が自分のサイトかどうかを Origin で見る。**
 *   Server Action には同じ検査が最初から入っているが、
 *   Route Handler には無いので自分で書く。
 */

export const dynamic = "force-dynamic";

/** 応答に必ず付ける。1か所にまとめて書き忘れを無くす */
const PRIVATE_HEADERS = {
  "Cache-Control": "no-store, private, max-age=0, must-revalidate",
  Vary: "Cookie",
};

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: PRIVATE_HEADERS });
}

export async function GET() {
  try {
    const challenge = await fetchActiveChallenge();
    return json({ challenge });
  } catch (e) {
    // 帯が読めないことで画面を壊さない。**「読めなかった」と分かる形で返す。**
    // null を返すと「挑戦が無い」と区別が付かず、時計が黙って消える。
    return json(
      { challenge: null, error: e instanceof Error ? e.message : String(e) },
      200,
    );
  }
}

/**
 * 送り主が自分のサイトかどうか。
 *
 * Origin が無いのは、ブラウザ以外からの呼び出し（curl など）。
 * その場合 Cookie も無いので DB 側で断られる。ここでは通す。
 *
 * 【比べる相手は Host ヘッダ】
 *   request.url は経路の途中で書き換わることがあり、
 *   ブラウザが送った Origin と host が食い違う。実測で、
 *   同じサイトからの送信が「受け付けられません」で全部落ちた。
 *   ブラウザが見ている宛先は Host ヘッダなので、そちらと比べる。
 */
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

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return json({ error: "この操作は受け付けられません。" }, 403);
  }

  try {
    const challenge = await callRenewCurrentChallenge();
    return json({ challenge });
  } catch (e) {
    // **成功したことにしない。**失敗の文言は DB 側が理由ごとに作る
    return json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}
