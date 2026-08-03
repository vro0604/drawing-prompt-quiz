import { ImageResponse } from "next/og";
import { fetchWorkDetail, workImageUrl } from "@/features/work/rpc";
import { divisionLabel } from "@/features/work/types";

/**
 * /works/[id]/opengraph-image ／ 作品の共有カード。
 *
 * 【お題の答えを一切載せない】
 *   共有カードを取りに来るのは SNS のクローラーで、そこに
 *   「誰がログインしているか」という概念が無い。作品ページのように
 *   「回答済みの人にだけ答えを出す」判断ができないので、**答えは載せない**。
 *
 *   そもそもこの経路に答えは届かない（get_work_detail は prompt_id も
 *   正解も返さない。D23）ので、うっかり載せようがない作りになっている。
 *
 * 【公開されている作品しかカードを作らない】
 *   get_work_detail は「公開中・審査OK・未削除」のときだけ値を返す。
 *   下書き・削除済みのときは null になるので、その場合は
 *   **タイトルも画像も出さない**当たり障りのないカードにする。
 *
 *   404 を返さないのは、SNS 側の表示が壊れるより、
 *   「見つかりません」と書かれたカードが出るほうが分かりやすいため。
 *
 * 【画像の埋め込み】
 *   Storage の公開URLをそのまま <img> で参照する。バケットが public
 *   なので署名は要らない。
 */

export const alt = "作品";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0b0b0d";
const FG = "#f5f5f5";
const MUTED = "#9b9ba3";

export default async function Image({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const work = await fetchWorkDetail(id);

  if (!work) {
    return new ImageResponse(
      (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: BG,
            color: MUTED,
            fontSize: 48,
          }}
        >
          この作品は見つかりません
        </div>
      ),
      size,
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          background: BG,
          color: FG,
        }}
      >
        {/* 左：作品画像 */}
        <div
          style={{
            width: 630,
            height: 630,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            background: "#17171b",
          }}
        >
          {/* next/image は使えない。ImageResponse は素の HTML と CSS の
              一部しか解釈しないため、ここは <img> で書く */}
          <img
            src={workImageUrl(work.image_path)}
            alt=""
            width={630}
            height={630}
            style={{ width: 630, height: 630, objectFit: "cover" }}
          />
        </div>

        {/* 右：タイトルと投稿者。**お題は出さない** */}
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: 56,
          }}
        >
          <div style={{ display: "flex", fontSize: 24, color: MUTED }}>
            {divisionLabel(work.division)}
          </div>

          <div
            style={{
              display: "flex",
              fontSize: 56,
              fontWeight: 700,
              lineHeight: 1.25,
              marginTop: 16,
            }}
          >
            {work.title.length > 40 ? `${work.title.slice(0, 40)}…` : work.title}
          </div>

          <div style={{ display: "flex", fontSize: 28, color: MUTED, marginTop: 20 }}>
            {work.author.display_name}
          </div>

          <div style={{ display: "flex", fontSize: 26, color: MUTED, marginTop: "auto" }}>
            この絵のお題を当ててみてください
          </div>
        </div>
      </div>
    ),
    size,
  );
}
