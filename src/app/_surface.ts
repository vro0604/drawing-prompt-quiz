/**
 * カード1枚ぶんの面。
 *
 * 【なぜ1か所に置いたか】
 *   この文字列は 15 のファイルに同じ内容でコピーされていた。
 *   角の丸みや余白を変えたいとき 15 箇所を直すことになり、
 *   **試して、違ったら戻す**ができない。
 *
 *   このプロジェクトはビジネスロジックを DB の関数に集めている
 *   （権限を1か所に集めるため）のに、見た目だけ真逆の分散をしていた。
 *
 * 【色はここに書かない】
 *   `border-line` と `bg-surface` は globals.css で決めた名前。
 *   明るいとき／暗いときの値はそちらが持つので、ここには出てこない。
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
