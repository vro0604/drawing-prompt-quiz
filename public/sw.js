/**
 * つたわるかな ／ ブラウザのプッシュを受け取る係（Service Worker）。
 *
 * 【これは何か】
 *   サイトのタブを閉じていても、ブラウザがこの小さなプログラムを動かして
 *   通知を出せる。ページの JavaScript とは別に動くので、
 *   **画面が開いていなくても届く。**
 *
 * 【中身は必ずサーバーから来る】
 *   ここで文言を作らない。何を出すかはサーバーが決めて、暗号化して送る。
 *   ここは受け取って表示するだけ。
 *
 * 【お題の語は入っていない】
 *   通知はロック画面にも出る。正解が写らないよう、送る側（notification_events）が
 *   お題の語を1文字も入れない形にしてある。
 *
 * 【押したときの動き】
 *   同じサイトのタブが既に開いていればそれを前へ出す。
 *   無ければ新しく開く。**毎回タブを増やさない。**
 *
 * 【画面を見ている人には、通知を重ねない】
 *   サイトを開いて見ている最中に、同じことを画面の帯とプッシュの両方で
 *   出すと二重になる。見えているタブがあるときは、そのタブへ合図だけ送って
 *   画面の帯に任せる。
 *
 *   **ただし、これは保証ではない。**ブラウザは「プッシュを受け取ったら
 *   必ず何か表示する」約束（userVisibleOnly）を求めていて、表示しない回数が
 *   続くと、ブラウザ自身が「サイトがバックグラウンドで更新されました」という
 *   通知を代わりに出すことがある。どのブラウザがいつそうするかは、
 *   この端末では確かめられない。**確かめられるのは
 *   「見えているタブがあれば、こちらからは通知を出さない」ところまで。**
 */

self.addEventListener("install", () => {
  // 待たずにすぐ有効にする。古い係が居座って新しい通知を落とさないように
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }

  const title = typeof data.title === "string" && data.title ? data.title : "つたわるかな";
  const body = typeof data.body === "string" ? data.body : "";
  const url = typeof data.url === "string" && data.url ? data.url : "/";
  // 同じ出来事が二重に届いても、通知が2つ並ばないようにする
  const tag = typeof data.tag === "string" ? data.tag : undefined;

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // 画面を見ているタブがあるなら、そちらへ合図を送るだけにする
      const visible = clients.filter((c) => c.visibilityState === "visible");
      if (visible.length > 0) {
        for (const c of visible) c.postMessage({ type: "notification", title, body, url });
        return;
      }

      await self.registration.showNotification(title, {
        body,
        tag,
        renotify: Boolean(tag),
        data: { url },
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        for (const client of list) {
          if ("focus" in client) {
            client.navigate(url);
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      }),
  );
});
