/**
 * プッシュ通知の鍵を1組つくる（VAPID）。
 *
 * 実行: node scripts/gen-vapid.mjs
 *
 * 【何をするか】
 *   画面に鍵を2つ出すだけ。**どこにも保存しないし、どこへも送らない。**
 *   出た値を、自分で Vercel の環境変数へ貼る。
 *
 * 【鍵とは何か】
 *   ブラウザの製造元（Google / Apple / Mozilla）のサーバーは、
 *   「誰からの通知か」を確かめてから端末へ配る。その確かめに使う印章が VAPID。
 *   公開鍵は誰に見せてもよい。秘密鍵は絶対に人へ渡さない。
 *
 * 【貼る先】
 *   NEXT_PUBLIC_VAPID_PUBLIC_KEY … 公開鍵（ブラウザにも渡る）
 *   VAPID_PUBLIC_KEY             … 同じ公開鍵（送信するとき使う）
 *   VAPID_PRIVATE_KEY            … 秘密鍵。**NEXT_PUBLIC_ を付けない**
 *   VAPID_SUBJECT                … mailto:自分のアドレス
 */

import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

const pubJwk = publicKey.export({ format: "jwk" });
const privJwk = privateKey.export({ format: "jwk" });

const b64u = (s) => Buffer.from(s, "base64url");

// VAPID の公開鍵は 0x04 ‖ x ‖ y の 65 バイト
const raw = Buffer.concat([Buffer.from([4]), b64u(pubJwk.x), b64u(pubJwk.y)]);

console.log("");
console.log("プッシュ通知の鍵を作りました。下の4行を環境変数に入れてください。");
console.log("**このファイルにも .env にも自動では書き込みません。**");
console.log("");
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${raw.toString("base64url")}`);
console.log(`VAPID_PUBLIC_KEY=${raw.toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${privJwk.d}`);
console.log(`VAPID_SUBJECT=mailto:ここに自分のメールアドレス`);
console.log("");
console.log("秘密鍵（VAPID_PRIVATE_KEY）は人に見せないでください。");
console.log("漏れたときは、この道具でもう一度作り直して差し替えます。");
console.log("差し替えると、いまの通知の宛先は全部無効になります（利用者は登録し直し）。");
console.log("");
