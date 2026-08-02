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
| B1 | モード | MVPは「お手軽3枚」「標準5枚」の2モードのみ |
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
| A1 | 伏せカードは1スロットあたり4枚。そこから1枚選ぶ |
| A2 | クイズは4択×3問 |
| A3 | `constraint`（制約）はカードとしては引くが、クイズ対象からは除外する |
| A4 | 1作品につき1ユーザー（匿名ID含む）1回のみ回答できる |
| A5 | 1投稿1画像。複数枚・差分投稿はMVP外 |
| A6 | 通報の処理は手動運用。管理画面は作らない |
| A7 | 投稿削除は論理削除（`deleted_at`）＋Storage画像の削除 |
| A8 | AI部門は自己申告。自動検出はしない |
| A9 | 「他の候補を見る」を押しても、その後の投稿は引き続き可能 |
| A10 | サーバータイマーはMVP未実装。列だけ用意する |

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

| slot_key | 表示名 | pool_key | quiz_priority | クイズ対象 |
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

**この分離によって得られること**

- 「傘」というタグを motif_a 用・motif_b 用に二重登録しなくてよい
- 「深い青」を main_color 用・sub_color 用に二重登録しなくてよい
- タグの追加はプールに1行足すだけで、全スロットに反映される

### 3-3. モード定義

| mode | 表示名 | スロット | MVP |
|---|---|---|---|
| `easy` | お手軽（3枚） | motif_a, motif_b, main_color | 実装する |
| `standard` | 標準（5枚） | ＋ species, genre_type | 実装する |
| `advanced` | 本格（8枚） | ＋ sub_color, role, era_env | 後日 |
| `full` | フル（10枚） | ＋ gender_expr, constraint | 後日 |

### 3-4. 制作時間（カードではない）

**ドラフト開始前にユーザーが選択する設定値。**抽選しない。クイズ対象にもならない。

| time_limit_type | 表示 |
|---|---|
| `t10` | 10分 |
| `t30` | 30分 |
| `t60` | 60分 |
| `t120` | 120分 |
| `unlimited` | 無制限 |
| `custom` | 自由設定（分を入力。1〜10000） |
| `timer` | サーバータイマー参加（**MVP未実装。列のみ用意**） |

結果画面・お題カード・作品詳細では**バッジ**として表示する（伏せない）。
投稿時に申告する「実績制作時間」は別データ（§7 works）。

---

## 4. カードドラフト

### 4-1. 候補生成アルゴリズム（サーバー側で1回だけ実行）

```
入力: mode, ruleset
1. slots = モードに対応するスロット一覧
2. slots を pool_key でグループ化する
3. 各プール P について:
     needed = 4 × (P を使うスロットの数)
       例) easy モードの motif プール → motif_a と motif_b の2スロット → 8件
           easy モードの color プール → main_color の1スロット      → 4件
     tags(P) から weight による重み付き抽選で needed 件を「重複なし」で取得
     取得した件を各スロットへ 4件ずつ配分する
4. draft_candidates へ INSERT（session_id, generation, slot_key, slot_index 0..3, tag_id）
5. クライアントには slot_key と slot_index だけ返す。tag_id / label は返さない
```

**保証されること**

- 同一プールを使う複数スロット間で、候補が1件も重複しない
  → motif_a で「傘」を選んだあと motif_b の候補に「傘」が残っている、という事態が起きない
- どの札を選んでも結果は異なる（4枚に別々のタグが入っている＝偽の選択ではない）
- 選択前にクライアントは中身を知り得ない（レスポンスに含まれない）

### 4-2. 開封（reveal_card）

ユーザーが `slot_index` を1つ選ぶと、サーバーが該当行を `is_chosen = true` にして、
**その1件の label だけ**返す。他の3件は伏せたまま。開封は不可逆。

### 4-3. リロール（引き直し）

| 項目 | 仕様 |
|---|---|
| 単位 | **ドラフト全体**。カード単位の引き直しは不可 |
| 回数 | MVPは **1回まで**（`draft_sessions.max_rerolls = 1`） |
| 挙動 | `generation` を +1 して候補を全スロット分ゼロから再抽選。旧世代の行は残すが無効化する |
| 記録 | 確定時に `prompts.was_rerolled` と `prompts.reroll_count` に記録する |
| 表示 | お題カード・作品詳細に「引き直しあり」を控えめに表示する |
| 将来拡張 | `draft_sessions.ruleset` で制御。`'standard'` → max_rerolls=1、`'one_shot'`（一発ドラフト） → max_rerolls=0 |

リロールを1回に制限する理由: 無制限にすると「当たりが出るまで回す」ゲームになり、
正答率という指標の意味が薄れるため。

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
quiz_priority の昇順に並べ、上位3件を採用
  easy     → motif_a, motif_b, main_color
  standard → motif_a, motif_b, main_color （species / genre_type は優先度下位のため出題されない）
```

### 5-2. 選択肢の生成

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
    [結果画面]
      ・確定したお題カード一覧
      ・制作時間バッジ（例: 60分）
      ・引き直しバッジ（引き直した場合のみ）
      ・お題コード: A7K3M9
      ・[カード画像を保存] [URLをコピー] [Xで共有]
      ・[このお題で描く] → 投稿導線
      ・[他の候補を見る]  ← 押すと未選択カードを開示（本人のみ・不可逆）
      ・[このお題は描かない] → チャレンジ放棄。未選択カードを開示
      ↓
    [このお題で描く]
      ├ 未ログイン（匿名）→ ここで初めて登録を促す（投稿はアカウント必須）
      └ ログイン済 → /works/new?prompt=A7K3M9
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
| `/p/[code]` | お題カード | 作成者のみ | |
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

```
profiles              プロフィール（匿名ユーザーも1行持つ）＋公開設定
tag_pools             タグプール定義（マスタ）
card_slots            カードスロット定義（マスタ）
tags                  タグ本体（プールに属する・重み付き）
draft_sessions        ドラフト進行状態
draft_candidates      伏せカードの中身【機密】
prompts               確定したお題
prompt_cards          お題を構成する確定カード【機密】
quiz_questions        出題される3問
quiz_choices          各問の4択【is_correct が機密】
works                 投稿作品
answers               回答（1作品1ユーザー1件）
answer_items          回答の内訳【機密：正解が推測できるため本人限定】
work_slot_stats       作品×スロットの正答集計
user_stats            ユーザーの通算成績
user_slot_stats       ユーザー×スロットの成績
likes                 いいね（登録ユーザーのみ）
saves                 保存（登録ユーザーのみ）
reports               通報
```

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
| key | text PK | `motif_a` など |
| label | text | 表示名 |
| pool_key | text FK → tag_pools | **どのプールから引くか** |
| sort_order | int | ドラフトの提示順 |
| quiz_priority | int | 小さいほど優先して出題 |
| is_quiz_eligible | boolean | `constraint` のみ false |

**tags**

| 列 | 型 | 備考 |
|---|---|---|
| id | bigint PK | |
| pool_key | text FK → tag_pools | **スロットではなくプールに属する** |
| label | text | |
| weight | int | 既定100。レアは小さく |
| is_active | boolean | 既定true |
| note | text | 運用メモ |

UNIQUE(pool_key, label)

> **運用ポリシー**: タグに既存IPの固有名詞を登録しない。
> 代わりに `genre` プールへ「変身戦士」「魔法少女」「巨大ロボ」「怪獣災害」「学園異能」
> 「収集・育成型怪物」などの一般的な類型を入れる。
> 利用者が自主的に既存IPへ寄せた場合はファンアート部門で投稿してもらう。

### 8-3. ドラフト・お題

**draft_sessions**

| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| owner_id | uuid FK → profiles | 匿名含む |
| mode | text | `easy` / `standard` |
| ruleset | text | `standard`（既定） / `one_shot`（将来） |
| time_limit_type | text | ユーザーが選択 |
| time_limit_minutes | int | `custom` のときのみ |
| max_rerolls | int | ruleset から決定（standard=1, one_shot=0） |
| reroll_count | int | 既定0 |
| current_generation | int | 既定1。リロールで +1 |
| status | text | `in_progress` / `completed` / `abandoned` |
| prompt_id | uuid FK | 完了時に紐付け |
| created_at | timestamptz | |

**draft_candidates** 【機密】

| 列 | 型 | 備考 |
|---|---|---|
| id | bigint PK | |
| session_id | uuid FK | |
| generation | int | 世代。開示対象は最終世代のみ |
| slot_key | text FK → card_slots | |
| slot_index | int | 0〜3 |
| tag_id | bigint FK → tags | **クライアントに渡らない** |
| is_chosen | boolean | |

UNIQUE(session_id, generation, slot_key, slot_index)

**prompts**

| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| code | text UNIQUE | 公開コード（例 `A7K3M9`） |
| mode | text | |
| ruleset | text | |
| time_limit_type | text | 公開情報 |
| time_limit_minutes | int | |
| was_rerolled | boolean | 引き直しの有無 |
| reroll_count | int | |
| status | text | `active` / `submitted` / `abandoned` |
| created_by | uuid FK → profiles | 匿名も可 |
| candidates_revealed_at | timestamptz | null なら未開示 |
| reveal_reason | text | `work_submitted` / `abandoned` / `manual` |
| created_at | timestamptz | |

**prompt_cards** 【機密】

| 列 | 型 |
|---|---|
| id | bigint PK |
| prompt_id | uuid FK |
| slot_key | text FK → card_slots |
| tag_id | bigint FK → tags |
| position | int |

UNIQUE(prompt_id, slot_key)

**quiz_questions / quiz_choices**

```
quiz_questions(id, prompt_id, slot_key, position 0..2)
    UNIQUE(prompt_id, position)

quiz_choices(id, question_id, tag_id, is_correct 【機密】, position 0..3)
    UNIQUE(question_id, position)
```

公開ビュー `public_quiz_view`: `question_id, prompt_id, slot_key, slot_label, choice_position, tag_id, tag_label`
（**is_correct を含めない**）

### 8-4. 投稿・回答

**works**

| 列 | 型 | 備考 |
|---|---|---|
| id | uuid PK | |
| prompt_id | uuid FK | |
| user_id | uuid FK → profiles | **登録ユーザーのみ** |
| title | text | 最大60字 |
| image_path | text | Storage内パス |
| image_width / image_height | int | |
| division | text | `original` / `fanart` / `ai` |
| **source_title** | text | ファンアートの元作品名。`fanart` のとき必須 |
| **source_character** | text | 元キャラクター名。任意 |
| **fanart_note** | text | 補足・注意書き。任意 |
| duration_type | text | 実績。`t10`/`t30`/`t60`/`t120`/`unlimited`/`custom`/`timer` |
| duration_minutes | int | `custom` のとき |
| is_published | boolean | 既定true |
| deleted_at | timestamptz | 論理削除 |
| likes_count / saves_count / answers_count | int | トリガー更新 |
| created_at | timestamptz | |

CHECK: `division <> 'fanart' OR source_title IS NOT NULL`
CHECK: `division = 'fanart' OR (source_title IS NULL AND source_character IS NULL AND fanart_note IS NULL)`

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

公開用ビュー:

```
public_answer_history      -- show_answer_history = true のユーザーのみ
    (user_id, work_id, correct_count, created_at)
    ※ selected_tag_id と is_correct は含めない（正解漏洩の防止）
```

### 8-6. Storage

| バケット | 公開 | パス | 用途 |
|---|---|---|---|
| `works` | public read | `{user_id}/{work_id}.{ext}` | 投稿画像 |
| `prompt-cards` | public read | `{prompt_code}.png` | お題カードの共有画像・OGP |

上限5MB / `image/jpeg`・`image/png`・`image/webp` のみ。

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

| 関数 | 役割 |
|---|---|
| `start_draft(mode, time_limit_type, time_limit_minutes, ruleset)` | セッション作成＋候補をプール単位で重複なし抽選 |
| `reroll_draft(session_id)` | 残り回数を検査し、generation を進めて再抽選 |
| `reveal_card(session_id, slot_key, slot_index)` | 1枚めくる。選んだ1件の label だけ返す |
| `complete_draft(session_id)` | prompts / prompt_cards / quiz_questions / quiz_choices を確定生成 |
| `reveal_unchosen(prompt_id, reason)` | 未選択カードを開示（本人のみ・不可逆） |
| `abandon_prompt(prompt_id)` | チャレンジ放棄＋開示 |
| `submit_answer(work_id, selections)` | 採点・保存・統計更新・正解返却 |
| `toggle_like(work_id)` / `toggle_save(work_id)` | 登録判定＋カウンタ整合 |
| `create_report(work_id, reason, detail)` | 通報＋レート制限 |
| `promote_anonymous(handle, display_name)` | 匿名 → 新規アカウント昇格の仕上げ |

### 9-3. テーブル別ポリシー

| テーブル | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| profiles | `is_anonymous = false` **かつ** handle 確定済みは全員／それ以外は本人のみ（D12） | **トリガーのみ**（クライアント不可） | 本人（6列のみ。handle / is_anonymous は不可） | × |
| tag_pools / card_slots | 全員 | × | × | × |
| tags | 全員（`is_active` のみ） | × | × | × |
| draft_sessions | owner のみ | RPC | RPC | × |
| **draft_candidates** | **ポリシー無し（完全遮断）** | × | × | × |
| prompts | created_by のみ | RPC | RPC | × |
| **prompt_cards** | **ポリシー無し** | × | × | × |
| quiz_questions | 全員（slot と順序のみ） | RPC | × | × |
| **quiz_choices** | **ポリシー無し** → 公開ビュー経由のみ | RPC | × | × |
| works | 公開かつ未削除は全員／自作は常に | **本人 かつ 非匿名** | 本人 | 本人（論理削除） |
| answers | 本人のみ（公開履歴はビュー経由） | RPC のみ | × | × |
| **answer_items** | **本人のみ（公開設定に関わらず）** | RPC のみ | × | × |
| work_slot_stats | 全員 | RPC | RPC | × |
| user_stats | 本人 OR `show_answer_stats = true` | RPC | RPC | × |
| user_slot_stats | 本人 OR `show_answer_stats = true` | RPC | RPC | × |
| likes | 全員（集計のため） | **本人 かつ 非匿名** | × | 本人 |
| saves | 本人 OR `show_saved_works = true` | **本人 かつ 非匿名** | × | 本人 |
| reports | × | RPC のみ（匿名可） | × | × |

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
| `prompt_cards` を直接SELECT | ポリシー無し → 0件 |
| `quiz_choices` を直接SELECT | ポリシー無し → 0件。ビューに `is_correct` が存在しない |
| `draft_candidates` を直接SELECT | 0件 |
| 他人の `answer_items` を直接SELECT | 0件（公開設定に関わらず） |
| 公開された回答履歴 | 作品・日時・正答数のみ。選択タグは含まれない |
| ドラフトAPIのレスポンス | 開封した1枚の label のみ |
| 作品詳細のHTMLソース | 未回答時はお題データを一切埋め込まない |
| `submit_answer` の連打 | UNIQUE制約＋関数内チェックで既存結果を返すのみ |

---

## 10. 未登録／登録ユーザー権限表

| 行動 | 未登録（匿名） | 登録 |
|---|:---:|:---:|
| お題を引く（ドラフト） | ○ | ○ |
| 制作時間を選ぶ | ○ | ○ |
| ドラフトを引き直す（1回） | ○ | ○ |
| お題IDを発行する | ○ | ○ |
| お題カードを保存・共有 | ○ | ○ |
| 未選択カードを開示 | ○ | ○ |
| 作品を見る | ○ | ○ |
| クイズに回答する | ○ | ○ |
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
| 3 | スキーマ＋RLS＋タグマスタ投入 | 管理画面でポリシーを確認できる |
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
| 16 | Vercelデプロイ／匿名ユーザー掃除Cron／CAPTCHA | 本番で一連の流れが通る |

---

## 14. 技術的リスク

| # | リスク | 対策 |
|---|---|---|
| R1 | 正解の漏洩 | 機密テーブルは SELECT ポリシー無し。公開ビューとRPC経由のみ |
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
   │   ├─ migrations/
   │   │   ├─ 001_tables.sql
   │   │   ├─ 002_rls.sql
   │   │   ├─ 003_functions.sql
   │   │   └─ 004_triggers.sql
   │   └─ seed/
   │       ├─ 001_pools_slots.sql
   │       └─ 002_tags.sql
   └─ src/
      ├─ app/
      │   ├─ layout.tsx
      │   ├─ page.tsx                    # 通常フィード
      │   ├─ ai/page.tsx                 # AIフィード
      │   ├─ draft/page.tsx
      │   ├─ p/[code]/page.tsx
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
