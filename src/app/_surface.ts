/**
 * 画面の「面」と「部品」の寸法。**色はここに書かない。**
 *
 * 【この2つを分けている理由】
 *   色（何色か）は `globals.css` に、寸法（角の丸み・余白・枠の太さ）はここに置く。
 *   `globals.css` の側は機械が見張っていて（`npm run check:contrast`）、
 *   画面のファイルに生の色を書くと落ちる。ここに出てくる `bg-accent` や
 *   `border-line-firm` は色そのものではなく、**globals.css が決めた名前**である。
 *
 * 【なぜ1か所に集めるか】
 *   同じ文字列が画面のあちこちにコピーされていると、
 *   角の丸みを1回試すのに数十箇所の置換が要る。
 *   **試して、違ったら戻す**ができないと、一度置いた見た目がそのまま確定する。
 *   デザインの自由は、やり直しの安さと同じもの。
 */

/**
 * カード1枚ぶんの面。
 *
 * もとはこの文字列が 15 のファイルに同じ内容でコピーされていた。
 */
export const surface = "rounded-2xl border border-line bg-surface p-6";

/**
 * 入力欄1つぶん。文字を打ち込む部品（input / select / textarea）に使う。
 *
 * 【枠線だけ濃い理由】
 *   もとはカードの縁と同じ薄さ（15%・約 1.4:1）だった。
 *   **枠がほぼ見えず、どこが入力欄か分からなかった。**
 *   WCAG 1.4.11 は「部品だと分かるために必要な輪郭」に 3:1 を求めるので、
 *   `border-field`（45%・3.35:1）を当てている。
 *
 *   ボタンやタブの枠は `border-line-mid` のまま。中の文字で部品だと
 *   分かるので、輪郭がその役目を負っていない。
 */
export const field =
  "w-full rounded-xl border border-field bg-transparent px-4 py-3 text-sm";

/* ===========================================================================
 * ボタン
 * ===========================================================================
 *
 * 【集めるまでの状態】
 *   押しボタンの見た目は 27 箇所に直接書かれていた。役目は4種類しかないのに、
 *   横の余白が px-5 / px-6 / px-8 の3通り、縦が py-3 / py-4 の2通りに割れていた。
 *   **これは設計ではなく、書くたびに少しずつずれた結果。**
 *   利用者から見ると、同じ重さのボタンがページによって違う大きさで出ていた。
 *
 * 【寸法を1つに決めた】
 *   `px-6 py-3` に揃える。文字が 14px（行の高さ 20px）なので
 *   上下の余白 12px と合わせて **高さ 44px** になる。
 *   これは指で押す領域の下限としてよく使われる値で、
 *   揃えること自体が「押しやすさの下限」を満たすことになる。
 *
 * 【幅と並びは呼ぶ側が足す】
 *   `w-full` `flex-1` `inline-block` は場所ごとに違うので、ここには入れない。
 *   ここが持つのは「ボタンに見えること」だけ。
 *
 * 【押した反応はここに無い】
 *   送信中の表示・二度押しの防止・押し込みの動きは `_pending.tsx` の
 *   SubmitButton / NavButton が持っている。**見た目と挙動を混ぜない。**
 */

/** 4種類が共有する形。ここを変えると全部のボタンが変わる */
const btnShape = "rounded-xl px-6 py-3 text-sm";

/**
 * 主ボタン。ベタ塗り。**1つの画面に1つだけ置く。**
 * その画面で「次に進む」操作がどれかを、色の面積で示す役目。
 */
export const btnPrimary = `${btnShape} font-bold bg-accent text-on-accent hover:opacity-85`;

/** 副ボタン。枠線だけ。主ボタンの隣に並ぶ「そうしない側」 */
export const btnSecondary = `${btnShape} font-bold border border-line-firm hover:bg-hover`;

/**
 * 取り消せない操作のボタン（退会・削除）。
 * 主ボタンと同じ形で色だけ変える。**形を変えない**のは、
 * 危険な操作だけ別の作法にすると、押し間違いではなく戸惑いが増えるため。
 */
export const btnDanger = `${btnShape} font-bold bg-danger-solid text-on-danger hover:opacity-85`;

/**
 * いちばん弱いボタン（「このドラフトを捨てる」など）。
 * 塗りも枠も持たない。太字にもしない。
 * **押せることは分かるが、目を引かない**のが役目。
 */
export const btnQuiet = `${btnShape} text-faint hover:text-muted`;

/**
 * 押すと入り／切りが入れ替わるボタン（いいね・保存）。
 *
 * 【なぜ副ボタンと分けるか】
 *   副ボタンは「押すと次へ進む」。こちらは**押しても画面が変わらず、
 *   自分の状態だけが反転する。**同じ形にすると、押した先が違うのに
 *   同じものに見える。枠の濃さで入り／切りを示すので、
 *   枠の色を副ボタンと共有できないという事情もある。
 *
 * 【色だけで状態を出していない】
 *   入りのときは枠が濃くなるうえに地も付く（`bg-hover`）。
 *   さらにボタンの文字自体が「いいね済み」のように変わる。
 */
export const btnToggle = `${btnShape} font-bold border transition hover:bg-hover`;

/** 入っているとき（すでに いいね／保存 してある） */
export const btnToggleOn = "border-line-active bg-hover";

/** 切れているとき */
export const btnToggleOff = "border-line-mid";

/* ===========================================================================
 * タブ（一覧の切り替え）
 * ===========================================================================
 *
 * 主ボタンと同じ色を使うが、**別の部品として持つ**。
 * タブは「いまどこを見ているか」の表示であって、次に進む操作ではない。
 * 同じ定数にすると、片方を変えたときにもう片方が巻き添えになる。
 *
 * 【いま満たしていないもの】
 *   高さが 12px + 上下 8px = **32px** で、指で押す領域の下限 44px に届かない。
 *   ここを `py-2` から上げれば全タブに効くが、行の高さが変わるので
 *   見た目を決める段でまとめて扱う。
 */
const tabShape = "rounded-full px-4 py-2 text-xs font-bold";

/** いま見ているタブ */
export const tabOn = `${tabShape} bg-accent text-on-accent`;

/** それ以外のタブ。押すと切り替わる */
export const tabOff = `${tabShape} border border-line-mid hover:bg-hover`;

/* ===========================================================================
 * 帯（画面の上に出る短い知らせ）
 * ===========================================================================
 *
 * ボタンではないが、同じ理由でここに置く。
 * エラーの帯は 7 箇所、成功の帯は 3 箇所、注記の帯は 3 箇所に
 * 同じ文字列でコピーされていた。
 *
 * `whitespace-pre-wrap` が入っているのは、サーバーから来る文が
 * 改行を含むことがあるため（改行を捨てると1行に潰れて読めなくなる）。
 */

/** 失敗の知らせ。操作が通らなかったときに出る */
export const noticeError =
  "rounded-xl bg-danger-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-danger";

/** 成功の知らせ。操作が通ったあと、移った先の画面で出る */
export const noticeSuccess =
  "rounded-xl bg-success-tint/10 px-4 py-3 text-sm whitespace-pre-wrap text-success";

/** ただの補足。良し悪しを含まない（「AI生成の作品です」など） */
export const noticeMuted = "rounded-xl bg-sunken px-4 py-3 text-xs text-faint";
