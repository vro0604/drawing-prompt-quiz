/**
 * 課金の型と、画面が使う言葉。**このファイルはサーバー・ブラウザ両方から読める。**
 * 秘密の値は1つも持たない（型と定数だけ）。
 */

/** いま売っている唯一の商品 */
export const FOUNDER_OFFER_CODE = "founding_creator_v0";

/** 決済ページを開いたまま枠を押さえておく時間。Stripe が許す最短が30分 */
export const CHECKOUT_EXPIRES_IN_SECONDS = 30 * 60;

/**
 * 使う Stripe の API の版。**ここが唯一の決めどころ。**
 *
 * 【なぜ固定するか】
 *   固定しないと、Stripe の口座の既定の版が使われる。既定は Stripe 側の
 *   画面から誰でも変えられて、変わった瞬間に返ってくる項目の名前や形が変わる。
 *   **公式のライブラリを入れていない以上、こちらで版を握らないと、
 *   ある日とつぜん決済ページの作成が失敗する。**
 *
 * 【どこで効くか（3か所で同じ値であること）】
 *   1. こちらから呼ぶとき … Stripe-Version ヘッダーに載せる（stripe.ts）
 *   2. 知らせを受けるとき … Stripe 側で受け口を作るときに、この版を選ぶ。
 *      届いた知らせの api_version は billing_webhook_events に残る
 *   3. 記録 … .env.example と docs/decisions.md（D187）に同じ文字列を書く
 *
 * 【上げ方】
 *   Stripe の変更履歴を読んでから、この定数と受け口の版を同時に変える。
 *   **片方だけ変えない。**送る版と受ける版がずれると、
 *   金額や状態の見え方が食い違う。
 *
 * 出所: https://docs.stripe.com/api/versioning （2026-09-09 取得。当時の最新）
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia";

/**
 * 購入1件の状態。DB の CHECK と同じ8つ。
 * 増やすときは migration と両方を直す。
 */
export type PurchaseStatus =
  | "reserved"
  | "paid"
  | "refund_pending"
  | "refunded"
  | "expired"
  | "void"
  | "disputed"
  | "reversed";

/** 権利が生きていると見なす状態 */
const LIVE: PurchaseStatus[] = ["paid", "refund_pending", "disputed"];

/** その状態の人は、いま Founder か */
export function isLiveFounder(status: PurchaseStatus | null | undefined): boolean {
  return status !== null && status !== undefined && LIVE.includes(status);
}

/** 自分の購入について、画面が知ってよいことだけ */
export type MyPurchase = {
  status: PurchaseStatus;
  founder_number: number | null;
  founder_public: boolean;
  /** 決済ページを開いたまま、まだ払い終えていない */
  has_open_checkout: boolean;
  checkout_expires_at: string | null;
  paid_at: string | null;
};

/** 購入ページが必要とするものの全部 */
export type FounderOfferStatus = {
  code: string;
  name: string;
  amount: number;
  currency: string;
  sales_cap: number | null;
  used: number;
  remaining: number | null;
  sold_out: boolean;
  is_open: boolean;
  starts_at: string | null;
  ends_at: string | null;
  signed_in: boolean;
  /** いま有効な利用規約の版。同意の form に載せる */
  terms_version: string | null;
  /** いま有効なプライバシーポリシーの版 */
  privacy_version: string | null;
  /** この人が、上の2つの版に同意し終えているか（規約 13-6） */
  agreed: boolean;
  mine: MyPurchase | null;
};

/**
 * 一覧の1行。3つの見え方しかない。
 *   public    … 名前を出してよい
 *   anonymous … 匿名希望（本人が非公開にしている／退会して名前が引けない）
 *   void      … 欠番（返金・申し立てで取り消し）
 */
export type FounderRowKind = "public" | "anonymous" | "void";

export type FounderRow = {
  founder_number: number;
  kind: FounderRowKind;
  display_name: string | null;
  handle: string | null;
};

/** プロフィールに出す番号。公開設定が入で、権利が生きているときだけ返る */
export type FounderBadge = {
  founder_number: number;
  offer_code: string;
};

/** 「何ができるか」の鍵。商品名ではなくこれで判定する */
export type EntitlementKey = "founding_creator" | "beta_access";

/** #001 の形にそろえる。3桁に満たなければ0で埋める */
export function founderLabel(n: number): string {
  return `#${String(n).padStart(3, "0")}`;
}

/** 一覧の1行を、画面に出す文字列にする */
export function founderRowText(row: FounderRow): string {
  if (row.kind === "void") return "欠番";
  if (row.kind === "anonymous") return "匿名希望";
  return row.display_name ?? "匿名希望";
}

/**
 * 購入の状態を、利用者に通じる短い言葉にする。
 * **内部の言葉（reserved / disputed）を画面へ出さないため。**
 */
export function purchaseStatusText(status: PurchaseStatus): string {
  switch (status) {
    case "reserved":
      return "お支払いの手続き中です";
    case "paid":
      return "ご購入ありがとうございます";
    case "refund_pending":
      return "返金の手続き中です";
    case "refunded":
      return "返金が完了しています";
    case "expired":
      return "お支払いの手続きが期限切れになりました";
    case "void":
      return "この購入は取り消されています";
    case "disputed":
      return "お支払いについて確認中です";
    case "reversed":
      return "お支払いが取り消されました";
  }
}

/**
 * 課金の migration がまだ当たっていない DB から返るエラーか。
 *
 * 【なぜ要るか】
 *   課金のコードは、課金の migration より先に本番へ出ることがある
 *   （2026-09-17 に main へ取り込んだ時点で、本番の DB には課金の関数が無い）。
 *   そのとき PostgREST は関数を見つけられず、HTTP 404・コード PGRST202 を返す
 *   （2026-09-17 に本番へ読むだけの呼び出しをして実測）。
 *
 *   /founder と /tokushoho は「商品が読めない＝準備中」を出す分岐を持っているが、
 *   読み出しがこのエラーで例外を投げると、その分岐へ届かずエラー画面になる。
 *
 * 【これ以外のエラーは握りつぶさない】
 *   見るのは PGRST202 だけ。権限の拒否や通信の失敗は、今までどおり例外にする。
 */
export function isBillingNotInstalled(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === "PGRST202";
}
