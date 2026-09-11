/**
 * _test-accounts.mjs ／ 検査用の利用者かどうかを見分ける、ただ1つの場所
 *
 * 【なぜ1か所にするか】
 *   見分けかたが3か所に分かれていた（_smoke-users.mjs の isFixtureEmail、
 *   cleanup-testdata.mjs の isTestUser、手で書いた SQL の条件）。
 *   しかも中身が違った。isFixtureEmail は dpq-fixture しか見ず、
 *   isTestUser は「dpq-smoke- で始まる」だけでドメインを見ていなかった。
 *   その結果、2026-08 に作られた dpq-smoke 328人と dpq-probe 2人は、
 *   片づけの道具のどれにも拾われないまま本番に残っていた（2026-09-11 に監査して削除）。
 *
 * 【3つの形と、ドメインの意味の違い】
 *   fixture … dpq-fixture-<役割>@dpq-smoke.invalid
 *             今のスモークが使い回す固定の利用者（_smoke-users.mjs）。
 *             `.invalid` は RFC 2606 で「決して実在しない」と決まっている
 *             トップレベルドメイン。**名前だけで検査用だと保証できる。**
 *   smoke   … dpq-smoke-<ラベル>-<pid>-<乱数>@example.com
 *             スモークが1回ごとに作る使い捨て（_smoke-http.mjs の newCredentials）。
 *   probe   … dpq-probe-<数字>@example.com
 *             2026-08-03 に手で作った確認用。作ったスクリプトは git に無い。
 *
 *   `example.com` は RFC 2606 で**例示用に予約された実在のドメイン**で、
 *   `.invalid` と違って「存在しない」わけではない。メールは届かないが、
 *   例示用なので、人が試しに打ち込むことはありうる（someone@example.com など）。
 *   だから example.com は**ドメインだけでは検査用と見なさない。**
 *   dpq-smoke- / dpq-probe- の接頭辞と、決まった形の両方が揃ったときだけ当てる。
 *
 * 【大文字】
 *   Supabase はメールを小文字にして保存する（fanA → fana）。
 *   念のため大文字小文字を区別しないで比べる。
 */

const PATTERNS = [
  { kind: "fixture", re: /^dpq-fixture-[a-z0-9-]+@dpq-smoke\.invalid$/i },
  { kind: "smoke", re: /^dpq-smoke-[a-z0-9-]+-\d+-\d+@example\.com$/i },
  { kind: "probe", re: /^dpq-probe-\d+@example\.com$/i },
];

/** 検査用なら "fixture" / "smoke" / "probe"、そうでなければ null */
export function testAccountKind(email) {
  if (typeof email !== "string") return null;
  for (const { kind, re } of PATTERNS) if (re.test(email)) return kind;
  return null;
}

/** 検査用の利用者かどうか。**消す前に必ず通す** */
export function isTestAccountEmail(email) {
  return testAccountKind(email) !== null;
}

/** 固定の検査用利用者（dpq-fixture）かどうか。使い回す人を探すときに使う */
export function isFixtureAccountEmail(email) {
  return testAccountKind(email) === "fixture";
}

/**
 * 内訳を数えるための短い名前。メールそのものは出さない。
 * 例: dpq-smoke-artist-123-456@example.com → "smoke:artist"
 */
export function testAccountLabel(email) {
  const kind = testAccountKind(email);
  if (!kind) return null;
  const local = email.toLowerCase().split("@")[0];
  if (kind === "fixture") return `fixture:${local.slice("dpq-fixture-".length)}`;
  if (kind === "smoke") return `smoke:${local.slice("dpq-smoke-".length).replace(/-\d+-\d+$/, "").replace(/\d+$/, "")}`;
  return "probe";
}
