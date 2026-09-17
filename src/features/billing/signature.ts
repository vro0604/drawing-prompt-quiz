import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe とのやり取りのうち、**外部を1つも呼ばない部分**だけを集めたファイル。
 *
 * 【なぜ切り分けるか】
 *   署名の確かめ方と、送る文字列の組み立て方は、
 *   ネットワークにも環境変数にも依存しない純粋な変換。
 *   ここだけ分けておくと、**サーバーを立てずに単体で試せる**
 *   （test/unit/run.mjs が直接読み込む）。
 *   偽の知らせを弾けるかどうかは、実際に偽の署名を作って試すのが確実で、
 *   そのために Stripe も DB もブラウザも要らない状態にしてある。
 */

/**
 * 入れ子のかたまりを、Stripe が読む形の文字列にする。
 *
 *   { line_items: [{ quantity: 1, price_data: { currency: "jpy" } }] }
 *     → line_items[0][quantity]=1&line_items[0][price_data][currency]=jpy
 *
 * null と undefined の項目は送らない（送ると空文字として解釈される）。
 */
export type FormValue = string | number | boolean | null | undefined | FormShape | FormValue[];
export type FormShape = { [key: string]: FormValue };

export function toStripeForm(shape: FormShape): URLSearchParams {
  const params = new URLSearchParams();

  const walk = (prefix: string, value: FormValue): void => {
    if (value === null || value === undefined) return;

    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(`${prefix}[${i}]`, v));
      return;
    }

    if (typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(`${prefix}[${k}]`, v);
      return;
    }

    params.append(prefix, String(value));
  };

  for (const [k, v] of Object.entries(shape)) walk(k, v);
  return params;
}

/**
 * 決済ページを作るときに Stripe へ送る中身。
 *
 * 【値段をここで決めない】
 *   金額も通貨も商品名も、呼ぶ側が DB の商品定義から読んだ値を渡す。
 *   **ブラウザから来た値をここへ流さないこと。**
 *
 * 【Managed Payments を、この決済ページでは使わない】
 *   2026-09-17 に Stripe のテストモードへ実際に通信したところ、口座で既定の
 *   Managed Payments（Stripe 側が販売者になる仕組み）が有効で、
 *   `payment_method_types` を付けた要求は「Unsupported parameter」で断られた。
 *   v0 の販売者はこのサービス自身（/tokushoho・規約 13 条）で、価格は税込み、
 *   支払い方法はカードに限る。これを保つため、要求ごとに
 *   `managed_payments[enabled]=false` を送る（Stripe の文書が示す、要求単位で切る方法）。
 *   出所: https://docs.stripe.com/payments/managed-payments/set-up （2026-09-17 取得）
 *
 * 【失効までの時間】
 *   Stripe は「作成から30分〜24時間」しか受け付けない（公式仕様）。
 *   Founder は枠を押さえたまま待たせるので、呼ぶ側が30分を渡す。
 *
 * 外部を呼ばない純粋な組み立てなので、単体試験で中身を確かめられる。
 */
export function buildCheckoutSessionForm(
  input: {
    purchaseId: string;
    profileId: string;
    offerCode: string;
    productName: string;
    amount: number;
    currency: string;
    customerId: string;
    successUrl: string;
    cancelUrl: string;
    expiresInSeconds: number;
  },
  nowSeconds: number,
): FormShape {
  return {
    mode: "payment",
    // **Stripe が販売者になる仕組みを、この決済ページでは使わない**（上の説明）
    managed_payments: { enabled: false },
    // **支払い方法をここで縛る。**ダッシュボードの設定に任せない。
    // card を指定すると、Checkout の画面では
    // カードに加えて Apple Pay / Google Pay / Link（カードを束ねる財布）が出る。
    // コンビニ払いと PayPay は v0 では扱わない（後払いは
    // 「戻ってきた時点でまだ払われていない」状態を作り、
    // 枠を押さえたまま何日も待つことになるため）。
    payment_method_types: ["card"],
    customer: input.customerId,
    client_reference_id: input.purchaseId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    locale: "ja",
    expires_at: nowSeconds + input.expiresInSeconds,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: input.currency,
          unit_amount: input.amount,
          product_data: { name: input.productName },
        },
      },
    ],
    metadata: {
      purchase_id: input.purchaseId,
      profile_id: input.profileId,
      offer_code: input.offerCode,
    },
  };
}

/* ---------------------------------------------------------------------------
 * 署名の確かめ方
 * ------------------------------------------------------------------------- */

/** 古すぎる知らせを断るまでの猶予。Stripe の公式ライブラリと同じ5分 */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Stripe から来た知らせが本物かを確かめる。
 *
 * 【Stripe が公開している手順（2026-09-09 に取得）】
 *   1. Stripe-Signature ヘッダーを `,` で区切り、さらに `=` で区切って
 *      `t`（時刻）と `v1`（署名）を取り出す。**v1 以外の仕組みは無視する**
 *      （古い仕組みへ引きずり下ろされないようにするため）。
 *   2. 「時刻」＋「.」＋「本文そのもの」をつなげた文字列を作る。
 *   3. 署名の鍵を鍵として、その文字列の HMAC-SHA256 を計算する。
 *   4. ヘッダーの署名と突き合わせる。合っていたら、時刻が近いことも確かめる。
 *
 * 【本文はそのままでなければならない】
 *   JSON として読み直したものを渡すと、空白や並び順が変わって必ず失敗する。
 *   **署名を確かめる前に JSON として読まない。**
 *
 * 【一定の時間で比べる】
 *   1文字ずつ比べて違ったところで打ち切ると、比べるのにかかった時間から
 *   正しい署名を1文字ずつ探り当てられる。長さを揃えてから
 *   timingSafeEqual で比べる。
 *
 * 【鍵の入れ替え中は署名が複数付く】
 *   Stripe は鍵を入れ替えるとき、最大24時間だけ両方の鍵で署名する。
 *   だから v1 は複数ありうる。**どれか1つでも合えば本物。**
 */
export function verifyStripeSignature(input: {
  payload: string;
  header: string | null;
  secret: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): void {
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);

  if (!input.header) {
    throw new Error("SIGNATURE_MISSING: Stripe-Signature ヘッダーがありません。");
  }
  if (input.secret === "") {
    throw new Error("SIGNATURE_SECRET_MISSING: 署名を確かめる鍵が設定されていません。");
  }

  let timestamp: string | null = null;
  const signatures: string[] = [];

  for (const part of input.header.split(",")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const val = part.slice(at + 1).trim();

    if (key === "t") timestamp = val;
    // **v1 以外は捨てる。**v0 は試験用の偽の署名
    else if (key === "v1") signatures.push(val);
  }

  if (timestamp === null || !/^\d+$/.test(timestamp) || signatures.length === 0) {
    throw new Error("SIGNATURE_MALFORMED: 署名の形が違います。");
  }

  const expected = createHmac("sha256", input.secret)
    .update(`${timestamp}.${input.payload}`, "utf8")
    .digest("hex");

  const expectedBuf = Buffer.from(expected, "utf8");
  const matched = signatures.some((given) => {
    const givenBuf = Buffer.from(given, "utf8");
    if (givenBuf.length !== expectedBuf.length) return false;
    return timingSafeEqual(givenBuf, expectedBuf);
  });

  if (!matched) {
    throw new Error("SIGNATURE_INVALID: 署名が一致しません。");
  }

  // 署名が合ってから時刻を見る。**署名の合っていないものの時刻は意味が無い**
  const age = Math.abs(now - Number(timestamp));
  if (age > tolerance) {
    throw new Error(
      `SIGNATURE_TOO_OLD: 知らせが古すぎます（${age}秒前／許容 ${tolerance}秒）。`,
    );
  }
}

/* ---------------------------------------------------------------------------
 * 受け取った知らせの形
 * ------------------------------------------------------------------------- */

export type StripeEvent = {
  id: string;
  type: string;
  livemode: boolean;
  created: number | null;
  /** Stripe がこの知らせを組み立てた API の版。受け口の登録時に決まる */
  apiVersion: string | null;
  object: Record<string, unknown>;
};

/**
 * 署名を確かめたあとの本文を、扱いやすい形にする。
 *
 * **ここで初めて JSON として読む。**確かめる前には読まない。
 */
export function parseStripeEvent(payload: string): StripeEvent {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(payload) as Record<string, unknown>;
  } catch {
    throw new Error("EVENT_MALFORMED: 知らせの中身を読めませんでした。");
  }

  const id = json.id;
  const type = json.type;
  if (typeof id !== "string" || typeof type !== "string") {
    throw new Error("EVENT_MALFORMED: 知らせに ID か種類がありません。");
  }

  const data = (json.data ?? {}) as Record<string, unknown>;
  const object = (data.object ?? {}) as Record<string, unknown>;

  return {
    id,
    type,
    livemode: json.livemode === true,
    created: typeof json.created === "number" ? json.created : null,
    apiVersion: typeof json.api_version === "string" ? json.api_version : null,
    object,
  };
}
