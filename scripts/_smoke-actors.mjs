/**
 * _smoke-actors.mjs ／ この実行が作った「人」を、ID で名指しして消す
 *
 * 【なぜ要るか】
 *   本番のスモークは、登録者を Admin API で自分から作るので ID が手元にある。
 *   ゲストは違う。回答を送った瞬間にサーバー側の ensureUserId() が
 *   匿名サインインを起こすので（src/features/auth/session.ts）、
 *   **スモークは自分が誰を作ったのかを一度も知らないまま終わっていた。**
 *
 *   既存の片づけはメールアドレスの形で検査用を見分ける（_test-accounts.mjs）。
 *   匿名ゲストはメールを持たないので、どの条件にも当たらない。
 *   掃除 Cron（list_stale_guests）は拾うが、条件が「作られてから30日以上」なので、
 *   30日間はそのまま本番に残る。
 *
 *   実害: 2026-09-17 の journey スモーク2回で匿名ゲストが2人残り、
 *   本番の利用者数と初回利用ファネル（D209）の 24時間・7日・30日に混ざった。
 *
 * 【どう直すか】
 *   ゲストの ID を、作られたその場で**2つの独立した経路**から拾う。
 *     経路1 … ブラウザの入れ物に残るセッション Cookie（sb-…-auth-token）を
 *              復号し、中の access_token に入っている sub（＝利用者 ID）を読む
 *     経路2 … **この実行が作った作品**への回答行の user_id を読む
 *   どちらも「この実行が作った物」しか見ていない。
 *   時刻・件数・行動の形から後で当てる方式は使わない（実利用者を巻き込むため）。
 *
 * 【消す側の性質】
 *   ・同じ ID を2回消しても安全（2回目は「すでに居ない」として合格にする）
 *   ・消せなかったら理由を返す。**握りつぶさない**
 *   ・通常の出力に生の ID を出さない（先頭8文字だけ）
 */

/** セッションの Cookie 名。長いと .0 .1 … に割られる */
const AUTH_COOKIE = /^sb-[a-z0-9]+-auth-token(?:\.(\d+))?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 生の ID を出さないための短縮。照合には使わない */
export function maskId(id) {
  return typeof id === "string" && id.length >= 8 ? `${id.slice(0, 8)}…` : "（不明）";
}

function decodeBase64Url(part) {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64").toString("utf8");
}

function safeDecodeUri(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Cookie の中身を、いまの入れかた2通りのどちらでも読む */
function parseSession(value) {
  let raw = value;
  // @supabase/ssr は中身を base64 にして "base64-" を付ける版と、そのまま入れる版がある
  if (raw.startsWith("base64-")) {
    try {
      raw = decodeBase64Url(raw.slice("base64-".length));
    } catch {
      return null;
    }
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.access_token === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ブラウザの入れ物にある Cookie から、いま誰としてアクセスしているかを読む。
 *
 * @param cookies Playwright の context.cookies() が返す配列
 * @returns { id, isAnonymous } ／ 読めなければ null
 */
export function actorFromCookies(cookies) {
  const chunks = [];
  for (const c of cookies ?? []) {
    const m = AUTH_COOKIE.exec(c?.name ?? "");
    if (!m) continue;
    chunks.push({ index: m[1] === undefined ? 0 : Number(m[1]), value: c.value ?? "" });
  }
  if (chunks.length === 0) return null;

  chunks.sort((a, b) => a.index - b.index);
  const joined = chunks.map((c) => c.value).join("");

  // 生のまま読めなければ、URL 符号化を外して読み直す。
  // ブラウザ越しに取ると復号済みだが、Set-Cookie をそのまま溜める入れ物では
  // %7B のような形で入っている（scripts/_smoke-http.mjs の session）
  let session = null;
  for (const candidate of [joined, safeDecodeUri(joined)]) {
    session = parseSession(candidate);
    if (session) break;
  }
  if (!session) return null;

  const token = session?.access_token;
  if (typeof token !== "string") return null;

  const body = token.split(".")[1];
  if (!body) return null;

  let claims;
  try {
    claims = JSON.parse(decodeBase64Url(body));
  } catch {
    return null;
  }

  const id = claims?.sub;
  if (typeof id !== "string" || !UUID.test(id)) return null;

  return { id, isAnonymous: Boolean(claims?.is_anonymous) };
}

/**
 * この実行が作った人の帳面。
 *
 * add() に渡せるのは「作ったその場で分かった ID」だけ。
 * 一覧や時刻から拾った ID を入れないこと（入れたらこの仕組みの意味が消える）。
 */
export function createActorLedger() {
  const byId = new Map();
  return {
    /** @param how どこで ID を知ったか。報告に出す */
    add(id, { role = "不明", anonymous = false, how = "" } = {}) {
      if (typeof id !== "string" || !UUID.test(id)) return false;
      const known = byId.get(id);
      if (known) {
        if (how && !known.how.includes(how)) known.how += `+${how}`;
        return false;
      }
      byId.set(id, { id, role, anonymous, how });
      return true;
    },
    has(id) {
      return byId.has(id);
    },
    list() {
      return [...byId.values()];
    },
    get size() {
      return byId.size;
    },
  };
}

/** すでに居ない相手を指したときの言い回し。どれも「終わっている」と見なす */
const ALREADY_GONE = /not.?found|does not exist|user_not_found|no rows/i;

/**
 * 帳面の人を消す。**1人失敗しても残りは続ける**（どこまで消えたかを全部見せるため）。
 *
 * @param actors createActorLedger().list() の結果
 * @param remove (id) => { error: 理由か null } を返す関数
 */
export async function cleanupActors(actors, remove) {
  const report = [];
  for (const a of actors) {
    let error = null;
    try {
      const out = await remove(a.id);
      error = out?.error ?? null;
    } catch (e) {
      error = e?.message ?? String(e);
    }
    const gone = error !== null && ALREADY_GONE.test(String(error));
    report.push({
      id: a.id,
      role: a.role,
      anonymous: a.anonymous,
      how: a.how,
      gone,
      error: gone ? null : error,
      ok: error === null || gone,
    });
  }
  return report;
}

/** 1人ぶんの結果を1行にする。生の ID は出さない */
export function describeActor(r) {
  const head = `${r.role}${r.anonymous ? "（ゲスト）" : ""} ${maskId(r.id)}`;
  if (r.ok && r.gone) return `${head}: すでに居ませんでした（合格）`;
  if (r.ok) return `${head}: 消しました${r.how ? `（見つけかた: ${r.how}）` : ""}`;
  return `${head}: 消せませんでした ／ 理由: ${r.error}`;
}

/** 消し残しが1人でもあるか */
export function cleanupFailed(report) {
  return report.some((r) => !r.ok);
}

/** service_role の Supabase クライアントで消す remove */
export function supabaseActorRemover(client) {
  return async (id) => {
    const { error } = await client.auth.admin.deleteUser(id);
    return { error: error ? error.message : null };
  };
}
