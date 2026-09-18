import { ImageResponse } from "next/og";

import { fetchShareCard } from "@/features/share/rpc";
import { workImageUrl } from "@/features/work/rpc";
import {
  AI_BADGE_FONT_SIZE,
  AI_BADGE_TEXT,
  AUTHOR_FONT_SIZE,
  BRAND_FONT_SIZE,
  BRAND_TEXT,
  CARD_BG,
  CARD_HEIGHT,
  CARD_INK,
  CARD_INK_SOFT,
  CARD_PAD_BOTTOM,
  CARD_PAD_TOP,
  CARD_PAD_X,
  CARD_RADIUS,
  CARD_WIDTH,
  CTA_FONT_SIZE,
  QUESTION_FONT_SIZE,
  QUESTION_LINE_HEIGHT,
  QUESTION_SHADOW,
  QUESTION_STROKE,
  SCRIM_MAX_ALPHA,
  SCRIM_START_RATIO,
  SENSITIVE_VEIL_ALPHA,
  SOFT_SHADOW,
  UNAVAILABLE_TEXT,
  shareCardParts,
} from "@/features/share/card";

/**
 * /api/og/work/[id] ／ 共有カードの画像。**これが唯一の描き場所。**
 *
 * 【なぜ opengraph-image.tsx ではなく経路にしたか】
 *   Next.js のファイル規約（opengraph-image.tsx）は、受け取れるのが
 *   経路の切れ端（[id]）だけで、**クエリを読めない**
 *   （node_modules/next/dist/docs の 01-app/03-api-reference/
 *     03-file-conventions/01-metadata/opengraph-image.md の Props）。
 *   共有カードは「どの問いを載せるか」「どの共有の時点か」で中身が変わるので、
 *   クエリが読めないと作れない。同じ docs が
 *   「要求のたびに作る画像は Route Handler で」と書いている
 *   （ImageResponse の Route Handlers の節）。
 *
 * 【下見と本番が同じ1枚になる】
 *   共有モーダルの中の縮小表示も、SNS のクローラーも、ここを見る。
 *   下見のときは sid が付かないので、いまの中身で描かれる。
 *   共有したあとに SNS が取りに来るときは sid が付き、
 *   **共有した時点の中身**で描かれる（利用者の指示 27）。
 *
 * 【受け取るもの】
 *   q   … 共有する問いのID。無ければ問い無しのカード
 *   sid … 共有ID。付いていればその時点の控えを使う
 *
 * 【載せないもの】（利用者の指示 4）
 *   選択肢・正解・作者の意図・回答率・伝達率・回答数・結果の分布・
 *   作品タイトル・自動のハッシュタグ・押せそうに見える偽のボタン。
 *   **そもそもこの経路にそれらのデータが来ない。**get_share_card は
 *   正解の表にも集計の表にも触れないので、載せようがない。
 *
 * 【公開されていない作品】
 *   404 にせず、当たり障りのないカードを返す（既存の
 *   works/[id]/opengraph-image.tsx と同じ判断。SNS 側の表示が壊れるより
 *   「公開されていません」と書かれた絵が出るほうが分かりやすい）。
 */

const SIZE = { width: CARD_WIDTH, height: CARD_HEIGHT };

/**
 * どれだけキャッシュしてよいか。
 *
 * 【同じ控えなら使い回してよい。ただし永遠にしない】（利用者の指示 31）
 *   非公開・削除・匿名・センシティブへ変わったとき、**古い絵が
 *   取り消せないまま公開され続ける形にしない**と決めてある。
 *   だから「変わらない画像」として配らず、短い時間だけ預ける。
 *   預けたあとも、次に取りに来たときは必ずこの関数がいまの公開状態を
 *   読み直す（get_share_card が3条件を毎回見る）。
 *
 *   300秒＝5分。SNS 側が自分で持つキャッシュ（X は投稿から7日）は
 *   こちらから消せないので、それは指示 25 のとおり「消せないもの」として扱う。
 */
const CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=60";

function ogResponse(element: React.ReactElement) {
  return new ImageResponse(element, {
    ...SIZE,
    headers: { "cache-control": CACHE_CONTROL },
  });
}

/** 絵の外側の地。角の丸みもここで作る */
function frame(children: React.ReactNode) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: CARD_BG,
        borderRadius: CARD_RADIUS,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

/** 公開されていない作品・削除された作品のカード（利用者の指示 25） */
function unavailableCard() {
  return frame(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        justifyContent: "flex-end",
        padding: CARD_PAD_X,
      }}
    >
      <div
        style={{
          display: "flex",
          fontSize: QUESTION_FONT_SIZE,
          fontWeight: 700,
          color: CARD_INK,
        }}
      >
        {UNAVAILABLE_TEXT}
      </div>
      <div
        style={{
          display: "flex",
          fontSize: BRAND_FONT_SIZE,
          color: CARD_INK_SOFT,
          marginTop: 12,
        }}
      >
        {BRAND_TEXT}
      </div>
    </div>,
  );
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);

  const rawQuestion = url.searchParams.get("q");
  const questionId =
    rawQuestion !== null && /^\d{1,18}$/.test(rawQuestion) ? Number(rawQuestion) : null;

  const rawShare = url.searchParams.get("sid");
  const shareId =
    rawShare !== null &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawShare)
      ? rawShare
      : null;

  let card;
  try {
    card = await fetchShareCard(id, questionId, shareId);
  } catch {
    // DB が読めなかった。**中身を推測して出さない。**
    // 当たり障りのないカードに落とす
    return ogResponse(unavailableCard());
  }

  if (card.state !== "ok") return ogResponse(unavailableCard());

  // 【載せる・載せないの判断はここでしない】
  //   どの文字を出すか・作者欄を出すか・ぼかすか・どこを見せるかは、
  //   features/share/card.ts の shareCardParts が決める。
  //   絵にしないと確かめられない形で書くと目で見るしかなくなるので、
  //   判断だけを外へ出して、単体試験から呼べるようにしてある。
  const parts = shareCardParts(card);
  const { headline, lines, cta, authorLine, showAi, blurPx, objectPosition } = parts;
  const sensitive = blurPx > 0;

  return ogResponse(
    frame(
      <>
        {/* ── 1枚目：作品画像。カード全面の主役 ──
            next/image は使えない。ImageResponse は素の HTML と CSS の
            一部しか解釈しないので <img> で書く（既存の
            works/[id]/opengraph-image.tsx と同じ） */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={workImageUrl(card.image_path)}
          alt=""
          width={CARD_WIDTH}
          height={CARD_HEIGHT}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            objectFit: "cover",
            objectPosition,
            ...(blurPx > 0 ? { filter: `blur(${blurPx}px)` } : {}),
          }}
        />

        {/* ── 2枚目：暗くする帯。**黒い矩形を敷かない**（利用者の指示 2）──
            上はほぼ透明、下へ行くほど暗い。境目が線に見えないよう、
            文字領域（下25%）の倍の高さをかけて変える */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            display: "flex",
            backgroundImage:
              `linear-gradient(to bottom,` +
              ` rgba(0,0,0,0) ${Math.round(SCRIM_START_RATIO * 100)}%,` +
              ` rgba(0,0,0,${SCRIM_MAX_ALPHA * 0.45}) ${Math.round(
                (SCRIM_START_RATIO + (1 - SCRIM_START_RATIO) * 0.55) * 100,
              )}%,` +
              ` rgba(0,0,0,${SCRIM_MAX_ALPHA}) 100%)`,
          }}
        />

        {/* ぼかす作品にだけ重ねる暗幕（利用者の指示 7） */}
        {sensitive ? (
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: CARD_WIDTH,
              height: CARD_HEIGHT,
              display: "flex",
              background: `rgba(0,0,0,${SENSITIVE_VEIL_ALPHA})`,
            }}
          />
        ) : null}

        {/* ── 3枚目：文字。すべて左揃え（利用者の指示 3） ── */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            alignItems: "flex-start",
            paddingTop: CARD_PAD_TOP,
            paddingBottom: CARD_PAD_BOTTOM,
            paddingLeft: CARD_PAD_X,
            paddingRight: CARD_PAD_X,
          }}
        >
          {/* 左上：ブランド名。**問題文より大きくしない**（利用者の指示 3） */}
          <div style={{ display: "flex", alignItems: "center" }}>
            <div
              style={{
                display: "flex",
                fontSize: BRAND_FONT_SIZE,
                fontWeight: 700,
                color: CARD_INK_SOFT,
                textShadow: SOFT_SHADOW,
              }}
            >
              {BRAND_TEXT}
            </div>

            {/* AI生成の部門にだけ付く小さな札（利用者の指示 6）。
                既存の画面は「AI生成」という呼び名を使う（features/work/types.ts の
                DIVISIONS）。カードでは場所が狭いので短い「AI」にし、
                **別の意味に読めないよう枠で囲って札にする** */}
            {showAi ? (
              <div
                style={{
                  display: "flex",
                  marginLeft: 12,
                  paddingLeft: 10,
                  paddingRight: 10,
                  paddingTop: 2,
                  paddingBottom: 2,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.65)",
                  fontSize: AI_BADGE_FONT_SIZE,
                  fontWeight: 700,
                  color: CARD_INK,
                  textShadow: SOFT_SHADOW,
                }}
              >
                {AI_BADGE_TEXT}
              </div>
            ) : null}
          </div>

          {/* 下部：問題文 → CTA → 投稿者（利用者の指示 3 の順） */}
          <div style={{ display: "flex", flexDirection: "column", maxWidth: "100%" }}>
            {headline ? (
              <div
                style={{
                  display: "flex",
                  fontSize: QUESTION_FONT_SIZE,
                  fontWeight: 700,
                  lineHeight: QUESTION_LINE_HEIGHT,
                  color: CARD_INK,
                  textShadow: QUESTION_SHADOW,
                  WebkitTextStroke: QUESTION_STROKE,
                }}
              >
                {headline}
              </div>
            ) : null}

            {/* 問題文。**行の分け方はこちらで決める**（大きさを変えないため）。
                1行を1つの箱にして、描画側に折り返させない */}
            {lines.map((line, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  fontSize: QUESTION_FONT_SIZE,
                  fontWeight: 700,
                  lineHeight: QUESTION_LINE_HEIGHT,
                  color: CARD_INK,
                  textShadow: QUESTION_SHADOW,
                  WebkitTextStroke: QUESTION_STROKE,
                }}
              >
                {line}
              </div>
            ))}

            {/* 「タップして答える」。**押せるボタンに見せない**（利用者の指示 39）。
                枠も地も付けず、ただの文として置く */}
            <div
              style={{
                display: "flex",
                marginTop: 14,
                fontSize: CTA_FONT_SIZE,
                fontWeight: 700,
                color: CARD_INK,
                textShadow: SOFT_SHADOW,
              }}
            >
              {cta}
            </div>

            {/* 投稿者。表示名だけ。@handle は出さない（利用者の指示 3）。
                匿名の作品では**欄そのものを出さない**（利用者の指示 5）。
                「匿名」という代わりの表示も置かない */}
            {authorLine === null ? null : (
              <div
                style={{
                  display: "flex",
                  marginTop: 8,
                  fontSize: AUTHOR_FONT_SIZE,
                  color: CARD_INK_SOFT,
                  textShadow: SOFT_SHADOW,
                }}
              >
                {authorLine}
              </div>
            )}
          </div>
        </div>
      </>,
    ),
  );
}
