# drawing-prompt-quiz 仕様書

- 仮フォルダ名: `drawing-prompt-quiz`
- 公開サービス名: 未定
- 最終更新: 2026-08-03
- 版: v2（B1/B3/B6確定＋7点修正を反映）

---

## 1. サービス定義

構造化された複数枚の「お題カード」をドラフト形式で引き、CLIP STUDIO / Procreate / 紙などの
外部環境で絵を描いて投稿する。閲覧者は絵だけを見て、元のお題カードのうち3項目を
選択式クイズで推理する。サイト内描画機能は実装しない。

- 描き手の価値: お題が自動で出る / 自分の絵の「伝わり度」が正答率という数値で返ってくる
- 見る側の価値: クイズとして楽しめる / 正解を知ってから絵を見返す面白さ

---

## 2. 確定した仕様判断

| # | 論点 | 決定 |
|---|---|---|
| B1 | モード | MVPは「お手軽（3項目）」「標準（5項目）」の2モードのみ |
| B3 | クイズ問数 | MVPは3問固定 |
| B6 | 匿名ID | Supabase 匿名サインインを採用 |
| B6-a | 昇格 | 匿名 → **新規**通常アカウントへの昇格のみMVPに含める |
| B6-b | 統合 | 匿名 → **既存**アカウントへの履歴統合はMVP後に回す |
| B6-c | CAPTCHA | 公開テスト時に匿名サインインへCAPTCHAを入れる |
| C1 | 制作時間 | カード抽選ではなく、ドラフト開始前のユーザー選択 |
| C2 | データ構造 | タグプールとカードスロットを分離 |
| C3 | 匿名の権限 | いいね・保存・投稿は登録必須。回答・閲覧・共有は匿名可 |
| C4 | 未選択カード | 3条件を満たしたときのみ開示 |
| C5 | リロール | ドラフト全体の引き直しを1回まで |
| C6 | ファンアート | source_title / source_character / fanart_note を追加 |
| C7 | 公開設定 | プロフィールに3つの公開フラグを追加 |

### 2-1. 残っている最小の仮定

| # | 仮定 |
|---|---|
| A1 | 伏せカードの枚数はモードごとに決まる（`draft_modes.candidate_count`）。easy=3 / standard=5 |
| A2 | クイズは**4択×3問**。選択肢数は `candidate_count` とは独立した固定値（D15） |
| A3 | `constraint`（制約）はカードとしては引くが、クイズ対象からは除外する |
| A4 | 1作品につき1ユーザー（匿名ID含む）1回のみ回答できる |
| A5 | 1投稿1画像。複数枚・差分投稿はMVP外 |
| A6 | 通報の処理は手動運用。管理画面は作らない |
| A7 | 投稿削除は論理削除（`deleted_at`）＋Storage画像の削除 |
| A8 | AI部門は自己申告。自動検出はしない |
| A9 | 「他の候補を見る」を押しても、その後の投稿は引き続き可能 |
| A10 | サーバータイマーはMVPで扱わない。**列も持たない** |
| A11 | **1つのお題から作れる作品は最大1件**。作れるのはお題の作成者本人のみ（D17） |

---

## 3. カードシステム

### 3-1. タグプール（tag_pools）

タグの実体を置く場所。**1つのタグは必ず1つのプールにだけ属する。**

| pool_key | 名称 | 例 |
|---|---|---|
| `motif` | モチーフ | 傘 / 鍵 / 機械の翼 / 割れた鏡 / 標本瓶 |
| `color` | 色 | 深い青 / 鮮烈な赤 / 鈍色 / 蛍光緑 / 金 |
| `species` | 種族 | 人間 / 獣人 / 機械 / 精霊 / 竜 |
| `genre` | ジャンル類型 | 変身戦士 / 魔法少女 / 巨大ロボ / 怪獣災害 / 学園異能 / 収集・育成型怪物 |
| `role` | 職業・役割 | 探偵 / 整備士 / 聖職者 / 傭兵 |
| `era` | 時代・環境 | 近未来都市 / 水没都市 / 辺境の村 / 宇宙港 |
| `gender` | 性別・性表現 | 中性的 / 男性的 / 女性的 / 不定 |
| `constraint` | 制約 | 線画のみ / 3色以内 / 正方形構図 / 背景必須 |

### 3-2. カードスロット（card_slots）

お題の「枠」。**どのプールから引くかを指定するだけ**で、タグは持たない。
主キーは `card_slot_key`（text）。数値IDは使わない（D14）。

| card_slot_key | 表示名 | pool_key | quiz_priority | クイズ対象 |
|---|---|---|---|---|
| `motif_a` | モチーフA | `motif` | 1 | ○ |
| `motif_b` | モチーフB | `motif` | 2 | ○ |
| `main_color` | メインカラー | `color` | 3 | ○ |
| `species` | 種族 | `species` | 4 | ○ |
| `genre_type` | ジャンル類型 | `genre` | 5 | ○ |
| `sub_color` | 補助カラー | `color` | 6 | ○ |
| `role` | 職業・役割 | `role` | 7 | ○ |
| `era_env` | 時代・環境 | `era` | 8 | ○ |
| `gender_expr` | 性別・性表現 | `gender` | 9 | ○ |
| `constraint` | 制約 | `constraint` | — | × |

10枠すべてを `card_slots` に登録する（設計の語彙を固定するため）。
そのうちMVPで実際に使うのは、下の `draft_mode_slots` が参照する5枠のみ。

**この分離によって得られること**

- 「傘」というタグを motif_a 用・motif_b 用に二重登録しなくてよい
- 「深い青」を main_color 用・sub_color 用に二重登録しなくてよい
- タグの追加はプールに1行足すだけで、全スロットに反映される

### 3-3. モード定義（draft_modes / draft_mode_slots）

モードは「枠の構成」と「1枠あたりの伏せカード枚数」を**別々に**持つ（D16）。
どちらもマスタテーブルに置き、コードに定数として埋め込まない。

**draft_modes**

| mode_key | 表示名 | 枠数 | candidate_count | max_rerolls | quiz_question_count | MVP |
|---|---|---|---|---|---|---|
| `easy` | お手軽 | 3項目 | **3** | 1 | 3 | 実装する |
| `standard` | 標準 | 5項目 | **5** | 1 | 3 | 実装する |

`advanced` / `full` は `candidate_count` 等が未確定のため、**MVPでは行を登録しない**。
実装するときに `draft_modes` へ行を足すだけで有効化できる。

**draft_mode_slots**

| mode_key | card_slot_key | sort_order |
|---|---|---|
| `easy` | `motif_a` | 1 |
| `easy` | `main_color` | 2 |
| `easy` | `genre_type` | 3 |
| `standard` | `motif_a` | 1 |
| `standard` | `motif_b` | 2 |
| `standard` | `main_color` | 3 |
| `standard` | `species` | 4 |
| `standard` | `genre_type` | 5 |

**用語の注意**: 「3項目」「5項目」は**枠の数**であり、`candidate_count`（1枠あたりの伏せカード枚数）とは別の設定値。
標準モードは 5枠 × 5候補 = 25枚の伏せカードを引く。
画面表示では枠数を「項目」と呼び、「◯枚」という表現は使わない。

### 3-4. 制作時間（カードではない）

**ドラフト開始前にユーザーが選択する設定値。**抽選しない。クイズ対象にもならない。

秒数（`time_limit_seconds`）を唯一の正本として保存する（D18）。
`null` は「無制限」を表す。表示用の区分（10分／30分…）は画面側で秒数から導く。

| 選択肢 | time_limit_seconds |
|---|---|
| 10分 | 600 |
| 30分 | 1800 |
| 60分 | 3600 |
| 120分 | 7200 |
| 無制限 | `null` |
| 自由設定 | 60〜600000（1〜10000分） |

結果画面・お題カード・作品詳細では**バッジ**として表示する（伏せない）。
投稿時に申告する実績時間は別データ（`works.actual_time_seconds`）。
サーバータイマーはMVPで扱わず、列も持たない（A10）。

---

## 4. カードドラフト

### 4-1. 候補生成アルゴリズム（サーバー側で1回だけ実行）

```
入力: mode_key
0. N = draft_modes.candidate_count（easy=3 / standard=5）
1. slots = draft_mode_slots で mode_key に紐づく card_slot_key 一覧
2. slots を pool_key でグループ化する
3. 各プール P について:
     needed = N × (P を使うスロットの数)
       例) standard の motif プール → motif_a と motif_b の2スロット → 5×2 = 10件
           standard の color プール → main_color の1スロット        → 5×1 = 5件
           easy の motif プール     → motif_a の1スロット            → 3×1 = 3件
     tags(P) から weight による重み付き抽選で needed 件を「重複なし」で取得
     取得した件を各スロットへ N 件ずつ配分する
4. draft_candidates へ INSERT
     (session_id, generation, card_slot_key, candidate_index 0..N-1, tag_id)
5. クライアントには card_slot_key と candidate_index だけ返す。tag_id / label は返さない
```

`candidate_index` は 0 から `candidate_count - 1` まで。**枠を表す `card_slot_key` と、
その枠の中での位置を表す `candidate_index` は別の列**として持つ（D16）。

**保証されること**

- 同一プールを使う複数スロット間で、候補が1件も重複しない
  → motif_a で「傘」を選んだあと motif_b の候補に「傘」が残っている、という事態が起きない
- どの札を選んでも結果は異なる（各候補に別々のタグが入っている＝偽の選択ではない）
- 選択前にクライアントは中身を知り得ない（レスポンスに含まれない）

**必要なタグ数の下限**（この式から導かれる）

| プール | easy | standard | クイズの誤答用 | **下限** |
|---|---|---|---|---|
| `motif` | 1枠×3 = 3 | **2枠×5 = 10** | 2 + 3 = 5 | **10** |
| `color` | 1枠×3 = 3 | 1枠×5 = 5 | 1 + 3 = 4 | **5** |
| `species` | — | 1枠×5 = 5 | 1 + 3 = 4 | **5** |
| `genre` | 1枠×3 = 3 | 1枠×5 = 5 | 1 + 3 = 4 | **5** |

「クイズの誤答用」は `そのお題が使っている同プールのタグ数 + 誤答3件`。
いずれも抽選側の要求が上回るため、**下限は合計25件**。実用上の推奨値は §8-2 を参照。

### 4-2. 開封（reveal_card）

ユーザーが `candidate_index` を1つ選ぶと、サーバーが該当行を `is_chosen = true` にして、
**その1件の label だけ**返す。他の3件は伏せたまま。開封は不可逆。

### 4-3. リロール（引き直し）

| 項目 | 仕様 |
|---|---|
| 単位 | **ドラフト全体**。カード単位の引き直しは不可 |
| 回数 | `draft_modes.max_rerolls`（MVPは easy / standard とも **1回**） |
| 挙動 | `generation` を +1 して候補を全スロット分ゼロから再抽選。旧世代の行は残すが無効化する |
| 記録 | 確定時に `prompts.was_rerolled` と `prompts.reroll_count` に記録する |
| 表示 | お題カード・作品詳細に「引き直しあり」を控えめに表示する |

リロールを1回に制限する理由: 無制限にすると「当たりが出るまで回す」ゲームになり、
正答率という指標の意味が薄れるため。

`ruleset` 列は廃止した（D19）。回数の制御は `draft_modes.max_rerolls` が担う。
セッション開始時にその値を `draft_sessions.max_rerolls` へ写しとして保存し、
進行中にマスタを変更してもそのセッションのルールは変わらないようにする。

**一発ドラフト（引き直し0回）の扱いは未確定。** モードとして足すか、
モードとは独立した設定として持つかを含め、実装時に改めて設計する（D19）。

### 4-4. 未選択カードの開示

**ドラフト直後には自動開示しない。** 以下のいずれかを満たしたときのみ開示する。

| reveal_reason | 契機 |
|---|---|
| `work_submitted` | そのお題で作品の投稿が完了した |
| `abandoned` | ユーザーが「このお題は描かない（チャレンジ放棄）」を押した |
| `manual` | ユーザーが「他の候補を見る」を明示的に押した |

- 開示できるのは**お題の作成者本人のみ**。第三者には常に非公開
- 開示すると `prompts.candidates_revealed_at` と `reveal_reason` が記録される（不可逆）
- 「他の候補を見る」を押しても投稿は引き続き可能（仮定A9）
- 開示対象は**最終世代（generation）の未選択候補のみ**。リロールで破棄した世代は開示しない

---

## 5. クイズ

### 5-1. 出題スロットの決定（お題確定時にサーバーが実行）

```
候補 = そのお題の prompt_cards のうち card_slots.is_quiz_eligible = true のもの
quiz_priority の昇順に並べ、上位 draft_modes.quiz_question_count 件を採用
  easy     → motif_a, main_color, genre_type（3枠すべてが対象になる）
  standard → motif_a, motif_b, main_color （species / genre_type は優先度下位のため出題されない）
```

**制約**: `quiz_question_count` は、そのモードのクイズ対象スロット数を超えられない。
モードを追加するときはこの条件を必ず確認する。

### 5-2. 選択肢の生成

**選択肢は4択で固定**。`candidate_count`（伏せカードの枚数）とは独立した設定値であり、
モードが変わっても4択のまま（A2 / D15）。

```
各問（スロット S、プール P）について:
  正解   = S で選ばれたタグ
  除外集合 = そのお題の prompt_cards のうちプール P に属する全タグ
             （例: motif_a の問題では motif_b の答えも除外する）
  誤答3件 = tags(P) から 除外集合 を引いた集合よりランダムに3件
  4件をシャッフルして position 0..3 で固定保存する
```

### 5-3. 回答

- **匿名ユーザーも回答できる**（Supabase匿名サインイン）
- 1作品につき1ユーザー1回のみ。DBの `UNIQUE(work_id, user_id)` で保証
- 回答送信は `submit_answer` RPC。採点・保存・統計更新・正解返却をサーバー側で一括実行
- 正解は「回答した瞬間のレスポンス」としてのみクライアントに渡る

---

## 6. ユーザーフロー

### 6-1. 描き手（ドラフト → 投稿）

```
/draft
 ├ [1] モード選択          : お手軽(3枚) / 標準(5枚)
 ├ [2] 制作時間を選ぶ      : 10分 / 30分 / 60分 / 120分 / 無制限 / 自由設定
 │                          ※ここはユーザーの選択。抽選ではない
 └ [3] ドラフト開始
      ↓ サーバーが候補を生成（プール単位で重複なし抽選、クライアントには中身を返さない）
      │
      ├ ステップ1／モチーフA
      │    [?] [?] [?] [?]  ← 伏せカード4枚
      │      └ 1枚タップ → めくる → 「割れた鏡」確定
      ├ ステップ2／モチーフB   ← motif_a の候補と1件も重複しない
      ├ ステップ3／メインカラー
      ├ …（モードの枚数だけ繰り返す）
      │
      │  ※画面下部に常時 [ドラフトを引き直す（残り1回）] を表示
      │     押すと最初のステップに戻り、候補を全スロット再抽選する
      ↓
    [結果画面]  /p/[prompt_id]  ← 作成者本人のみ開ける
      ・確定したお題カード一覧
      ・制作時間バッジ（例: 60分）
      ・引き直しバッジ（引き直した場合のみ）
      ・[カード画像を保存]  ← 共有はこの画像で行う。URLは他人が開けない
      ・[このお題で描く] → 投稿導線
      ・[他の候補を見る]  ← 押すと未選択カードを開示（本人のみ・不可逆）
      ・[このお題は描かない] → チャレンジ放棄。未選択カードを開示
      ↓
    [このお題で描く]
      ├ 未ログイン（匿名）→ ここで初めて登録を促す（投稿はアカウント必須）
      └ ログイン済 → /works/new?prompt=[prompt_id]
           ・画像1枚
           ・タイトル
           ・部門（オリジナル / ファンアート / AI作品）
           ・ファンアートを選んだ場合のみ:
                作品名（source_title）※必須
                キャラクター名（source_character）※任意
                補足（fanart_note）※任意
           ・実績制作時間
           ↓ 投稿完了 → 未選択カードを自動開示（reveal_reason = work_submitted）
           ↓ /works/[id] へ
```

### 6-2. 見る側（クイズ）

```
/ （通常フィード：オリジナル＋ファンアート）
/ai （AI作品フィード：完全分離）
  └ 作品をタップ → /works/[id]
        └ 見えるもの: 画像 / 部門 / 制作時間 / 実績時間 / 投稿者
           見えないもの: お題カードの中身
              └ 4択×3問に回答 → [答え合わせ]
                    ↓ 匿名ユーザーはここで初めて匿名サインイン（＋公開テスト時はCAPTCHA）
                    ↓ submit_answer RPC
                    └ 正解・自分の正誤・項目別正答率を開示
                          └ [いいね] [保存] ← 登録必須。未登録なら登録を促す
                             [Xで共有] [通報] ← 匿名可
```

### 6-3. 登録（匿名 → 新規アカウント昇格）

```
匿名uid: 1111-...
  ↓ [記録を残す] → メールアドレス入力 → supabase.auth.updateUser({ email })
  ↓ 確認メールのリンクをクリック
uid: 1111-...（変わらない） / is_anonymous = false
  ↓ handle と表示名を設定
→ 回答履歴・発行したお題・統計はそのまま引き継がれる（移行処理は不要）
```

**MVP対象外**: 匿名で遊んだあと「既存アカウント」でログインした場合の統合。
MVPでは、その場合に「匿名の記録は引き継げません」と明示し、続行するかを確認する。

---

## 7. ページ一覧

| パス | 役割 | 匿名 | 備考 |
|---|---|---|---|
| `/` | 通常フィード（オリジナル＋ファンアート） | 可 | |
| `/ai` | AI作品フィード | 可 | 通常フィードと完全分離 |
| `/draft` | モード・制作時間選択 → カードドラフト | 可 | |
| `/p/[id]` | お題カード | 作成者のみ | 共有コードは廃止（D17）。他人が開いても中身は返らない |
| `/works/new` | 投稿フォーム | **不可** | 登録必須 |
| `/works/[id]` | 作品詳細＋クイズ | 可 | |
| `/rankings` | ランキング | 可 | `?type=popular|accuracy|duration&feed=normal|ai` |
| `/u/[handle]` | ポートフォリオ | 可 | 公開設定に従う |
| `/me/settings` | プロフィール・公開設定 | **不可** | |
| `/login` | 登録・ログイン | 可 | |
| `/auth/callback` | 認証コールバック | — | Route Handler |
| `/works/[id]/opengraph-image` | OGP画像生成 | 可 | |

---

## 8. データベース設計

### 8-1. テーブル一覧

全21テーブル。`profiles` は Step 2 で作成済み。

```
profiles              プロフィール（匿名ユーザーも1行持つ）＋公開設定   ← Step 2 済
tag_pools             タグプール定義（マスタ）                        ← Step 3B-1 済
card_slots            カードスロット定義（マスタ）                      ← Step 3B-1 済
draft_modes           モード定義（マスタ）                             ← Step 3B-1 済
draft_mode_slots      モードが使う枠（マスタ）                          ← Step 3B-1 済
tags                  タグ本体（プールに属する・重み付き）              ← 表は済／行は Step 3D
draft_sessions        ドラフト進行状態                                ← Step 3B-2a 済
draft_candidates      伏せカードの中身【機密】                          ← Step 3B-2a 済
prompts               確定したお題                                     ← Step 3B-2b 済
prompt_cards          お題を構成する確定カード【機密】                  ← Step 3B-2b 済
quiz_questions        出題される3問【機密】                            ← Step 3B-2b 済
quiz_choices          各問の4択【機密】                                ← Step 3B-2b 済
works                 投稿作品（prompt_id は非公開列）
answers               回答（1作品1ユーザー1件）
answer_items          回答の内訳【機密：正解が推測できるため本人限定】
work_slot_stats       作品×スロットの正答集計
user_stats            ユーザーの通算成績
user_slot_stats       ユーザー×スロットの成績
likes                 いいね（登録ユーザーのみ・本人のみ閲覧可）
saves                 保存（登録ユーザーのみ）
reports               通報【機密】
```

**【機密】= `anon` / `authenticated` へテーブル権限を一切与えない**（D20）。
RLSポリシーを作らないことに加え、`grant` そのものを行わない二重の防御とする。
必要な情報はサーバー関数（RPC）だけが返す。

### 8-2. マスタ系

**tag_pools**

| 列 | 型 | 備考 |
|---|---|---|
| key | text PK | `motif` / `color` / `species` / `genre` / `role` / `era` / `gender` / `constraint` |
| label | text | 表示名 |
| sort_order | int | |

**card_slots**

| 列 | 型 | 備考 |
|---|---|---|
| card_slot_key | text PK | `motif_a` など。数値IDは使わない（D14） |
| label | text | 表示名 |
| pool_key | text FK → tag_pools | **どのプールから引くか** |
| quiz_priority | int | 小さいほど優先して出題。クイズ対象外は null |
| is_quiz_eligible | boolean | `constraint` のみ false |

提示順はモードごとに変わるため、`card_slots` ではなく `draft_mode_slots` が持つ。

**draft_modes**

| 列 | 型 | 備考 |
|---|---|---|
| mode_key | text PK | `easy` / `standard` |
| label | text | 表示名 |
| candidate_count | int | **1枠あたりの伏せカード枚数**。easy=3 / standard=5 |
| max_rerolls | int | 引き直せる回数。MVPはどちらも1 |
| quiz_question_count | int | 出題数。MVPはどちらも3 |
| sort_order | int | 選択画面の並び順 |
| is_active | boolean | 選択肢として出すか |

CHECK: `candidate_count >= 2` / `max_rerolls >= 0` / `quiz_question_count >= 1`

**draft_mode_slots**

| 列 | 型 | 備考 |
|---|---|---|
| mode_key | text FK → draft_modes | |
| card_slot_key | text FK → card_slots | |
| sort_order | int | ドラフトの提示順 |

PRIMARY KEY(mode_key, card_slot_key) / UNIQUE(mode_key, sort_order)

**tags**

| 列 | 型 | 公開 | 備考 |
|---|---|---|---|
| id | bigint PK | ○ | |
| pool_key | text FK → tag_pools | ○ | **スロットではなくプールに属する** |
| label | text | ○ | |
| weight | int | **×** | 既定100。レアは小さく。**運営用・非公開**（D21） |
| is_active | boolean | **×** | 既定true。false の行はそもそも返さない |
| note | text | **×** | 運用メモ |

UNIQUE(pool_key, label)

**公開取得で返す列は `id` / `pool_key` / `label` の3つだけ**（D21）。
`weight` を公開すると「どのタグが出にくいか」が分かり、クイズの推測材料になる。
`is_active = false` の行は RLS の条件で除外するため、列そのものも返さない。

> **運用ポリシー**: タグに既存IPの固有名詞を登録しない。
> 代わりに `genre` プールへ「変身戦士」「魔法少女」「巨大ロボ」「怪獣災害」「学園異能」
> 「収集・育成型怪物」などの一般的な類型を入れる。
> 利用者が自主的に既存IPへ寄せた場合はファンアート部門で投稿してもらう。

**初期投入数**（MVPで使う4プールのみ。残り4プールは定義だけ作りタグは入れない）

| プール | 下限（§4-1） | 推奨初期投入 | 根拠 |
|---|---|---|---|
| `motif` | 10 | **80** | standard で毎回10件消費するため最も厚く積む |
| `color` | 5 | **32** | 将来 `sub_color` が増えると2枠になる |
| `species` | 5 | **24** | |
| `genre` | 5 | **20** | 固有名詞禁止。一般類型のみ |
| | **計25** | **計156** | |

### 8-3. ドラフト・お題

実装済み（Step 3B-2a / `supabase/migrations/003_draft.sql`）。

**draft_sessions**

| 列 | 型 | 公開 | 備考 |
|---|---|:---:|---|
| id | uuid PK | ○ | 既定 `gen_random_uuid()` |
| **user_id** | uuid FK → profiles | **×** | 匿名含む。RLSの条件に使うが値は渡さない |
| mode_key | text FK → draft_modes | ○ | |
| candidate_count | int | ○ | **開始時点の写し**。進行中にマスタが変わっても影響を受けない |
| max_rerolls | int | ○ | **開始時点の写し**。同上 |
| quiz_question_count | int | ○ | **開始時点の写し**。同上 |
| reroll_count | int | ○ | 既定0 |
| time_limit_seconds | int null | ○ | null = 無制限（§3-4） |
| current_generation | int | ○ | 既定1。リロールで +1 |
| **current_slot_order** | int | ○ | 既定1。いま何枠目か。リロールで1に戻る |
| status | text | ○ | `in_progress` / `completed` / `abandoned` |
| created_at | timestamptz | ○ | |
| **updated_at** | timestamptz | ○ | トリガーで自動更新。`in_progress` の掃除基準 |
| **completed_at** | timestamptz null | **×** | |
| **abandoned_at** | timestamptz null | **×** | 放棄からの経過日数の基準 |

`prompt_id` は持たない。お題との接続は 3B-2b で `prompts.draft_session_id` として行う。

CHECK:
- `status in ('in_progress','completed','abandoned')`
- `reroll_count <= max_rerolls`
- `current_generation = reroll_count + 1`
- status と日時の整合（`in_progress` は両日時null／`completed` は完了日時のみ／`abandoned` は放棄日時のみ）
- `updated_at >= created_at` / 完了・放棄日時も `created_at` 以降

INDEX:
- **部分UNIQUE** `(user_id) where status = 'in_progress'` … 進行中は1人1件
- `(user_id)` … 過去のドラフト一覧用
- 部分 `(updated_at) where status='in_progress'` / `(abandoned_at) where status='abandoned'` … 掃除用

**draft_candidates** 【機密】

| 列 | 型 | 備考 |
|---|---|---|
| id | bigint PK | `generated always as identity` |
| session_id | uuid FK | |
| generation | int | 世代。開示対象は最終世代のみ |
| card_slot_key | text FK → card_slots | **どの枠か** |
| **slot_order** | int | **開始時点の枠の提示順の写し**。後日の開示で当時の順番を再現する |
| candidate_index | int | **その枠の中での位置**。0 〜 candidate_count-1 |
| tag_id | bigint FK → tags | **クライアントに渡らない** |
| is_chosen | boolean | お題に採用されたか |
| **revealed_at** | timestamptz null | 中身が本人に見えた日時。`is_chosen` とは別（D32） |
| created_at | timestamptz | |

UNIQUE(session_id, generation, card_slot_key, candidate_index)
UNIQUE(session_id, generation, tag_id) ← 同一世代でタグが重複しないことをDBでも保証
**部分UNIQUE** `(session_id, generation, card_slot_key) where is_chosen` ← 1枠1枚だけ選べる

CHECK: `is_chosen = false or revealed_at is not null`（選んだのに見ていない状態を作れない）

**外部キーの挙動**

| 参照元 | 参照先 | ON DELETE | ON UPDATE |
|---|---|---|---|
| draft_sessions.user_id | profiles | CASCADE | RESTRICT |
| draft_sessions.mode_key | draft_modes | RESTRICT | RESTRICT |
| draft_candidates.session_id | draft_sessions | CASCADE | RESTRICT |
| draft_candidates.card_slot_key | card_slots | RESTRICT | RESTRICT |
| draft_candidates.tag_id | tags | RESTRICT | RESTRICT |

一度でも使われたタグは削除できない。やめたいタグは `tags.is_active = false` にする。

**掃除の規則**（Step 16 で実装）

| status | 削除条件 | 基準列 |
|---|---|---|
| `in_progress` | 最終操作から30日 | `updated_at` |
| `abandoned` | 放棄から30日 | `abandoned_at` |
| `completed` | **削除しない** | 未選択カードの後日開示に候補データが必要なため |

**Step 4 の RPC が保証する不変条件**（複数表にまたがるため CHECK では表現できない）

```
1. candidate_index は 0 以上 candidate_count 未満
2. 各枠に candidate_count 件の候補を作る
3. 選択できるのは current_generation の候補だけ
4. tag の pool_key と card_slot の pool_key が一致する
5. 同じ枠の全候補で slot_order が一致する
6. 異なる枠で slot_order が重複しない
7. 状態遷移は in_progress → completed / abandoned のみ
8. completed / abandoned から in_progress へは戻せない
```

実装済み（Step 3B-2b / `supabase/migrations/004_prompts_quiz.sql`）。以下は実装と一致する。

**prompts**

| 列 | 型 | 公開 | 備考 |
|---|---|---|---|
| id | uuid PK default gen_random_uuid() | ○ | 共有コード（`code`）は廃止（D17） |
| draft_session_id | uuid **null許容 UNIQUE** FK → draft_sessions | × | ON DELETE **SET NULL**。未選択カードの参照元 |
| created_by | uuid null許容 FK → profiles | × | ON DELETE **SET NULL**。匿名も可 |
| mode_key | text FK → draft_modes | ○ | ON DELETE RESTRICT |
| time_limit_seconds | int null | ○ | 確定時に draft_sessions からコピー。null = 無制限。60〜600000 |
| was_rerolled | boolean not null default false | ○ | `was_rerolled = (reroll_count > 0)` を CHECK で保証 |
| reroll_count | int not null default 0 | ○ | 0〜5 |
| status | text not null default 'active' | ○ | `active` / `submitted` / `abandoned` |
| candidates_revealed_at | timestamptz null | ○ | null なら未開示 |
| reveal_reason | text null | × | `work_submitted` / `abandoned` / `manual` |
| created_at | timestamptz not null default now() | ○ | |
| submitted_at | timestamptz null | × | |
| abandoned_at | timestamptz null | × | |

主な CHECK

- `prompts_reveal_pair` … `candidates_revealed_at` と `reveal_reason` は必ず同時に埋まる
- `prompts_status_timestamps` … status と submitted_at / abandoned_at の組み合わせを固定
- `prompts_*_after_created` … 3つの日時はいずれも `created_at` 以降

索引：`prompts_created_by_idx (created_by)`、
`prompts_orphan_cleanup_idx (status) where created_by is null`（P4 の掃除用）

**prompt_cards** 【機密】

| 列 | 型 |
|---|---|
| id | bigint generated always as identity PK |
| prompt_id | uuid FK → prompts（**ON DELETE CASCADE**） |
| card_slot_key | text FK → card_slots（RESTRICT） |
| slot_order | int（1以上。`draft_candidates` と同じ名前に統一） |
| tag_id | bigint FK → tags（RESTRICT） |
| created_at | timestamptz |

UNIQUE(prompt_id, card_slot_key) / UNIQUE(prompt_id, slot_order) / UNIQUE(prompt_id, tag_id)

**quiz_questions** 【機密】

```
quiz_questions(id bigint identity, prompt_id uuid FK cascade,
               card_slot_key text FK, position int 0..9, created_at)
    UNIQUE(prompt_id, position)
    UNIQUE(prompt_id, card_slot_key)   ← 同じ枠を2回出題しない
```

**quiz_choices** 【機密】

```
quiz_choices(id bigint identity, question_id bigint FK cascade,
             tag_id bigint FK, position int 0..3, is_correct boolean 【機密】, created_at)
    UNIQUE(question_id, position)
    UNIQUE(question_id, tag_id)        ← 同じ選択肢が2回出ない
    部分UNIQUE (question_id) where is_correct   ← 正解は「最大1件」
```

**部分UNIQUE が保証するのは「最大1件」であって「必ず1件」ではない**。
正解0件の問題は DB を通ってしまう。ちょうど1件であることは Step 5 の
`complete_draft` が保証し、§13-2 の診断で継続的に確認する。

**権限**

- `prompts` … `authenticated` に**上表の「公開○」8列だけ** `grant select`。
  RLS ポリシーは `prompts_select_own`（`(select auth.uid()) = created_by`）の1本だけ。
  `anon` には何も与えない。
- 機密3表 … **`grant` も RLS ポリシーも1つも作らない**。直接 SELECT すると
  `permission denied`（D31）。データは `security definer` の RPC からのみ出る。

`quiz_questions` も機密扱いとする（D20）。
「どのお題のどの枠が出題されているか」自体が推測材料になるうえ、
クライアントは `get_work_quiz`（§9-2）だけを使うので直接読む必要がない。

**公開ビュー `public_quiz_view` は廃止し、RPC `get_work_quiz(work_id)` に置き換える**（D22）。
理由は §9-6 を参照。

**`created_by` が null になった行の見え方**

ゲスト掃除などで `created_by` が null になると `auth.uid() = null` は真にならないため、
その行は**誰から見ても0件**になる（エラーではない）。作品側の表示は
`security definer` の RPC が担うので、クイズは成立し続ける。
この状態の行は P4 の掃除対象になる。

### 8-4. 投稿・回答

**works**

| 列 | 型 | 公開 | 備考 |
|---|---|---|---|
| id | uuid PK | ○ | |
| **prompt_id** | uuid FK **UNIQUE** | **×** | **どの取得経路でもクライアントへ返さない**（D17 / D23） |
| user_id | uuid FK → profiles | ○ | **登録ユーザーのみ**。NOT NULL |
| title | text | ○ | 最大60字 |
| image_path | text | ○ | Storage内パス |
| image_width / image_height | int | ○ | |
| division | text | ○ | `original` / `fanart` / `ai`。**投稿後は変更不可** |
| **source_title** | text | ○ | ファンアートの元作品名。`fanart` のとき必須。100字以内 |
| **source_character** | text | ○ | 元キャラクター名。任意。100字以内 |
| **fanart_note** | text | ○ | 補足・注意書き。任意。500字以内 |
| actual_time_seconds | int null | ○ | 実績時間の**自己申告**。null = 未申告 |
| is_published | boolean | 本人のみ | 既定true |
| review_status | text | 本人のみ | `ok` / `flagged` / `hidden`。**運営のみ変更可** |
| deleted_at | timestamptz | 本人のみ | 論理削除 |
| likes_count / saves_count / answers_count | int | ○ | トリガー更新のキャッシュ（D24） |
| created_at | timestamptz | ○ | |

`prompt_id` に UNIQUE を張ることで、**1つのお題から作れる作品は最大1件**になる（A11 / D17）。

**ファンアート項目の整合条件**（2つのCHECK制約）

```
条件1: division = 'fanart'  → source_title が NOT NULL であること
条件2: division <> 'fanart' → source_title / source_character / fanart_note が
                              3つとも NULL であること
```

条件2により、オリジナル部門やAI部門の行にファンアート情報が紛れ込むことをDBが防ぐ。
`division` を投稿後に変更できない設計にしているのは、この整合性を保つため。
部門を誤った場合は投稿し直す。

**変更可否**

| 区分 | 列 |
|---|---|
| 本人が変更できる | `title` `source_title` `source_character` `fanart_note` `is_published`<br>`actual_time_seconds`（**未公開の間のみ**。D25） |
| 誰も直接変更できない | `id` `prompt_id` `user_id` `image_path` `image_width` `image_height`<br>`division` 各カウンタ `review_status` `deleted_at` `created_at` |

`actual_time_seconds` は一度公開したら変更できない（D25）。
ただし**時間別ランキングの分類基準には使わない**。分類は `prompts.time_limit_seconds`
（お題を引いた時点で確定している制限時間）で行い、`actual_time_seconds` は
作品ページに表示する自己申告の補助情報として扱う。

**answers**

| 列 | 型 |
|---|---|
| id | bigint PK |
| work_id | uuid FK |
| user_id | uuid FK → profiles（`ON DELETE SET NULL`） |
| correct_count | int（0〜3） |
| created_at | timestamptz |

UNIQUE(work_id, user_id)

**answer_items** 【機密】

| 列 | 型 |
|---|---|
| id | bigint PK |
| answer_id | bigint FK |
| question_id | bigint FK |
| slot_key | text |
| selected_tag_id | bigint FK |
| is_correct | boolean |

> **重要**: `answer_items` は `selected_tag_id` と `is_correct` を併せ持つため、
> 他人の行が読めると **`is_correct = true` の行から正解タグが判明してしまう**。
> したがって公開設定に関わらず **常に本人のみ SELECT 可**とする。
> 回答履歴の公開は §8-5 のビューで「作品・日時・正答数」のみを出す。

**work_slot_stats**

```
work_slot_stats(work_id, slot_key, attempts int, corrects int)
    PRIMARY KEY(work_id, slot_key)
```
項目別正答率 = `corrects / attempts`。スロットが可変なので works の列にせず別テーブルに置く。

**user_stats / user_slot_stats**

```
user_stats(user_id PK, total_answers int, total_items int, total_correct_items int, updated_at)
user_slot_stats(user_id, slot_key, attempts int, corrects int, PRIMARY KEY(user_id, slot_key))
```
公開時はこの集計テーブルだけを見せる（生の回答行は見せない）。

**likes / saves / reports**

```
likes(work_id, user_id, created_at)   PK(work_id, user_id)   -- 登録ユーザーのみ
saves(work_id, user_id, created_at)   PK(work_id, user_id)   -- 登録ユーザーのみ
reports(id, work_id, reporter_id, reason, detail, status, created_at)
    UNIQUE(work_id, reporter_id)      -- 匿名も可
    reason: copyright / inappropriate / spam / ai_undeclared / other
```

**likes の行は本人しか読めない**（D26）。他人へ公開するのは `works.likes_count` だけで、
「誰がいいねしたか」を見せる機能はMVPに含めない。

`likes` の行を正本とし、`works.likes_count` は**トリガーで同期するキャッシュ**として扱う（D24）。
値がずれた場合は `likes` を数え直せば復旧できる。`saves_count` / `answers_count` も同じ扱い。

### 8-5. profiles と公開設定

| 列 | 型 | 既定 | 備考 |
|---|---|---|---|
| id | uuid PK → auth.users.id | | 匿名ユーザーも含む |
| handle | text UNIQUE (null可) | null | 登録時に確定。3〜20字の**小文字**英数字とハイフン。先頭・末尾のハイフン不可 |
| display_name | text | 「ゲスト」 | 1〜30字 |
| bio | text | null | 500字以内 |
| links | jsonb | `{}` | X / pixiv など。JSON object かつ 4096 バイト以内 |
| is_anonymous | boolean | true | 昇格時に false。**プロフィールの閲覧範囲の判定に使う**（D12）。更新は `auth.users` からのトリガー経由のみ |
| **show_answer_stats** | boolean | **false** | 回答者としての成績を公開するか（D11） |
| **show_answer_history** | boolean | **false** | 回答履歴を公開するか（本人のみが初期値） |
| **show_saved_works** | boolean | **false** | 保存作品を公開するか（本人のみが初期値） |
| created_at | timestamptz | | |

公開用の取得経路（ビューではなくRPC。D22）:

```
get_public_answer_history(user_id)   -- show_answer_history = true のユーザーのみ
    返す列: work_id, correct_count, created_at
    ※ selected_tag_id と is_correct は含めない（正解漏洩の防止）
```

### 8-6. Storage

| バケット | 公開 | パス | 用途 |
|---|---|---|---|
| `works` | public read | `{user_id}/{work_id}.{ext}` | 投稿画像 |
| `prompt-cards` | public read | `{prompt_id}.png` | お題カードの共有画像 |

上限5MB / `image/jpeg`・`image/png`・`image/webp` のみ。

`prompt-cards` のパスは推測できない uuid なので、リンクを知らなければ到達できない。
作成者が自らSNSへ画像を投稿した場合はその内容が公開されるが、
`works.prompt_id` をクライアントへ一切返さないため
「その画像がどの作品のお題か」は外部から辿れない（D23の残存リスクとして受容）。

`works` バケットのパス先頭は投稿者の `user_id`。
作品作成RPCは `image_path` が**呼び出し本人の領域を指しているか**を検査する（§9-2）。

---

## 9. RLS設計

### 9-1. 原則

1. 全テーブルでRLSを有効化する。例外を作らない
2. 匿名も登録も `auth.uid()` で同じように扱う
3. 正解に関わるデータはクライアントから読ませない
   → `draft_candidates` / `prompt_cards` / `quiz_choices` / `answer_items`（他人の行）
4. 判定・確定・集計はすべて `security definer` のサーバー関数で行う
5. 「登録ユーザー限定」は JWT の匿名フラグで強制する

```sql
-- 登録ユーザー判定の共通式
coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
```

### 9-1-1. APIキーと環境変数

Supabase の**新しいキー体系（publishable / secret）**を使う。
旧体系の `anon` / `service_role`（`eyJ...` で始まる JWT）は使わない。

| 環境変数 | キー | 置き場所 | 用途 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | ブラウザ可 | 接続先 |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | publishable | ブラウザ可 | 通常のクライアント。RLSが守る |
| `SUPABASE_SECRET_KEY` | secret | **サーバーのみ** | RLSを迂回する管理操作 |

**`SUPABASE_SECRET_KEY` の運用ルール**

- Step 1 の初期接続では **URL と publishable key だけ**を使う
- secret key が実際に必要になる処理を実装するまで、**コードから参照しない**
  （`lib/supabase/admin.ts` を作るのは、それが必要になった時点）
- `NEXT_PUBLIC_` を付けない。クライアントコンポーネントから import しない
- Vercel では Production / Preview / Development の環境変数として個別に登録する

### 9-2. サーバー関数（security definer）

**Step 3 では権限設定だけを行い、関数の中身は各機能の Step で実装する。**
テストできる画面が無い段階で関数を大量に書かないため。

**ドラフト・お題**

| 関数 | 役割 |
|---|---|
| `start_draft(mode_key, time_limit_seconds)` | セッション作成＋候補をプール単位で重複なし抽選 |
| `reroll_draft(session_id)` | 残り回数を検査し、generation を進めて再抽選 |
| `reveal_card(session_id, card_slot_key, candidate_index)` | 1枚めくる。選んだ1件の label だけ返す |
| `complete_draft(session_id)` | prompts / prompt_cards / quiz_questions / quiz_choices を確定生成 |
| `reveal_unchosen(prompt_id, reason)` | 未選択カードを開示（本人のみ・不可逆） |
| `abandon_prompt(prompt_id)` | チャレンジ放棄＋開示 |

**お題の取得経路**（`prompt_cards` を直接読ませないための入口。D23）

| 関数 | 誰が使えるか | 返すもの |
|---|---|---|
| `get_my_prompt(prompt_id)` | **作成者のみ** | 確定カード全部。開示済みなら未選択候補も |
| `get_my_prompts()` | 本人 | 自分が発行したお題の一覧（カード内容を含む） |

共有コードによる取得（`get_prompt_by_code`）は**MVPに含めない**（D17）。
同じお題を複数人が描くチャレンジ機能は、将来、通常のお題とは別の機能として設計する。

**作品の取得経路**（`works` を直接読ませないための入口。D23）

| 関数 | 誰が使えるか | 返すもの |
|---|---|---|
| `get_public_works(filter, sort, cursor)` | 誰でも | フィード用の一覧 |
| `get_work_detail(work_id)` | 誰でも | 作品1件の詳細 |
| `get_my_works()` | 本人 | 自分の作品一覧（非公開・審査中・削除済みも含む） |
| `get_my_work(work_id)` | 本人 | 自分の作品1件（編集画面用） |

公開取得（`get_public_works` / `get_work_detail`）が返すのは次を**すべて**満たす作品のみ。

```
is_published = true  かつ  review_status = 'ok'  かつ  deleted_at is null
```

**`prompt_id` はどの取得経路でもクライアントへ返さない。**

**作品の作成・更新・削除**

| 関数 | 役割 |
|---|---|
| `create_work(...)` | 下の6検査を通してから作品を作成し、未選択カードを開示 |
| `update_work(work_id, ...)` | 許可された列だけを更新 |
| `delete_work(work_id)` | 論理削除（`deleted_at`）＋Storage画像の削除 |

`create_work` が必ず行う検査（D27）:

```
1. 呼び出し元が登録済みユーザーであること（JWT の is_anonymous が false）
2. 呼び出し元が対象 prompt の作成者本人であること
3. prompt が完成済みであること（status = 'active'）
4. その prompt がまだ別の作品に使われていないこと（works.prompt_id の UNIQUE）
5. division と source_title / source_character / fanart_note が整合していること
6. image_path が呼び出し元本人の Storage 領域（{自分のuser_id}/...）を指していること
```

1〜4のいずれかを満たさない場合はエラーを返し、作品を作らない。

**クイズ・回答**

| 関数 | 誰が使えるか | 役割 |
|---|---|---|
| `get_work_quiz(work_id)` | 誰でも（ゲスト含む） | 3問と各4択の**選択肢の文字だけ**。正解の印は含めない |
| `submit_answer(work_id, selections)` | 誰でも（ゲスト含む） | 採点・保存・統計更新・正解返却 |
| `get_answer_result(work_id)` | **回答済みの本人のみ** | 自分の選択・正誤・正解を再取得 |

`submit_answer` は**作品の作者本人による自作への回答を拒否する**（D28）。
自作のお題は本人が知っているため、回答すると統計が歪む。
DBの制約では表現できないため、RPC側で必ず検査する。

**その他**

| 関数 | 役割 |
|---|---|
| `toggle_like(work_id)` / `toggle_save(work_id)` | 登録判定＋行の追加削除。カウンタはトリガーが同期 |
| `create_report(work_id, reason, detail)` | 通報＋レート制限 |
| `promote_anonymous(handle, display_name)` | 匿名 → 新規アカウント昇格の仕上げ |

### 9-3. テーブル別ポリシー

「**権限なし**」= `anon` / `authenticated` に `grant` を一切与えない。
RLSポリシーを作らないことに加えた二重の防御（D20）。

**拒否のされ方が2種類あることに注意**（D31）。

| 状態 | 直接SELECTの結果 |
|---|---|
| 権限を与えていない | **`permission denied for table ...`（エラー）** |
| 権限はあるがRLSが行を除外 | **0件**（エラーにならない） |

機密テーブルは前者、`profiles` や `tags` のように条件付きで公開する表は後者。

| テーブル | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | `is_anonymous = false` **かつ** handle 確定済みは全員／それ以外は本人のみ（D12） | **トリガーのみ**（クライアント不可） | 本人（6列のみ。handle / is_anonymous は不可） | × |
| tag_pools / card_slots | 全員 | × | × | × |
| draft_modes / draft_mode_slots | 全員（`is_active` のみ） | × | × | × |
| tags | 全員（`is_active = true` の行の<br>`id` / `pool_key` / `label` のみ。D21） | × | × | × |
| draft_sessions | owner のみ | RPC | RPC | × |
| **draft_candidates** | **権限なし** | RPC | RPC | × |
| prompts | created_by のみ | RPC | RPC | × |
| **prompt_cards** | **権限なし** | RPC | × | × |
| **quiz_questions** | **権限なし**（D20） | RPC | × | × |
| **quiz_choices** | **権限なし** | RPC | × | × |
| **works** | **権限なし** → 4つの取得RPC経由のみ（D23） | RPC | RPC | × |
| answers | 本人のみ | RPC | × | × |
| **answer_items** | **本人のみ（公開設定に関わらず）** | RPC | × | × |
| work_slot_stats | 全員 | トリガー | トリガー | × |
| user_stats | 本人 OR `show_answer_stats = true` | トリガー/RPC | トリガー/RPC | × |
| user_slot_stats | 本人 OR `show_answer_stats = true` | トリガー/RPC | トリガー/RPC | × |
| **likes** | **本人のみ**（D26） | RPC | × | RPC |
| saves | 本人 OR `show_saved_works = true` | RPC | × | RPC |
| **reports** | **権限なし** | RPC（匿名可） | × | × |

`works` の SELECT 権限を与えないため、更新も RPC（`update_work`）経由になる（D23）。
Postgres では `update ... where id = ?` の条件式にも SELECT 権限が必要で、
直接更新を許すと結局いくつかの列を読ませることになるため、経路を1本に統一する。

### 9-4. 未選択カードの開示制御

`draft_candidates` は SELECT ポリシーを持たないため、直接読むことはできない。
開示は関数 `get_unchosen_candidates(prompt_id)` 経由でのみ行い、内部で次を検査する。

```
1. auth.uid() = prompts.created_by であること
2. prompts.candidates_revealed_at IS NOT NULL であること
3. 返すのは最終 generation の is_chosen = false の行のみ
```

### 9-5. 正解が漏れない経路の確認

| 経路 | 結果 |
|---|---|
| `prompt_cards` を直接SELECT | 権限なし → **permission denied（エラー）** |
| `quiz_questions` / `quiz_choices` を直接SELECT | 権限なし → **permission denied** |
| `draft_candidates` を直接SELECT | 権限なし → **permission denied** |
| `works` を直接SELECT | 権限なし → **permission denied**。取得は4つのRPCのみ |
| **作品からお題への到達** | `prompt_id` をどのRPCも返さない → 辿れない |
| `tags` から出やすさを推測 | `weight` を返さない → 推測材料にならない |
| 他人の `answer_items` を直接SELECT | 0件（公開設定に関わらず） |
| 他人の `likes` を直接SELECT | 0件。公開するのは `works.likes_count` のみ |
| 公開された回答履歴 | 作品・日時・正答数のみ。選択タグは含まれない |
| ドラフトAPIのレスポンス | 開封した1枚の label のみ |
| 作品詳細のHTMLソース | 未回答時はお題データを一切埋め込まない |
| `submit_answer` の連打 | UNIQUE制約＋関数内チェックで既存結果を返すのみ |
| 作者が自作に回答して正解を得る | `submit_answer` が作者本人を拒否（D28） |

### 9-6. 公開ビューを使わない理由

当初は `public_quiz_view` などの公開ビューで機密列を隠す想定だったが、
**MVPではビューを作らず、すべてRPCに統一する**（D22）。

| 観点 | 公開ビュー | RPC |
|---|---|---|
| RLSの扱い | 作成者の権限で動くため、下のテーブルのRLSを素通りしうる。`security_invoker` の明示が必須 | 明示的に権限を指定して書く |
| うっかり漏洩 | 定義に `select *` を使うと、後から増えた列が自動的に公開される | 返り値を型で宣言するため勝手には出ない |
| **`prompt_id` の隠蔽** | **クイズと作品を結ぶために `prompt_id` を含めざるを得ない** | `work_id` を受け取って内部で解決するので外に出さずに済む |
| 引数での絞り込み | できない（全行が対象） | `work_id` 単位で必要な行だけ返せる |
| 見つけやすさ | テーブル一覧に紛れる | 関数一覧に並ぶ |

決め手は3行目。§9-5 で「作品からお題へ辿れないこと」を保証する以上、
`prompt_id` を含むビューでは要件を満たせない。

`public_answer_history`（回答履歴の公開）も同じ方針で RPC 化する。
最終判断は Step 3C で行う。

---

## 10. 未登録／登録ユーザー権限表

| 行動 | 未登録（匿名） | 登録 |
|---|:---:|:---:|
| お題を引く（ドラフト） | ○ | ○ |
| 制作時間を選ぶ | ○ | ○ |
| ドラフトを引き直す（1回） | ○ | ○ |
| お題を発行する | ○ | ○ |
| お題カード画像を保存・共有 | ○ | ○ |
| 未選択カードを開示 | ○ | ○ |
| 作品を見る | ○ | ○ |
| クイズに回答する | ○ | ○ |
| **自作へのクイズ回答** | **×** | **×**（作者本人は不可。D28） |
| 回答を全体統計へ反映 | ○ | ○ |
| 正解・正答率を見る | ○ | ○ |
| ランキングを見る | ○ | ○ |
| 通報 | ○ | ○ |
| **いいね** | **×** | ○ |
| **作品を保存** | **×** | ○ |
| **画像を投稿** | **×** | ○ |
| 回答履歴の永続保存 | △（同一ブラウザのみ・保証なし） | ○ |
| 通算成績・分野別正答率 | × | ○ |
| ポートフォリオページ | × | ○ |
| 公開設定の変更 | × | ○ |
| 自作品の削除・非公開 | — | ○ |

**人気ランキングは登録ユーザーのいいねのみで集計する**（匿名いいねは存在しない）。

登録を促すタイミング:
1. 「いいね」「保存」を押したとき
2. 「このお題で描く → 投稿」に進んだとき
3. 3回目の回答を終えた直後に1回だけ（記録を残しませんか）

---

## 11. 匿名ユーザー設計

### 11-1. 方式

Supabase の匿名サインインを使う。匿名でも `auth.uid()` が発行されるため、RLSを一本化できる。

- 実行タイミング: ページ訪問時ではなく、**初めて書き込みが必要になった瞬間**
  （回答送信 / お題確定 / 通報）。閲覧だけの訪問者でユーザー行を増やさない
- 公開テスト時は匿名サインインに **CAPTCHA（Cloudflare Turnstile）** を入れる
- レート制限も併用する

### 11-2. 昇格（MVPに含める）

匿名アカウントにメールをリンクすると、**同じ uid のまま**永続アカウントになる。
データ移行処理は不要。`profiles.is_anonymous` を false にし、handle と表示名を設定する。

### 11-3. 既存アカウントへの統合（MVP後）

匿名で遊んだあと既存アカウントでログインすると uid が変わるため、統合処理が必要になる。
**MVPでは実装しない。** ログイン前に「匿名の記録は引き継げません」と明示して確認する。

### 11-4. 匿名ユーザーの掃除

匿名ユーザーも `auth.users` の行として課金指標（MAU）に計上される。

- 30日以上更新がなく、昇格もしていない匿名ユーザーを Supabase Cron で定期削除
- `answers.user_id` は `ON DELETE SET NULL`。集計値（`work_slot_stats`）は保持する

### 11-5. 重複回答の防止

| レイヤ | 対策 |
|---|---|
| DB | `UNIQUE(work_id, user_id)` |
| サーバー | RPC内で既存回答を確認し、あれば既存結果を返す（エラーにしない） |
| 濫用対策 | CAPTCHA＋レート制限 |

ブラウザデータを消せば新しい匿名IDを取得できるため、投票の完全な一意性は保証できない。
「軽く遊べること」とのトレードオフとして受け入れ、正答率ランキングは
**回答者5人以上**の作品のみを対象とすることで緩和する。

---

## 12. ポートフォリオページ仕様

URL: `/u/[handle]`

```
┌───────────────────────────────────────┐
│ アイコン  表示名                              │
│          @handle                             │
│          ひとこと紹介                          │
│          [X] [pixiv] などの外部リンク           │
├───────────────────────────────────────┤
│ 【描き手としての記録】※常に公開                  │
│  投稿数 / 獲得いいね / 総制作時間                 │
│  伝わりやすさ（自作品の平均正答率）                │
│  スロット別: モチーフA 72% / モチーフB 55% / 色 78% │
├───────────────────────────────────────┤
│ 【回答者としての記録】※show_answer_stats に従う   │
│  総回答数 / 総合正答率 / 分野別正答率              │
├───────────────────────────────────────┤
│ タブ                                          │
│  [オリジナル] [ファンアート] [AI作品]  ※常に公開   │
│  [保存した作品]  ※show_saved_works に従う         │
│  [回答履歴]     ※show_answer_history に従う       │
│  [発行したお題]  ※本人のみ                        │
├───────────────────────────────────────┤
│ 作品グリッド（新着 / 人気 / 正答率 で並替）         │
└───────────────────────────────────────┘
```

- AI作品は必ず独立タブ。オリジナル／ファンアートのタブに混在させない
- ファンアート作品のカードには `source_title` を表示する
- 非公開・削除済み作品は他人には一切返さない（RLSで担保）
- 「伝わりやすさ」は回答者5人以上の作品のみを対象に平均する
- 公開された回答履歴は「作品・日時・正答数」のみ。選択したタグは表示しない

---

## 13. 実装順序

各ステップの着手時に「変更内容 / 変更ファイル / 実行コマンド / 動作確認方法 / エラー時の確認箇所」を提示する。

| Step | 内容 | 終了条件 |
|---|---|---|
| 0-a | 親フォルダ内にプロジェクトフォルダと docs / supabase を作成 | フォルダが存在する |
| 0-b | **Node.js のインストール** | `node -v` が表示される |
| 0-c | Next.js 雛形作成、Git初期化 | `npm run dev` が動く |
| 1 | Supabase接続・環境変数・クライアント3分割 | サーバーから疎通確認 |
| 2 | 匿名サインイン＋profiles自動生成 | 初回書き込みでゲストIDが発行される |
| 3 | スキーマ＋RLS＋タグマスタ投入（下表のとおり8工程に分割） | 管理画面でポリシーを確認できる |
| 4 | カードドラフト（制作時間選択・重複なし抽選・リロール1回） | 4枚から選べる／motif_bにmotif_aの候補が出ない |
| 5 | 結果画面・お題カード表示・共有・未選択カード開示 | 3条件でのみ開示される |
| 6 | 登録（匿名→新規昇格）＋handle設定 | 匿名の記録が引き継がれる |
| 7 | 投稿フォーム（ファンアート項目含む）＋Storage | 匿名では投稿できない |
| 8 | フィード（通常／AI分離） | AI作品が通常フィードに出ない |
| 9 | 作品詳細（お題を伏せる） | ソースを見ても答えが無い |
| 10 | クイズ＋submit_answer | 匿名でも回答でき、2回目は弾かれる |
| 11 | 項目別正答率＋集計トリガー | 別端末で回答すると%が動く |
| 12 | いいね・保存（登録必須） | 匿名では押せない |
| 13 | ランキング（3種×2系統） | 人気は登録ユーザーのいいねのみ |
| 14 | ポートフォリオページ＋公開設定 | 既定で成績・履歴・保存が非公開 |
| 15 | 共有OGP／通報／削除・非公開 | |
| 16 | Vercelデプロイ／匿名ユーザー掃除Cron／CAPTCHA／**孤児お題の掃除（P4）** | 本番で一連の流れが通る |

### 13-1. Step 3 の分割

範囲が大きいため8工程に分ける。**テーブルとそのRLS・権限は必ず同じマイグレーションに書く**
（R3。作ってから後でポリシーを張ると、その間テーブルが無防備になる）。

| 工程 | 内容 | 終了条件 |
|---|---|---|
| ~~**3A**~~ ✅ | スキーマ設計の確定（実装なし） | この仕様書と decisions.md へ反映済み |
| ~~**3B-1**~~ ✅ | マスタ5表：`tag_pools` `card_slots` `draft_modes` `draft_mode_slots` `tags`<br>＋RLS＋権限＋マスタ行（タグ本体を除く） | モードと枠の構成を管理画面で確認できる |
| ~~**3B-2a**~~ ✅ | ドラフト2表：`draft_sessions` `draft_candidates`＋RLS＋権限 | `draft_candidates` が permission denied |
| ~~**3B-2b**~~ ✅ | 確定お題・クイズ4表：`prompts` `prompt_cards` `quiz_questions` `quiz_choices`<br>＋RLS＋権限 | 機密3表が permission denied |
| **3B-3a** | 作品・回答・集計6表：`works` `answers` `answer_items`<br>`work_slot_stats` `user_stats` `user_slot_stats`＋RLS＋権限 | `works` が permission denied |
| **3B-3b** | 反応・通報3表：`likes` `saves` `reports`＋RLS＋権限 | `likes` が他人から0件で返る |
| **3C** | 公開取得経路の設計確定とレビュー（ビュー vs RPC の最終判断） | 正解へ到達する経路が無いことを §9-5 の表で確認 |
| **3D** | タグ投入。`docs/tags-master.md` に案を作り**目視確認してから**投入 | 4プールで計156件前後 |
| **3E** | 横断診断ページで全テーブルの状態を確認しコミット | 権限表と実際の設定が一致 |

各工程の前に説明を提示し、確認を待ってから着手する。取り消し用SQLも工程ごとに用意する。

**共通の作法**（3B-1 で確立。以降の工程もこれに従う）

- マイグレーションは全体を `begin` / `commit` で囲む。途中で失敗したら何も残らない
- `create table` に `if not exists` を付けない。付けると、列や制約が異なる
  古い表があっても作成を飛ばして黙って使ってしまう。
  やり直すときは取り消し用SQLで消してから流し直す
- 正常終了した番号付きマイグレーションは再実行しない
- 機密でない表も、公開する列は `grant select (列名, ...)` で明示する。
  その結果 **`select *` は権限エラーになる**ため、アプリ側は列名を必ず列挙する
- 取り消し用SQLも `begin` / `commit` で囲み、参照している側から順に消す

### 13-2. Step 3E の必須診断

**DB の制約だけでは防げない不整合**を検出する。制約は「最大1件」「型」「参照先の存在」
までしか保証できず、「必ず1件ある」「複数の表の内容が一致している」は表現できない。
そこを人手で確認するのがこの診断。

**すべて 0 行が返れば正常。1行でも返れば、それは壊れたデータ。**

| # | 検出するもの | なぜ制約で防げないか |
|---|---|---|
| A1 | 正解がちょうど1件でない `quiz_questions` | 部分UNIQUE は「最大1件」しか保証しない。**0件を通す** |
| A2 | 選択肢が4件でない問題 | 「何件あるか」は行をまたぐのでCHECKで書けない |
| A3 | 正解タグが `prompt_cards` の答えと一致しない問題 | 別の表どうしの照合はCHECKで書けない |
| A4 | `prompt_cards` の件数がモードの枠数と一致しない `prompts` | 同上 |
| A5 | `status = 'submitted'` なのに `works` が存在しない `prompts` | 同上（3B-3a 以降で有効） |

- A1〜A4 は `complete_draft` RPC（Step 5）が作成時に保証する。診断はその**事後確認**。
- **A5 は掃除対象にしない**。投稿済みのはずの作品が見当たらない状態であり、
  自動削除すると原因調査ができなくなる。必ず手で調べる（P4 と区別する）。

検出クエリの全文は `supabase/migrations/004_prompts_quiz.sql` 末尾のコメントにある。
3B-3a 以降の表が増えたら、この表へ行を追加していく。

---

## 14. 技術的リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | 正解の漏洩 | 機密テーブルはポリシー無し**かつ権限なし**。RPC経由のみ（D20） |
| R1-a | **作品からお題への到達** | `works.prompt_id` をどのRPCも返さない（D23） |
| R1-b | **作者が自作に回答して統計を歪める** | `submit_answer` が作者本人を拒否（D28） |
| R2 | **他人の回答行から正解が漏れる** | `answer_items` は常に本人のみ。公開履歴は正答数のみ |
| R3 | RLSの付け忘れ | テーブル作成SQLとポリシーSQLを同じマイグレーションに書く |
| R4 | secret キーの露出 | `NEXT_PUBLIC_` を付けない。クライアントで import しない。必要になるまで参照もしない |
| R5 | 匿名ユーザーの大量発生でMAU超過 | 書き込み直前のみサインイン／30日で自動削除／CAPTCHA |
| R6 | 匿名の作り直しによる回答水増し | 完全防止は不可。正答率ランキングは回答者5人以上を対象 |
| R7 | プール分離の抽選バグ（候補重複） | プール単位でまとめて抽選。テストで重複ゼロを検証 |
| R8 | リロール時に旧世代が混入 | `generation` で明確に区切り、常に最終世代のみ参照 |
| R9 | 未選択カードの早期開示 | 開示は関数経由のみ。`candidates_revealed_at` で状態管理 |
| R10 | Storageに孤児ファイルが残る | アップ成功 → INSERT の順。INSERT失敗時はStorageを削除 |
| R11 | 集計の重さ | カウンタ列＋集計テーブル＋トリガー |
| R12 | ファンアートの権利表記漏れ | `source_title` を必須化＋投稿時に注意文を常設 |
| R13 | AI部門の誤申告 | 確認チェックボックス＋通報理由 `ai_undeclared` |
| R14 | タグマスタへの固有名詞混入 | `seed/tags.sql` 冒頭にポリシーをコメント記載＋投入前に確認 |
| R15 | 日本語パス／Downloads配下 | 早期に Git ＋ GitHub へ退避。ビルド不調時は最初に疑う |
| R16 | 認証リダイレクトURL不一致 | Supabase の Redirect URLs に localhost と本番の両方を登録 |
| R17 | 無料枠上限（Storage 1GB 等） | 画像上限5MB。使用量を定期確認 |

---

## 15. フォルダ構成

```
/Users/kazushi/Downloads/就活/ポートフォリオ/
└─ drawing-prompt-quiz/
   ├─ README.md
   ├─ .env.local                    # 秘密鍵（gitignore）
   ├─ .env.example
   ├─ .gitignore
   ├─ docs/
   │   ├─ spec.md                   # この文書
   │   ├─ decisions.md              # 決定とその理由のログ
   │   └─ tags-master.md            # タグマスタ原案（固有名詞は入れない）
   ├─ supabase/
   │   └─ migrations/            # テーブルとRLSは同じファイルに書く（R3）
   │       ├─ 001_profiles.sql            # Step 2
   │       ├─ 001_profiles_rollback.sql
   │       ├─ 002_masters.sql             # Step 3B-1
   │       ├─ 003_draft.sql               # Step 3B-2a
   │       ├─ 004_prompts_quiz.sql        # Step 3B-2b
   │       ├─ 005_works_answers.sql       # Step 3B-3a
   │       ├─ 006_reactions.sql           # Step 3B-3b
   │       ├─ 007_tags_seed.sql           # Step 3D
   │       └─ *_rollback.sql              # 各工程の取り消し用
   └─ src/
      ├─ app/
      │   ├─ layout.tsx
      │   ├─ page.tsx                    # 通常フィード
      │   ├─ ai/page.tsx                 # AIフィード
      │   ├─ draft/page.tsx
      │   ├─ p/[id]/page.tsx             # 作成者のみ
      │   ├─ works/
      │   │   ├─ new/page.tsx
      │   │   └─ [id]/
      │   │       ├─ page.tsx
      │   │       └─ opengraph-image.tsx
      │   ├─ rankings/page.tsx
      │   ├─ u/[handle]/page.tsx
      │   ├─ me/settings/page.tsx
      │   ├─ login/page.tsx
      │   └─ auth/callback/route.ts
      ├─ components/
      │   ├─ ui/
      │   └─ layout/
      ├─ features/
      │   ├─ auth/                       # 匿名サインイン・昇格
      │   ├─ draft/                      # モード/時間選択・カードめくり・リロール
      │   ├─ prompt/                     # お題カード表示・共有・未選択開示
      │   ├─ work/                       # 投稿・フィード・詳細
      │   ├─ quiz/                       # 出題・回答・正答率
      │   ├─ reaction/                   # like / save
      │   ├─ ranking/
      │   ├─ report/
      │   └─ portfolio/                  # ポートフォリオ・公開設定
      ├─ lib/
      │   ├─ supabase/
      │   │   ├─ client.ts
      │   │   ├─ server.ts
      │   │   └─ admin.ts
      │   ├─ constants/
      │   │   ├─ modes.ts
      │   │   ├─ slots.ts
      │   │   └─ durations.ts
      │   └─ utils/
      └─ types/
          └─ database.ts
```

**迷ったときの判断基準**
1. URLになるもの → `app/`
2. 特定の機能にだけ関係するもの → `features/その機能/`
3. どの機能からも使うもの → `components/ui/` か `lib/`
