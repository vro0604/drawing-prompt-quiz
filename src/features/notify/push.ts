import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  randomBytes,
} from "node:crypto";

/**
 * ブラウザのプッシュを1件送る（Web Push / RFC 8291・RFC 8188・VAPID）。
 *
 * 【なぜ自分で書いているか】
 *   外部の送信サービスを使わない。プッシュはブラウザの製造元（Google / Apple /
 *   Mozilla）のサーバーへ直接 HTTP で投げる仕組みで、間に業者は要らない。
 *   必要なのは (1) 自分のサイトの署名鍵（VAPID）と (2) 中身の暗号化。
 *
 * 【流れ】
 *   ブラウザが「宛先（endpoint）」と「公開鍵（p256dh）」と「共有秘密（auth）」を作る
 *     → こちらが DB へ保存する（push_subscriptions）
 *     → 送るとき、宛先ごとに中身を暗号化して POST する
 *     → 製造元のサーバーが、その端末のブラウザへ配る
 *
 * 【中身は必ず暗号化される】
 *   製造元のサーバーは中身を読めない。読めるのは受け取った端末だけ。
 *   鍵はブラウザが作ったもの（p256dh / auth）から毎回作り直す。
 *
 * 【鍵はここで作らない】
 *   VAPID の鍵は環境変数から読む。**本番の値をこのコードに書かない。**
 *   作り方は docs/web-push-setup.md にある。
 */

const b64u = (buf: Buffer | Uint8Array): string => Buffer.from(buf).toString("base64url");
const unb64u = (s: string): Buffer => Buffer.from(s, "base64url");

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** 鍵がそろっているか。1つでも欠けていたら送らない（黙って諦めない） */
export function pushConfig(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY ?? "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY ?? "").trim();
  const subject = (process.env.VAPID_SUBJECT ?? "").trim();

  if (publicKey === "" || privateKey === "" || subject === "") return null;
  return { publicKey, privateKey, subject };
}

/**
 * 「このサイトからの送信である」ことの署名（VAPID）。
 *
 * 宛先のサーバーは、この署名で送り主を見分ける。
 * 署名しないと、誰でも他人の宛先へ送れてしまう。
 */
function vapidHeader(endpoint: string, cfg: NonNullable<ReturnType<typeof pushConfig>>): string {
  const audience = new URL(endpoint).origin;

  const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(
    Buffer.from(
      JSON.stringify({
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 12 * 3600,
        sub: cfg.subject,
      }),
    ),
  );

  const pub = unb64u(cfg.publicKey);   // 0x04 || x(32) || y(32)
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(unb64u(cfg.privateKey)),
      x: b64u(pub.subarray(1, 33)),
      y: b64u(pub.subarray(33, 65)),
    },
    format: "jwk",
  });

  const signer = createSign("SHA256");
  signer.update(`${header}.${claims}`);
  // JWT の ES256 は r||s の並び。DER にすると宛先サーバーが受け取らない
  const signature = signer.sign({ key, dsaEncoding: "ieee-p1363" });

  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${cfg.publicKey}`;
}

/**
 * 中身を暗号化する（aes128gcm）。
 *
 * 受け取る端末しか開けない形にして、宛先サーバーには封をしたまま渡す。
 *
 * **export しているのは試験のため。**ここが正しいかどうかは、
 * 本物の端末が無いと確かめられない。単体試験では、受け取る側の鍵を自分で作り、
 * 封を開け直して元の文に戻ることを見ている（test/unit/run.mjs）。
 */
export function encryptPayload(payload: string, uaPublicKey: string, authSecret: string): Buffer {
  const uaPublic = unb64u(uaPublicKey);
  const auth = unb64u(authSecret);

  // 1回ごとに使い捨ての鍵を作り、相手の公開鍵と混ぜて共有の種を作る
  const ec = createECDH("prime256v1");
  ec.generateKeys();
  const asPublic = ec.getPublicKey();
  const shared = ec.computeSecret(uaPublic);

  const prkKey = hmac(auth, shared);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0", "utf8"),
    uaPublic,
    asPublic,
  ]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));

  const salt = randomBytes(16);
  const prk = hmac(salt, ikm);

  const cek = hmac(
    prk,
    Buffer.concat([Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), Buffer.from([1])]),
  ).subarray(0, 16);

  const nonce = hmac(
    prk,
    Buffer.concat([Buffer.from("Content-Encoding: nonce\0", "utf8"), Buffer.from([1])]),
  ).subarray(0, 12);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(payload, "utf8"), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);

  // salt(16) ‖ 記録の大きさ(4) ‖ 鍵の長さ(1) ‖ 使い捨ての公開鍵(65) ‖ 封をした中身
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, sealed]);
}

export type PushTarget = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushMessage = {
  title: string;
  body: string;
  url: string;
  tag: string;
};

export type PushOutcome =
  | { ok: true }
  /** 宛先がもう無い（404 / 410）。この宛先は止めてよい */
  | { ok: false; gone: true; error: string }
  | { ok: false; gone: false; error: string };

/** 1件送る。**送れたことにしない。**宛先サーバーの返事をそのまま返す */
export async function sendPush(target: PushTarget, message: PushMessage): Promise<PushOutcome> {
  const cfg = pushConfig();
  if (!cfg) {
    return { ok: false, gone: false, error: "VAPID の鍵が未設定です" };
  }

  let body: Buffer;
  try {
    body = encryptPayload(JSON.stringify(message), target.p256dh, target.auth);
  } catch (e) {
    return { ok: false, gone: false, error: `暗号化できません: ${String(e)}` };
  }

  let res: Response;
  try {
    res = await fetch(target.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidHeader(target.endpoint, cfg),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: "normal",
      },
      body: new Uint8Array(body),
    });
  } catch (e) {
    return { ok: false, gone: false, error: `送れません: ${String(e)}` };
  }

  if (res.status === 404 || res.status === 410) {
    return { ok: false, gone: true, error: `宛先が無効です（${res.status}）` };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, gone: false, error: `${res.status} ${text.slice(0, 200)}` };
  }

  return { ok: true };
}
