/**
 * _probe.mjs ／ 柵そのものを試すための的
 *
 * 柵を立てたあと、指示された1つのことをして結果を出す。
 * この的は試験からしか呼ばれない。
 *
 *   引数なし         … 柵を立てるだけ。通れば "PASSED" と出して 0 で終わる
 *   --fetch <url>    … 柵を立てたあと、その URL を取りに行く
 *   --redirect <url> … ローカルに小さなサーバーを立て、そこから <url> へ
 *                      302 で飛ばす。**跳んだ先が外なら止まるか**を見る
 *   --ws <url>       … その URL へ WebSocket をつなごうとする
 */

import { createServer } from "node:http";
import { installLocalOnlyGuard } from "./no-production.mjs";

installLocalOnlyGuard("柵の自己試験");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const fetchUrl = arg("--fetch");
if (fetchUrl) {
  try {
    await fetch(fetchUrl);
    console.log("FETCH_ALLOWED");
    process.exit(0);
  } catch (e) {
    console.log(`FETCH_BLOCKED ${e.message}`);
    process.exit(71);
  }
}

const redirectTo = arg("--redirect");
if (redirectTo) {
  // ローカルの入口から外へ飛ばす。**1跳び目はローカルなので素通りする。**
  // 止まるとしたら2跳び目で、そこを見るのがこの的の仕事。
  const server = createServer((req, res) => {
    res.writeHead(302, { location: redirectTo });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const res = await fetch(`http://127.0.0.1:${port}/go`);
    console.log(`REDIRECT_ALLOWED ${res.status} ${res.url}`);
    server.close();
    process.exit(0);
  } catch (e) {
    console.log(`FETCH_BLOCKED ${e.message}`);
    server.close();
    process.exit(71);
  }
}

const wsUrl = arg("--ws");
if (wsUrl) {
  if (typeof globalThis.WebSocket !== "function") {
    console.log("WS_UNAVAILABLE この Node には WebSocket がありません");
    process.exit(0);
  }
  try {
    const ws = new globalThis.WebSocket(wsUrl);
    ws.close?.();
    console.log("WS_ALLOWED");
    process.exit(0);
  } catch (e) {
    console.log(`FETCH_BLOCKED ${e.message}`);
    process.exit(71);
  }
}

console.log("PASSED");
