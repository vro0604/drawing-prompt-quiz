import { SUPABASE_URL } from "@/lib/env";
import { WORKS_BUCKET } from "@/features/work/types";

/**
 * プロフィールアイコンの置き場所とURL。
 *
 * 【なぜ作品と同じバケットに置くか】
 *   works バケットには、いま次の守りが付いている（2026-09-08 に実測）。
 *     ・書き込みのポリシーが「先頭のフォルダ名 = 自分の利用者ID」を見る
 *     ・読み取りは公開。受け付ける形式は png / jpeg / webp、上限 5MiB
 *     ・退会の第1段階が「<利用者ID>/ で始まるもの」を控えて消す
 *   別のバケットを作ると、この4つを書き直すことになる。置き場所を
 *   <利用者ID>/avatar/... にすれば、どれもそのまま効く。
 *
 * 【原寸をそのまま画面に出さない】
 *   出所: ユーザー指示（2026-09-08）「巨大な原寸画像をそのまま
 *   プロフィールUIで常時配信する設計にはしない」。
 *   2つで守る。
 *     ・受け取る大きさを 2MiB までにする（作品の 5MiB より小さい）
 *     ・画面は next/image に幅と高さを渡して出す。**配信されるのは
 *       その大きさに縮めたものになる**（原寸のURLを直接 <img> に渡さない）
 */

/**
 * アイコンとして受け取る上限。
 *
 * 出所: ユーザー承認（2026-09-09）「アイコン2MiBは暫定ではなく正式仕様として承認する」。
 *
 * バケット自体の上限は 5MiB のままでよい（作品画像と同じ置き場のため）。
 * **2MiB を断るのは画面だけの仕事にしない。**受け口（Server Action）が
 * 中身の大きさを見て断る。
 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;

/** 画面に出す一辺の大きさ（px）。1:1 で出す */
export const AVATAR_DISPLAY_SIZE = 96;

/** 公開URL。バケットが公開なので署名は要らない（作品画像と同じ） */
export function avatarUrl(path: string): string {
  return `${SUPABASE_URL}/storage/v1/object/public/${WORKS_BUCKET}/${path}`;
}

/**
 * 置き場所を組み立てる。`<利用者ID>/avatar/<乱数>.<拡張子>`。
 *
 * 差し替えるたびに新しい名前にする。**同じ名前に上書きしない。**
 * 上書きすると、配信の途中の控え（CDN）に古い画像が残り、
 * 差し替えたのに変わらない状態になる。
 */
export function avatarStoragePath(userId: string, ext: string): string {
  return `${userId}/avatar/${crypto.randomUUID()}.${ext}`;
}

/** アイコンが無い人に出す1文字。表示名の先頭を使う */
export function avatarInitial(displayName: string): string {
  const trimmed = displayName.trim();
  return trimmed === "" ? "?" : Array.from(trimmed)[0];
}
