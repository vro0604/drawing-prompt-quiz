import { ImageResponse } from "next/og";
import { fetchHandleRedirect, fetchPublicProfile } from "@/features/profile/rpc";
import { isCreatorHidden, ratioPercent } from "@/features/profile/types";

/**
 * /u/[handle]/opengraph-image ／ プロフィールの共有カード。
 *
 * 【旧ID を残さない】（P5）
 *   旧ID で来たときは、いまの ID のプロフィールを引き直して描く。
 *   カードに出るのは**いまの ID だけ**。ページ側も301で移すので、
 *   旧ID は URL のやり取りにしか現れない。
 *
 * 【常に公開してよい情報しか出さない】
 *   表示名・ID・自己紹介・描き手としての記録だけ。
 *   お気に入りや回答履歴は公開設定に従うもので、カードには出さない
 *   （クローラーには「誰が見ているか」が無く、設定の判断ができないため）。
 */

export const alt = "プロフィール";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const BG = "#0b0b0d";
const FG = "#f5f5f5";
const MUTED = "#9b9ba3";

export default async function Image({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  let profile = await fetchPublicProfile(handle);

  // 旧ID で来たら、いまの ID で引き直す（カードに旧ID を残さない）
  if (!profile) {
    const current = await fetchHandleRedirect(handle);
    if (current) profile = await fetchPublicProfile(current);
  }

  if (!profile) {
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
          このプロフィールは見つかりません
        </div>
      ),
      size,
    );
  }

  // 共有カードは**誰にでも見える**ので、伏せられている記録は載せない（D136）。
  // ここが本人かどうかを見ないのは、カードを開くのは常に他人だから。
  const creator = profile.creator;
  const open = isCreatorHidden(creator) ? null : creator;
  const accuracy = open ? ratioPercent(open.accuracy) : null;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          background: BG,
          color: FG,
          padding: 80,
        }}
      >
        <div style={{ display: "flex", fontSize: 64, fontWeight: 700 }}>
          {profile.display_name.length > 20
            ? `${profile.display_name.slice(0, 20)}…`
            : profile.display_name}
        </div>

        <div style={{ display: "flex", fontSize: 32, color: MUTED, marginTop: 12 }}>
          @{profile.handle}
        </div>

        {profile.bio ? (
          <div style={{ display: "flex", fontSize: 28, color: MUTED, marginTop: 28 }}>
            {profile.bio.length > 60 ? `${profile.bio.slice(0, 60)}…` : profile.bio}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 56, marginTop: "auto" }}>
          {[
            { label: "投稿", value: `${creator.works_count}` },
            ...(open
              ? [
                  { label: "獲得いいね", value: `${open.likes_received}` },
                  {
                    label: "伝わりやすさ",
                    value: accuracy === null ? "—" : `${accuracy}%`,
                  },
                ]
              : []),
          ].map((item) => (
            <div key={item.label} style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ display: "flex", fontSize: 24, color: MUTED }}>
                {item.label}
              </div>
              <div style={{ display: "flex", fontSize: 48, fontWeight: 700 }}>
                {item.value}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
