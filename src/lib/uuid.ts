/**
 * URL から受け取った ID が UUID の形をしているか。
 *
 * 【なぜ要るか】
 *   `/works/{id}` の `{id}` は誰でも好きな文字を打てる。
 *   そのまま RPC へ渡すと、Postgres が
 *
 *     invalid input syntax for type uuid: "not-a-uuid"
 *
 *   を投げ、**画面が 500 になる。**URL を打ち間違えただけの人に
 *   「うまく表示できませんでした」と出るのは正しくない。
 *   欲しいのは「ページが見つかりません」。
 *
 * 【404 にそろえる理由】
 *   この工程は、他人の下書き・削除済みの作品・退会した人のページを
 *   すべて 404 にしている（D40）。**存在するIDとしないIDで
 *   応答を変えない**ためで、形が違うIDだけ 500 になると
 *   そこだけ扱いがずれる。
 *
 * 【形だけを見る】
 *   実在するかは見ない。それは RPC の仕事で、ここは
 *   「DB へ渡してよい形か」だけを判定する。
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): boolean {
  return typeof value === "string" && UUID.test(value);
}
