# 課金 v0 ／ Stripe テストモードでの接続と試験の手順

課金 v0（Founding Creator、D187 / D201）を、**本番の販売を始めずに**、Stripe のテストモードで
「技術的に買える」ことまで確かめるための1枚。鍵を用意する人が、上から順に辿れば済むように書く。

最終更新: 2026-09-17

**この文書には秘密の値を書かない。変数名だけを書く。**

---

## 0. いまどこまで済んでいるか（2026-09-17 の実測）

| 項目 | 状態 |
|---|---|
| 本番のデータベース | 課金の2本（`20260917090000` / `20260917100000`）は**適用済み**。履歴67本、手元と本番で67/67 |
| 商品 | `founding_creator_v0` が1行。3,000円・円建て・買い切り・30枠。**`is_active = false`（販売していない）** |
| 購入・権限・顧客・受け取った合図 | すべて0件 |
| 規約・ポリシーの有効版 | 2026-09-09（legal_v2） |
| `/founder` | 「ただいま販売しておりません」 |
| `/tokushoho` | 「現在、この商品は販売していません」＋販売を始めるときの条件 |
| 購入の受け口 `POST /api/billing/checkout` | 503（Stripe の鍵が本番に無い） |
| 知らせの受け口 `POST /api/billing/webhook` | 503（`STRIPE_WEBHOOK_SECRET` が本番に無い） |
| Stripe の鍵 | **どこにも無い**（手元・環境変数・鍵束のどれにも無い。Stripe CLI も無い） |
| Vercel の環境変数 | 手元の Vercel CLI が未ログインのため、読めない・書けない |
| Stripe CLI | この端末に無かった。2026-09-17 に公式リリース v1.50.11 を取得できることを確かめた（sha256 一致）。ログイン情報は無い |

販売停止のまま閉じていることは `npm run smoke:prod -- billing` で本番を見て確かめられる（2026-09-17 に全項目合格。D204）。
販売を始めるとこのスモークは落ちるので、そのときに期待値を直す。

状態の呼び名は D201 と同じ `BLOCKED: STRIPE_TEST_CREDENTIALS`。

---

## 1. コードが要求する設定（4つ）

| 変数 | 何に使うか | 形 | どこに置くか |
|---|---|---|---|
| `STRIPE_SECRET_KEY` | こちらから Stripe を呼ぶ（顧客と決済ページを作る） | テストモードは `sk_test_` で始まる | サーバーだけ。**`NEXT_PUBLIC_` を付けない** |
| `STRIPE_WEBHOOK_SECRET` | Stripe から来た知らせの署名を確かめる | `whsec_` で始まる | サーバーだけ。**`NEXT_PUBLIC_` を付けない** |
| `SUPABASE_SECRET_KEY` | 購入の確定・返金の反映を DB へ書く（service_role でしか呼べない関数） | 既存 | 既存のまま |
| `NEXT_PUBLIC_SITE_URL` | 決済のあとに戻る URL（`/founder?paid=1` など）を組み立てる | 既存 | 既存のまま |

出所: `src/lib/env.ts` の `billingConfigError`、`src/app/api/billing/checkout/route.ts`。
どれか1つでも欠けると、購入の受け口は 503 で閉じる（**素通しにしない**）。

**Stripe 側に「商品」や「価格」を登録する必要は無い。**決済ページを作るたびに、
金額と商品名を DB の商品定義（`billing_offers`）から `price_data` として渡す作り
（`src/features/billing/stripe.ts`）。値段を変えるのは DB の1か所だけで済む。

**API の版は `2026-08-26.dahlia` に固定している。**呼び出しのヘッダー
（`src/features/billing/types.ts` の `STRIPE_API_VERSION`）で指定しているので、
Stripe の口座の既定の版には左右されない。受け口を登録するときも、この版を選ぶ。

---

## 2. 人が行う操作（2026-09-17 に案 A で組み直した。人がやるのは鍵を1つ入れるだけ）

2026-09-17 のユーザー指示で**案 A（手元のアプリ＋手元の DB＋Stripe テストモード）を採用した。**
Stripe からの知らせは Stripe CLI の `stripe listen` が手元のアプリへ転送するので、
**Stripe の管理画面に Webhook の受け口を作る必要は無い。**署名の鍵（`whsec_…`）も CLI が出す。
Stripe 側に商品や価格も作らない（1 のとおり、金額は DB から渡す）。

人にしかできないのは、Stripe のアカウントに入ってテストモードの秘密鍵を1つ取り出し、この端末のキーチェーンへ入れることだけ。
（Stripe のログインと鍵の表示は、本人の認証が要る。この端末には Stripe の鍵も CLI のログイン情報も無い。2026-09-17 の実測）

1. ブラウザで https://dashboard.stripe.com/test/apikeys を開く。ログインを求められたらログインする
   （アカウントが無ければ https://dashboard.stripe.com/register で作る。テストモードだけなら本人確認・口座登録は要らない）
2. テストモードであることを確かめる。画面の上部に「テスト環境」または「サンドボックス」の表示があり、
   URL に `/test/` が入っている。**「本番環境」と出ていたら先へ進まない**
3. 何も作らない（商品・価格・Webhook の受け口のどれも作らない）
4. 「標準キー」の「シークレットキー」で「テスト用キーを表示」を押し、`sk_test_` で始まる値をコピーする
   （`sk_live_` で始まる値は使わない。試験の道具も、その形の鍵なら通信する前に止まる）
5. Webhook の URL は指定しない（CLI が転送する）
6. 購読する知らせも指定しない（道具が7種類だけを指定する）
7. ターミナルで次を実行し、聞かれたら 4 の値を貼り付けて Enter（2回聞かれる）。
   **.env.local にも Vercel にも入れない**
   ```
   security add-generic-password -s drawing-prompt-quiz-stripe-test-secret-key -a "$USER" -w
   ```
8. Claude へは「Stripe テストの鍵をキーチェーンに入れた」とだけ伝える（値は伝えない）

---

## 3. 8段の通し方（案 A）

道具は `test/billing/stripe-e2e.mjs`（`npm run test:billing:stripe`）。

| モード | Stripe と通信するか | 何を確かめるか |
|---|---|---|
| `local`（既定） | しない | 3〜8段と、二重処理・不正な知らせ・突き合わせの失敗を、手元が Stripe と同じ手順で署名した知らせで確かめる。1・2段目は DB の関数で代わりにする |
| `stripe` | する（テストモードだけ） | 1〜8段をこの順に。決済ページを作り、テストカード 4242 4242 4242 4242 で払い、`stripe listen` が知らせを転送する。返金は Stripe の API で全額 |

`stripe` モードの始め方（鍵を入れたあと）:

```
# Stripe CLI（2026-09-17 に v1.50.11 を公式の GitHub リリースから取得し、sha256 を照合）
curl -sLO https://github.com/stripe/stripe-cli/releases/download/v1.50.11/stripe_1.50.11_mac-os_arm64.tar.gz
curl -sLO https://github.com/stripe/stripe-cli/releases/download/v1.50.11/stripe-mac-checksums.txt
grep arm64 stripe-mac-checksums.txt; shasum -a 256 stripe_1.50.11_mac-os_arm64.tar.gz   # 2つが一致すること
tar xzf stripe_1.50.11_mac-os_arm64.tar.gz
STRIPE_CLI="$PWD/stripe" npm run test:billing:stripe -- --mode stripe
```

道具が Stripe へ最初に通信する前に止まる条件:

- キーチェーンに鍵が無い
- 鍵が `sk_test_` / `rk_test_` で始まらない（2026-09-17 に `sk_live_` の形の偽の値で止まることを確かめた）
- 本番の Supabase の痕跡が環境にある（`test/guard/no-production.mjs`）

最初の通信は `GET /v1/balance`（読むだけ）で、`livemode` が false でなければ何も作らずに止まる。
販売を開けるのは手元の PGlite の中の `founding_creator_v0` だけ。本番の DB へは接続しない。

1段目が販売停止中の商品では通らない件（以前の案 A〜C）は、手元の DB でだけ `is_active = true` にすることで解いた。
本番の商品は `is_active = false` のまま。

---

## 4. 結果（2026-09-17）

- `local`: 50項目すべて合格（Stripe へは通信していない）
- `stripe`: 未実施（2 の鍵が未設定。`BLOCKED: STRIPE_TEST_CREDENTIALS`）

---

## 5. やってはいけないこと

- live の鍵への切り替え
- 本番の商品の販売開始（`is_active = true` を残すこと）
- 本物の決済
- Creator Pro の販売
- `beta_access` を使った未決定の機能の公開
- 本物の利用者4人の同意状態を、試験のために書き換えること

---

## 6. 試験のあとに残るもの

検査用アカウントで買った行（`billing_purchases` / `billing_entitlements` /
`billing_webhook_events` / `billing_customers`）は、**消す手順がまだ決まっていない。**
購入の行は `profiles` を消しても `profile_id` が空になって残り（`on delete set null`）、
Founder 番号も欠番として残る設計のため、検査用アカウントを消しても行は残る。
案 A なら手元の DB ごと捨てられるので、この問題は起きない。

Stripe のテストモード側に残るもの（`stripe` モード）:

- 道具が片づけるもの: 開いたままの決済ページ（失効させる）、作った顧客（削除する）
- 残るもの（Stripe では削除できない。テストモードの履歴として正常）: 支払い（PaymentIntent・Charge）、返金、知らせ（Event）、
  失効・完了した決済ページ

D201 の6段目は「Stripe の管理画面から全額返金する」だが、道具は同じ返金を Stripe の API（`POST /v1/refunds`）で作る。
Stripe 側にできるもの（Refund と、その知らせ）は同じ。管理画面の操作は人の手が要るため、置き換えた。

