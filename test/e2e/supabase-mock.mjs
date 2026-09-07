/**
 * supabase-mock.mjs ／ 本番に触れずにアプリを起動するための、Supabase の代わり
 *
 * 【なぜ要るか】
 *   画面を実際に開いて確かめるには、動いているアプリが要る。
 *   アプリは Supabase（認証・API・保管庫）に繋がって初めて動く。
 *   この端末で使える Supabase は本番だけで、そこへ書き込む許可は無い。
 *   Docker が無いので `supabase start`（手元に本物一式を立てる）も使えない
 *   （実測: `docker` が command not found）。
 *
 *   そこで、**DB は本物の Postgres（PGlite）を使い、その手前の API だけを
 *   自分で書く。**判定・権限・RLS はすべて DB 側にあるので、
 *   ここが薄くても検査の意味は変わらない。
 *
 * 【本物と違うところ（先に書いておく）】
 *   ・トークンの署名を検証しない。ここは「誰であるか」を運ぶだけの入れ物で、
 *     本物は署名を検証する。**認証の強さを試す道具ではない。**
 *   ・メールの送信、パスワードの強度、回数制限は無い。
 *   ・保管庫は実体を持たず、置いた記録だけを覚える。読み出すと1×1の画像を返す。
 *   ・PostgREST の機能はごく一部（select / order / limit / eq）だけ。
 *     アプリが実際に使っている呼び出しに合わせてある。
 *
 * 【使い方】
 *   const mock = await startSupabaseMock();
 *   → mock.url（http://127.0.0.1:ポート）を NEXT_PUBLIC_SUPABASE_URL に渡す
 */

import { createServer } from "node:http";
import { createHmac, randomUUID } from "node:crypto";
import { createTestDb, asRole } from "../db/harness.mjs";

/** 1×1 の透明 PNG。作品画像の代わりに返す */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** 署名の鍵。**本物ではない。**中身を運ぶためだけに形をそろえる */
const FAKE_SECRET = "mock-secret-not-a-real-key";

/** 誰でも使える鍵（本物の publishable key の位置） */
export const ANON_KEY = "mock-anon-key";
/** 管理用の鍵（本物の secret key の位置） */
export const SERVICE_KEY = "mock-service-key";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function makeJwt(payload) {
  const head = b64url({ alg: "HS256", typ: "JWT" });
  const body = b64url(payload);
  const sig = createHmac("sha256", FAKE_SECRET)
    .update(`${head}.${body}`)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${head}.${body}.${sig}`;
}

function readJwt(token) {
  try {
    const [, body] = token.split(".");
    return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export async function startSupabaseMock({ db = null } = {}) {
  const database = db ?? (await createTestDb());

  /** access_token → ユーザーID。トークンの中身も見るが、失効の管理はこちら */
  const sessions = new Map();
  /** 置かれた画像（バケット/パス → 大きさ）。消えたかどうかもここで見る */
  const objects = new Map();

  /** 確認メールの印 → 利用者ID */
  const confirmTokens = new Map();

  /** 確認待ちのメール（利用者ID → メール）。本物の new_email にあたる */
  const pendingEmails = new Map();

  /**
   * 消したあとも、同じURLならしばらく返るもの。
   *
   * 本物の公開URLは CDN を通るので、実体を消しても同じURLは
   * しばらく200のまま返る（スモークがその前提で書かれている）。
   * クエリを付けると鍵が変わって実体を見に行く、という振る舞いまで写す。
   */
  const cachedObjects = new Set();

  async function userRow(id) {
    const { rows } = await database.query(
      `select id, email, is_anonymous, created_at from auth.users where id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    const u = rows[0];
    return {
      id: u.id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email ?? undefined,
      new_email: pendingEmails.get(u.id),
      is_anonymous: u.is_anonymous,
      created_at: u.created_at,
      updated_at: u.created_at,
      app_metadata: { provider: u.is_anonymous ? "anonymous" : "email" },
      user_metadata: {},
      identities: [],
    };
  }

  async function makeSession(id) {
    const user = await userRow(id);
    if (!user) return null;

    const now = Math.floor(Date.now() / 1000);
    const access = makeJwt({
      sub: id,
      role: "authenticated",
      aud: "authenticated",
      is_anonymous: user.is_anonymous,
      iat: now,
      exp: now + 3600,
    });
    const refresh = randomUUID();
    sessions.set(access, id);
    sessions.set(refresh, id);

    return {
      access_token: access,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: now + 3600,
      refresh_token: refresh,
      user,
    };
  }

  /** 集合を返す関数かどうか。1回引いたら覚える */
  const setReturning = new Map();
  async function isSetReturning(fn) {
    if (setReturning.has(fn)) return setReturning.get(fn);
    const { rows } = await database.query(
      `select bool_or(p.proretset) as s
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = $1`,
      [fn],
    );
    const value = Boolean(rows[0]?.s);
    setReturning.set(fn, value);
    return value;
  }

  /** 呼び出した人の役を決める。ここが「本物と同じ形」でいちばん大事なところ */
  async function whoIs(req) {
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

    if (token === SERVICE_KEY) return { role: "service_role", uid: null };
    if (token === "" || token === ANON_KEY) return { role: "anon", uid: null };

    const claims = readJwt(token);
    if (!claims?.sub) return { role: "anon", uid: null };

    const user = await userRow(claims.sub);
    if (!user) return { role: "anon", uid: null };

    return {
      role: "authenticated",
      uid: claims.sub,
      isAnonymous: Boolean(user.is_anonymous),
    };
  }

  // null は「JSON の null」なので本文に出す。本文なしは undefined で表す
  function send(res, status, body, headers = {}) {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      ...headers,
    });
    res.end(text);
  }

  /** DB のエラーを PostgREST の形に写す */
  function dbError(res, e) {
    const message = e?.message ?? String(e);
    send(res, 400, {
      message,
      code: "P0001",
      details: null,
      hint: null,
    });
  }

  async function body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;

    if (req.method === "OPTIONS") {
      return send(res, 204, undefined, {
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        "access-control-allow-headers": "*",
      });
    }

    try {
      // ---------- 認証 ----------
      if (path === "/auth/v1/health") return send(res, 200, { name: "mock" });

      if (path === "/auth/v1/signup" && req.method === "POST") {
        const raw = await body(req);
        const input = raw.length > 0 ? JSON.parse(raw.toString("utf8")) : {};
        const anonymous = !input.email;

        const { rows } = await database.query(
          `insert into auth.users (email, is_anonymous) values ($1, $2) returning id`,
          [input.email ?? null, anonymous],
        );
        return send(res, 200, await makeSession(rows[0].id));
      }

      if (path === "/auth/v1/token" && req.method === "POST") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        const grant = url.searchParams.get("grant_type");

        if (grant === "refresh_token") {
          const id = sessions.get(input.refresh_token);
          if (!id) return send(res, 400, { error: "invalid_grant" });
          return send(res, 200, await makeSession(id));
        }

        const { rows } = await database.query(
          `select id from auth.users where email = $1`,
          [input.email ?? ""],
        );
        if (rows.length === 0) {
          return send(res, 400, {
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          });
        }
        return send(res, 200, await makeSession(rows[0].id));
      }

      if (path === "/auth/v1/user") {
        const who = await whoIs(req);
        if (!who.uid) return send(res, 401, { message: "invalid claim" });

        if (req.method === "PUT") {
          // ゲストが登録するとき。
          //
          // **本物と同じで、この場ではメールを確定させない。**
          // Supabase は確認メールを送り、リンクを開くまで new_email のまま。
          // ここで確定させると「確認メールの案内」の検査ができなくなる。
          const input = JSON.parse((await body(req)).toString("utf8") || "{}");
          if (input.email) {
            const current = await userRow(who.uid);
            if (current?.email && current.email.toLowerCase() === input.email.toLowerCase()) {
              // すでに同じメールなら何もしない
            } else {
              pendingEmails.set(who.uid, input.email);
              const token = randomUUID().replace(/-/g, "");
              confirmTokens.set(token, who.uid);
            }
          }
        }
        return send(res, 200, await userRow(who.uid));
      }

      if (path === "/auth/v1/logout") return send(res, 204, undefined);

      // 確認メールの印を引き換える（/auth/confirm が呼ぶ）
      if (path === "/auth/v1/verify" && req.method === "POST") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        const id = confirmTokens.get(input.token_hash ?? "");
        if (!id) return send(res, 401, { message: "invalid token" });

        confirmTokens.delete(input.token_hash);

        const pending = pendingEmails.get(id);
        if (pending) {
          await database.query(`update auth.users set email = $2 where id = $1`, [id, pending]);
          pendingEmails.delete(id);
        }

        await database.query(
          `update auth.users set is_anonymous = false where id = $1`,
          [id],
        );
        await database.query(
          `update public.profiles set is_anonymous = false where id = $1`,
          [id],
        );
        return send(res, 200, await makeSession(id));
      }

      if (path === "/auth/v1/admin/generate_link" && req.method === "POST") {
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");

        let { rows } = await database.query(
          `select id from auth.users where email = $1`,
          [input.email ?? ""],
        );
        if (rows.length === 0) {
          rows = (
            await database.query(
              `insert into auth.users (email, is_anonymous) values ($1, false) returning id`,
              [input.email],
            )
          ).rows;
        }

        const token = randomUUID().replace(/-/g, "");
        confirmTokens.set(token, rows[0].id);

        const user = await userRow(rows[0].id);
        return send(res, 200, {
          ...user,
          action_link: `${input.options?.redirectTo ?? ""}?token_hash=${token}&type=signup`,
          email_otp: "000000",
          hashed_token: token,
          redirect_to: input.options?.redirectTo ?? "",
          verification_type: input.type ?? "signup",
        });
      }

      if (path.startsWith("/auth/v1/admin/users")) {
        const rest = path.slice("/auth/v1/admin/users".length).replace(/^\//, "");

        // 一覧（ページ送りの形だけ本物に合わせる）
        if (req.method === "GET" && rest === "") {
          const { rows } = await database.query(
            `select id from auth.users order by created_at`,
          );
          const users = [];
          for (const r of rows) users.push(await userRow(r.id));
          return send(res, 200, { users, aud: "authenticated" });
        }

        if (req.method === "GET" && rest !== "") {
          const user = await userRow(rest);
          if (!user) return send(res, 404, { message: "not found" });
          return send(res, 200, user);
        }

        if (req.method === "PUT" && rest !== "") {
          const input = JSON.parse((await body(req)).toString("utf8") || "{}");
          if (input.email) {
            await database.query(
              `update auth.users set email = $2, is_anonymous = false where id = $1`,
              [rest, input.email],
            );
          }
          if (input.user_metadata) {
            await database.query(
              `update auth.users set raw_user_meta_data = $2 where id = $1`,
              [rest, JSON.stringify(input.user_metadata)],
            );
          }
          return send(res, 200, await userRow(rest));
        }

        if (req.method === "DELETE" && rest !== "") {
          await database.query(`delete from auth.users where id = $1`, [rest]);
          return send(res, 200, {});
        }

        if (req.method === "POST") {
          const input = JSON.parse((await body(req)).toString("utf8") || "{}");
          const { rows } = await database.query(
            `insert into auth.users (email, is_anonymous, raw_user_meta_data)
             values ($1, false, $2) returning id`,
            [
              input.email ?? `${randomUUID()}@example.test`,
              JSON.stringify(input.user_metadata ?? {}),
            ],
          );
          return send(res, 200, { user: await userRow(rows[0].id) });
        }
      }

      // ---------- RPC ----------
      //
      // 【1行返す関数と、表を返す関数で形が違う】
      //   PostgREST は、値を1つ返す関数ならその値をそのまま返し、
      //   表を返す関数なら行の配列を返す。同じ書き方で呼ぶと、
      //   **一覧を返す関数が「先頭1件だけ」になる**（実測: /works が0件に見えた）。
      //   pg_proc の proretset（集合を返すか）で分ける。
      if (path.startsWith("/rest/v1/rpc/")) {
        const fn = path.slice("/rest/v1/rpc/".length);
        const input = JSON.parse((await body(req)).toString("utf8") || "{}");
        const who = await whoIs(req);

        const names = Object.keys(input);
        const args = names.map((n, i) => `${n} => $${i + 1}`).join(", ");
        // 別名を付けない。付けると列の名前がその別名になり、
        // 「値を1つ返す関数」と見分けられなくなる（実測: 列名が t になった）
        const sql = `select * from public.${fn}(${args})`;

        try {
          const setOf = await isSetReturning(fn);
          const out = await asRole(database, who, async (c) =>
            c.query(sql, names.map((n) => input[n])),
          );

          const fields = out.fields?.map((f) => f.name) ?? Object.keys(out.rows[0] ?? {});
          const scalar = fields.length === 1 && fields[0] === fn;

          if (scalar && !setOf) {
            return send(res, 200, out.rows[0]?.[fn] ?? null);
          }
          if (scalar) {
            return send(res, 200, out.rows.map((r) => r[fn]));
          }
          return send(res, 200, out.rows);
        } catch (e) {
          return dbError(res, e);
        }
      }

      // ---------- 表の読み書き ----------
      if (path.startsWith("/rest/v1/")) {
        const table = path.slice("/rest/v1/".length);
        const who = await whoIs(req);

        const select = url.searchParams.get("select") ?? "*";
        const wheres = [];
        const params = [];
        for (const [key, value] of url.searchParams.entries()) {
          if (["select", "order", "limit", "offset"].includes(key)) continue;
          const [op, ...rest] = value.split(".");
          if (op !== "eq") continue;
          params.push(rest.join("."));
          wheres.push(`${key} = $${params.length}`);
        }

        const order = url.searchParams.get("order");
        const orderSql = order
          ? ` order by ${order.split(".")[0]} ${
              order.endsWith(".desc") ? "desc" : "asc"
            }`
          : "";
        const limit = url.searchParams.get("limit");
        const limitSql = limit ? ` limit ${Number.parseInt(limit, 10)}` : "";

        if (req.method === "GET") {
          const sql =
            `select ${select} from public.${table}` +
            (wheres.length ? ` where ${wheres.join(" and ")}` : "") +
            orderSql +
            limitSql;

          try {
            const out = await asRole(database, who, async (c) => c.query(sql, params));
            const single = (req.headers.accept ?? "").includes("pgrst.object");

            if (single) {
              if (out.rows.length === 0) {
                return send(res, 406, {
                  code: "PGRST116",
                  message: "JSON object requested, multiple (or no) rows returned",
                });
              }
              return send(res, 200, out.rows[0]);
            }
            return send(res, 200, out.rows);
          } catch (e) {
            return dbError(res, e);
          }
        }

        if (req.method === "DELETE") {
          const sql =
            `delete from public.${table}` +
            (wheres.length ? ` where ${wheres.join(" and ")}` : "");
          try {
            await asRole(database, who, async (c) => c.query(sql, params));
            return send(res, 204, undefined);
          } catch (e) {
            return dbError(res, e);
          }
        }
      }

      // ---------- 保管庫 ----------
      // 公開の読み出し。**置かれていないものは 404。**
      // 「消したはずの画像がまだ見える」を検査できるようにする
      if (path.startsWith("/storage/v1/object/public/")) {
        const key = decodeURIComponent(path.slice("/storage/v1/object/public/".length));
        const noQuery = url.search === "";

        if (!objects.has(key)) {
          // 消したあとでも、クエリの無い同じURLはしばらく返る（CDN の写し）
          if (noQuery && cachedObjects.has(key)) {
            res.writeHead(200, { "content-type": "image/png", "x-mock-cache": "HIT" });
            return res.end(TINY_PNG);
          }
          return send(res, 404, { message: "Object not found" });
        }
        res.writeHead(200, { "content-type": "image/png" });
        return res.end(TINY_PNG);
      }

      if (path.startsWith("/storage/v1/object/")) {
        const key = path.slice("/storage/v1/object/".length);
        const raw = await body(req);

        if (req.method === "POST" || req.method === "PUT") {
          objects.set(key, raw.length);
          return send(res, 200, { Key: key });
        }
        if (req.method === "DELETE") {
          const input = JSON.parse(raw.toString("utf8") || "{}");
          for (const p of input.prefixes ?? []) {
            for (const k of [`${key}/${p}`, p]) {
              if (objects.delete(k)) cachedObjects.add(k);
            }
          }
          return send(res, 200, []);
        }
      }

      return send(res, 404, { message: `mock: ${req.method} ${path} は用意していません` });
    } catch (e) {
      return send(res, 500, { message: e?.message ?? String(e) });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    db: database,
    url: `http://127.0.0.1:${port}`,
    objects,

    /**
     * いちばん新しい「確認メールの印」を返す。**試験だけが読む。**
     *
     * 本物では、この値は利用者の受信箱に届くリンクの中にしか無い。
     * ブラウザ試験は受信箱を持てないので、送ったはずの印をここから取り出して
     * リンクを自分で組み立てる。**リンクを開いたあとの流れは本物と同じ道**
     * （/auth/confirm → verifyOtp → Cookie）を通る。
     */
    lastConfirmToken() {
      let last = null;
      for (const token of confirmTokens.keys()) last = token;
      return last;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
