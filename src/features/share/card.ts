/**
 * 共有カードの「唯一の定義」。
 *
 * 【なぜ1ファイルに集めるか】
 *   下見（共有モーダルの中の縮小表示）と、SNS が取りに行く本番の画像を
 *   **別々に作らない**（利用者の指示 9）。別々に作ると、片方を直したときに
 *   もう片方が取り残され、見たものと流れたものが違うという、
 *   いちばん気づきにくいずれ方をする。
 *
 * 【どうやって一致を保証しているか】
 *   下見は「本番と同じ絵」を作り直すのではなく、**本番の画像そのものを
 *   縮めて出す。**共有モーダルの中の <img> が指しているのは、
 *   SNS のクローラーが取りに来るのと同じ /api/og/work/[id] である。
 *   だから一致するかどうかを議論する余地が無い。同じ1枚を見ている。
 *
 *   このファイルが持つのは、その1枚を描くときの寸法と文言だけ。
 *   描く場所は src/app/api/og/work/[id]/route.tsx の1か所しかない。
 *
 * 【このファイルは DB にもブラウザにもつながらない】
 *   受け取った値から寸法と文字列を決めるだけ。だから単体試験で
 *   そのまま呼べる（test/unit/run.mjs）。
 */

/* ===========================================================================
 * 大きさ
 * =========================================================================== */

/**
 * カードの大きさ。1200×630（利用者の指示 2）。
 *
 * X のリンクカード（summary_large_image）が求める縦横比 2:1 に近く、
 * 既存の作品カード・プロフィールカードとも同じ寸法。
 */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

/**
 * 角の丸み。**既存の面と同じ値を使う**（利用者の指示 2）。
 *
 * 出所: src/app/_surface.ts の `surface` が `rounded-2xl`。
 * Tailwind v4 の 2xl は 1rem ＝ 16px。ここだけ別の値にしない。
 */
export const CARD_RADIUS = 16;

/**
 * 文字を置くための左右の余白。
 *
 * 出所: src/app/_surface.ts の `surface` が `p-6`（24px）。
 * 1200px 幅ではそのままだと端に寄りすぎるので、2倍の 48px を使う。
 * **新しい刻みを作らず、既存の値の整数倍にとどめる。**
 */
export const CARD_PAD_X = 48;
export const CARD_PAD_BOTTOM = 44;
export const CARD_PAD_TOP = 36;

/**
 * 文字領域の高さ。カード下部25%（利用者の指示 2）。
 *
 * 630 × 0.25 = 157.5 → 158px。ここに問題文・CTA・投稿者が入る。
 */
export const TEXT_AREA_RATIO = 0.25;
export const TEXT_AREA_HEIGHT = Math.round(CARD_HEIGHT * TEXT_AREA_RATIO);

/**
 * 暗くする帯の始まり（カードの上からの割合）。
 *
 * **黒い矩形を敷かない**（利用者の指示 2）。文字領域は下25%だが、
 * 暗さの変化はその倍の高さをかけて作る。境目が直線に見えると、
 * 絵の上に板を置いたように見えて「まず作品を見る」が壊れる。
 */
export const SCRIM_START_RATIO = 0.5;

/** 帯のいちばん下の暗さ。文字が読めるだけの濃さにとどめる */
export const SCRIM_MAX_ALPHA = 0.88;

/* ===========================================================================
 * 文字の大きさ
 * ===========================================================================
 *
 * 【大きさは固定。長い文でも縮めない】（利用者の指示 3 / 39）
 *   縮めると、SNS の一覧で縮小されたときに読めなくなる。
 *   長すぎるものは縮めるのではなく、2行で切って「…」を付ける。
 *
 * 【作品より主張させない】
 *   問題文はいちばん大きいが、カードの面積の大半は絵のまま。
 *   ブランド名は問題文より小さく、投稿者はさらに小さい。
 */

/** 問題文。カードでいちばん大きい文字 */
export const QUESTION_FONT_SIZE = 52;
export const QUESTION_LINE_HEIGHT = 1.35;

/** 「タップして答える」。問題文より明確に小さい（利用者の指示 3） */
export const CTA_FONT_SIZE = 28;

/** 投稿者の表示名。CTA よりさらに一段小さい（利用者の指示 3） */
export const AUTHOR_FONT_SIZE = 22;

/** 左上のブランド名。問題文より大きくしない（利用者の指示 3） */
export const BRAND_FONT_SIZE = 26;

/** 「AI」の札。ブランド名の隣に小さく置く（利用者の指示 6） */
export const AI_BADGE_FONT_SIZE = 18;

/* ===========================================================================
 * 文言
 * ===========================================================================
 *
 * 画面に出る言葉をここに集める。共有モーダルも OG 画像も同じ定数を読む。
 */

export const BRAND_TEXT = "つたわるかな";
export const CTA_TEXT = "タップして答える";
export const AI_BADGE_TEXT = "AI";

/** 公開されていない作品のカードに出す2行（利用者の指示 25） */
export const UNAVAILABLE_TEXT = "この作品は現在公開されていません";

/**
 * ぼかして出す作品のカードに出す文（利用者の指示 7）。
 *
 * **いまのこのサービスに、この状態の作品は1件も無い。**
 * 作品の表は「運営が伏せた（review_status が ok でない）」という
 * 0か1の区分しか持っておらず、伏せた作品はそもそも公開の照会に
 * 引っかからない＝上の「公開されていません」のカードになる。
 * 段階的な閲覧注意の区分ができたときに、ここが使われる。
 */
export const SENSITIVE_TEXT = "センシティブな作品が含まれています";
export const SENSITIVE_CTA_TEXT = "タップして表示・回答";

/** ぼかしの強さ（px）。絵の題材が分からなくなる程度にかける */
export const SENSITIVE_BLUR_PX = 48;
/** ぼかしの上に重ねる暗幕の濃さ */
export const SENSITIVE_VEIL_ALPHA = 0.55;

/* ===========================================================================
 * 色
 * ===========================================================================
 *
 * 【globals.css のトークンを使わない理由】
 *   共有カードは PNG であって画面ではない。明るい設定・暗い設定という
 *   概念が無く、乗るのは投稿された絵の上である。
 *   既にある2枚の共有カード（作品・プロフィール）も同じ理由で
 *   ファイルの中に値を直接書いている（src/app/works/[id]/opengraph-image.tsx）。
 *
 *   考え方は globals.css の --glass / --glass-ink と同じ。
 *   「絵の上に乗るものは、こちらの配色設定で切り替えない」。
 */

/** 絵が届く前・絵の外側の地。暗いほうに寄せる（明るい絵でも縁が締まる） */
export const CARD_BG = "#0b0b0d";
/** 絵の上の文字。白 */
export const CARD_INK = "#ffffff";
/** 弱い文字（投稿者・ブランド）。白の薄いほう */
export const CARD_INK_SOFT = "rgba(255,255,255,0.82)";

/**
 * 文字の縁取りと影（利用者の指示 2「控えめな縁取り／影」）。
 *
 * 明るい絵の上でも読めるだけの影を付ける。縁取りは**細く**する。
 * 太くすると文字が図形になり、作品より主張してしまう。
 */
export const QUESTION_SHADOW = "0 2px 10px rgba(0,0,0,0.70)";
export const QUESTION_STROKE = "1px rgba(0,0,0,0.30)";
export const SOFT_SHADOW = "0 1px 6px rgba(0,0,0,0.65)";

/** カードの型の版。大きく変えたら上げる（利用者の指示 26） */
export const TEMPLATE_VERSION = 1;

/* ===========================================================================
 * 絵の切り取り方
 * =========================================================================== */

/**
 * 1200×630 の枠に絵を入れるとき、どこを見せるか。
 *
 * 【新しい切り取りの設定を作らない】（利用者の指示 2 / 39）
 *   このサービスは作品ごとの切り取り位置を1つも保存していない。
 *   一覧も詳細も、そのつど縦横比から決めている。共有カードも同じにする。
 *
 * 【既にある決まりをそのまま延ばす】
 *   一覧の決まりは src/features/feed/layout.ts にあり、
 *   「限界を超えて切ることになったカードは、上端から見せる（下を切る）」。
 *   共有カードの枠は横長（630 / 1200 = 0.525）なので、
 *   それより縦長の絵は必ず切ることになる。そこで上端から見せる。
 *   横長の絵は左右が余るので中央に寄せる。
 *
 * 返すのは CSS の object-position に渡す文字列。
 */
export const CARD_ASPECT = CARD_HEIGHT / CARD_WIDTH;

export function cardObjectPosition(width: number, height: number): "top" | "center" {
  if (!(width > 0) || !(height > 0)) return "center";
  return height / width > CARD_ASPECT ? "top" : "center";
}

/* ===========================================================================
 * 問題文
 * =========================================================================== */

/**
 * 問いの文。**画面に出ているのと同じ言い回しにする。**
 *
 * 回答画面は「3. モーフ はどれ？」と出す
 * （src/app/works/[id]/_quiz.tsx の legend）。共有カードでは
 * 何問目かに意味が無いので番号だけ落とす。
 *
 * 同じ文字列を DB 側の ensure_share_card_revision も作っている
 * （控えに残すため）。**2か所にあるので、片方を変えたら両方変える。**
 * 変わったことは共有カードの控えの単体試験が拾う。
 */
export function questionText(cardSlotLabel: string): string {
  return `${cardSlotLabel} はどれ？`;
}

/**
 * 文字の見かけの幅を見積もる（1文字あたり、文字の大きさに対する倍率）。
 *
 * 【なぜ自分で数えるのか】
 *   「2行を超えたら末尾を…にする」を、字の大きさを変えずに行うため
 *   （利用者の指示 3）。折り返しを描画側まかせにすると、3行目が
 *   出たのか出ていないのかが、こちら側で分からない。
 *
 * 【正確である必要はない。足りていればよい】
 *   全角は1文字ぶん、半角は約0.55文字ぶんとして数える。
 *   実際の字送りより**広めに**見積もるので、入ると判定したものは必ず入る。
 */
function charWidthRatio(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;

  // 半角の英数字・記号・空白
  if (code <= 0x00ff) return 0.55;
  // 半角カナ
  if (code >= 0xff61 && code <= 0xff9f) return 0.55;
  // それ以外（かな・漢字・全角記号・絵文字）は全角として数える
  return 1;
}

/** 文字列の見かけの幅（px） */
export function measureText(text: string, fontSize: number): number {
  let total = 0;
  for (const ch of text) total += charWidthRatio(ch) * fontSize;
  return total;
}

/**
 * 問題文を最大2行に割る。入り切らなければ末尾を「…」にする。
 *
 * 【字を小さくしない】（利用者の指示 3 / 39）
 *   長いからといって縮めない。縮めると、SNS の一覧で縮んだときに
 *   長い問いだけ読めなくなる。行数で止める。
 *
 * 【どこで折るか】
 *   日本語はどこでも折れるので、幅に入るところまで詰めて折る。
 *   ただし半角の連なり（英単語や URL）の途中では折らない。
 */
export function wrapQuestion(
  text: string,
  maxWidth: number = CARD_WIDTH - CARD_PAD_X * 2,
  fontSize: number = QUESTION_FONT_SIZE,
  maxLines: number = 2,
): string[] {
  const src = text.trim();
  if (src === "") return [];

  const chars = [...src];
  const lines: string[] = [];
  let line = "";

  const fits = (s: string) => measureText(s, fontSize) <= maxWidth;

  for (let i = 0; i < chars.length; i += 1) {
    const next = line + chars[i];

    if (fits(next)) {
      line = next;
      continue;
    }

    // 入らない。ここで行を閉じる。
    // ただし半角の連なりの途中なら、その連なりの手前まで戻す
    let cut = line;
    let carry = "";
    if (charWidthRatio(chars[i]) < 1) {
      const m = /[ -ÿ｡-ﾟ]+$/.exec(line);
      if (m && m[0].length < line.length && !/^\s+$/.test(m[0])) {
        cut = line.slice(0, line.length - m[0].length);
        carry = m[0];
      }
    }

    lines.push(cut.trimEnd());
    line = (carry + chars[i]).trimStart();

    if (lines.length === maxLines) {
      // 最終行はもう閉じている。あふれたぶんを「…」にまとめる
      const last = lines[maxLines - 1];
      lines[maxLines - 1] = ellipsize(last, maxWidth, fontSize);
      return lines;
    }
  }

  if (line !== "") lines.push(line.trimEnd());
  return lines.slice(0, maxLines);
}

/** 行の末尾を削って「…」を付ける。「…」ごと幅に収める */
function ellipsize(line: string, maxWidth: number, fontSize: number): string {
  const ell = "…";
  if (measureText(line + ell, fontSize) <= maxWidth) return line + ell;

  const chars = [...line];
  while (chars.length > 0) {
    chars.pop();
    const candidate = chars.join("") + ell;
    if (measureText(candidate, fontSize) <= maxWidth) return candidate;
  }
  return ell;
}

/* ===========================================================================
 * SNS へ渡す本文
 * =========================================================================== */

/**
 * X と Bluesky の投稿画面に入れる本文（利用者の指示 11）。
 *
 * **入れるのは問題文と共有URLだけ。**
 * サービスの紹介文も、自動のハッシュタグも1つも付けない。
 *
 * X は本文と URL を別々の欄で受け取れるが、Bluesky は本文の欄しか無い
 * （公式の intent の説明に text しか載っていない）。**同じ言葉にする**ため、
 * どちらも「問題文 改行 URL」の1本の文字列を作り、
 * X へは text と url に分けて渡す。
 */
export function shareText(questionLine: string | null): string {
  return questionLine && questionLine.trim() !== "" ? questionLine.trim() : BRAND_TEXT;
}

/**
 * X の投稿画面のURL。
 *
 * 出所: https://docs.x.com/x-for-websites/web-intents/overview が示す
 * 現行の入口は x.com/intent/tweet（twitter.com/intent/tweet は 301 で
 * ここへ来る。実測 2026-09-18）。
 */
export function xIntentUrl(questionLine: string | null, url: string): string {
  const text = encodeURIComponent(shareText(questionLine));
  return `https://x.com/intent/tweet?text=${text}&url=${encodeURIComponent(url)}`;
}

/**
 * Bluesky の投稿画面のURL。
 *
 * 出所: https://docs.bsky.app/docs/advanced-guides/intent-links。
 * 受け取るのは text だけなので、URL も本文に入れる。
 */
export function blueskyIntentUrl(questionLine: string | null, url: string): string {
  const body = `${shareText(questionLine)}\n${url}`;
  return `https://bsky.app/intent/compose?text=${encodeURIComponent(body)}`;
}

/* ===========================================================================
 * 共有URL
 * ===========================================================================
 *
 * 【作品ページを複製しない】（利用者の指示 13 / 39）
 *   共有用の別ページは作らない。既にある作品のURLに、
 *   どの問いを開くか・共有から来たか・どの共有からか を足すだけ。
 *
 *   ?question=<問のID>&src=share&sid=<共有ID>
 *
 *   既存の作品ページには ?q=1 という別の印がある（一覧のカードから
 *   来たときにクイズを先に出す）。**そちらとは意味が違うので名前を分ける。**
 *   src=share が付いていれば、q=1 と同じ並べ替えが働く。
 */
export const SHARE_PARAM_QUESTION = "question";
export const SHARE_PARAM_SOURCE = "src";
export const SHARE_PARAM_SHARE_ID = "sid";
export const SHARE_SOURCE_VALUE = "share";

export function shareUrl(
  siteUrl: string,
  workId: string,
  questionId: number | null,
  shareId: string | null,
): string {
  const params = new URLSearchParams();
  if (questionId !== null) params.set(SHARE_PARAM_QUESTION, String(questionId));
  params.set(SHARE_PARAM_SOURCE, SHARE_SOURCE_VALUE);
  if (shareId !== null) params.set(SHARE_PARAM_SHARE_ID, shareId);

  const query = params.toString();
  return `${siteUrl}/works/${workId}${query === "" ? "" : `?${query}`}`;
}

/**
 * 共有カードの画像のURL。
 *
 * **下見も本番もこの1本を指す。**下見は共有IDをまだ持たないので
 * 付けずに呼び、SNS が取りに来るときだけ共有IDが付く。
 * 付いていれば、その共有をした時点の中身で描かれる。
 */
export function shareCardImageUrl(
  workId: string,
  questionId: number | null,
  shareId: string | null,
): string {
  const params = new URLSearchParams();
  if (questionId !== null) params.set("q", String(questionId));
  if (shareId !== null) params.set("sid", shareId);

  const query = params.toString();
  return `/api/og/work/${workId}${query === "" ? "" : `?${query}`}`;
}

/* ===========================================================================
 * OG の見出しと説明（利用者の指示 12）
 * =========================================================================== */

/** 「{問題文}｜つたわるかな」。問いが無いときは null（通常の共有へ落とす） */
export function shareOgTitle(questionLine: string | null): string | null {
  if (!questionLine || questionLine.trim() === "") return null;
  return `${questionLine.trim()}｜${BRAND_TEXT}`;
}

/** 問い付きの共有の説明文 */
export const SHARE_OG_DESCRIPTION = CTA_TEXT;

/* ===========================================================================
 * クローラーの見分け方（利用者の指示 34）
 * ===========================================================================
 *
 * 【これは計測のためだけの判定】
 *   見せる・見せないの判断には1度も使わない。使うのは
 *   「共有カードを取りに来ただけ」を人の流入として数えないため。
 *
 * 【本当の守りは JavaScript のほう】
 *   流入を記録するのはブラウザで画面が描かれたあとなので、
 *   JavaScript を動かさないクローラーはそもそもここへ来ない。
 *   この一覧は、その上に重ねる2枚目の網。
 *
 * 【並び順に意味がある】
 *   LINE の名乗りには facebookexternalhit が含まれ、
 *   Telegram の名乗りには TwitterBot が含まれる。
 *   先に細かいほうを見ないと、取り違える。
 */
const CRAWLER_MARKS = [
  "line-poker",
  "telegrambot",
  "twitterbot",
  "facebookexternalhit",
  "meta-external",
  "meta-webindexer",
  "slackbot",
  "slack-imgproxy",
  "discordbot",
  "cardyb",
  "mastodon/",
  "bot",
  "crawler",
  "spider",
];

export function isCrawlerUserAgent(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  const ua = userAgent.toLowerCase();
  return CRAWLER_MARKS.some((m) => ua.includes(m));
}

/* ===========================================================================
 * カードに何を載せるかの決め
 * ===========================================================================
 *
 * 【なぜ絵を描く側から切り出すか】
 *   「匿名なら作者欄そのものを出さない」「ぼかす作品では文言が変わる」は
 *   **絵にしないと確かめられない**形で書くと、目で見るしかなくなる。
 *   載せる・載せないの判断だけをここへ出せば、単体試験でそのまま呼べる。
 *
 *   絵を描く側（src/app/api/og/work/[id]/route.tsx）は、この結果を
 *   並べるだけにする。判断を2か所に書かない。
 */

/** カードに載せるものが決まった形 */
export type ShareCardParts = {
  /** ぼかす作品にだけ出る見出し。ふだんは null */
  headline: string | null;
  /** 問題文。最大2行。問いが無ければ空 */
  lines: string[];
  /** 「タップして答える」か、ぼかす作品用の文言 */
  cta: string;
  /** 投稿者の表示名。**出さないときは null**（「匿名」とも書かない） */
  authorLine: string | null;
  /** 「AI」の札を出すか */
  showAi: boolean;
  /** 絵をぼかすか。0 ならぼかさない */
  blurPx: number;
  /** 絵の見せ方（object-position に渡す値） */
  objectPosition: "top" | "center";
};

/**
 * カードに載せるものを決める。
 *
 * 受け取るのは get_share_card がそのまま返した形。
 * **ここで DB も画像も触らない。**値から値を決めるだけ。
 */
export function shareCardParts(source: {
  question_text: string | null;
  author_name: string | null;
  anonymous: boolean;
  ai: boolean;
  sensitive: boolean;
  image_width: number;
  image_height: number;
}): ShareCardParts {
  const sensitive = source.sensitive === true;

  return {
    headline: sensitive ? SENSITIVE_TEXT : null,
    // ぼかす作品でも問いは出す（利用者の指示 7 が「問題文」を挙げている）
    lines: source.question_text ? wrapQuestion(source.question_text) : [],
    cta: sensitive ? SENSITIVE_CTA_TEXT : CTA_TEXT,
    // 匿名なら欄そのものを消す。代わりの表示も置かない（利用者の指示 5）
    authorLine: source.anonymous || !source.author_name ? null : source.author_name,
    showAi: source.ai === true,
    blurPx: sensitive ? SENSITIVE_BLUR_PX : 0,
    objectPosition: cardObjectPosition(source.image_width, source.image_height),
  };
}
