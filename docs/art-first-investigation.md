# 既存絵からクイズを作る（逆方向モード）／ 実装前調査

調査日 2026-09-07 ／ 基準は作業ツリーの `main`（コミット `db623a4` 以降の未コミット差分を含む）

**この文書は調査であって仕様書ではない。コードを1行も変えていない。**
migration も作っていない。名称・列名・UI の扱いは決めていない（第9節）。

出所: 2026-09-07 のユーザー投稿 J「実装前に、現行コードとDBを調査し、以下を
報告すること」および M「調査結果を出すまでは実装しない」。

読んだもの: `supabase/migrations/` の全28ファイル（該当箇所のみ）、
`src/app/works/new/`、`src/features/work/rpc.ts`、`test/db/helpers.mjs`、
`scripts/db-checks.mjs`、`docs/decisions.md`（D165 / D169 の該当節）、
`docs/vocab-inventory.md`。**本番DBは叩いていない**（鍵が要るため）。
数はすべて上のファイルから読んだ値で、本番の実測ではない。

---

## 1. 現状

### 1-1. お題と作品は、1対1で固く結ばれている

`works.prompt_id` は `not null unique` で `prompts.id` を指す
（`supabase/migrations/20260803013433_baseline_applied_schema.sql:2731` 付近）。
1つのお題から作れる作品は1件だけ。逆に**お題の無い作品は作れない。**
この列はどの取得経路でもクライアントへ返さない（D23）。作品からお題の答えへ
辿る足がかりを作らないため。

### 1-2. お題が作られる経路は、いま1本しかない

利用者の操作からお題ができるのは `complete_draft(session_id)` だけ
（`20260905095000_d165_all_words_quiz.sql:558`）。その中身は4段。

```
draft_sessions（引いている最中の場）
  └ draft_candidates（配られた候補。is_chosen が選ばれたもの）
        │  complete_draft がここを読む
        ▼
     prompts     1行（誰が・どのモードで・制限時間・出どころ origin）
     prompt_cards N行（確定した語。クイズの答えそのもの）
        │  build_quiz_for_prompt(prompt_id) を呼ぶ
        ▼
     quiz_questions（1語=1問）
     quiz_choices  （1問4択。うち1つが正解）
```

### 1-3. クイズの生成は、ドラフトを1つも見ていない

`build_quiz_for_prompt(p_prompt_id)`（`20260905095000_d165_all_words_quiz.sql:111`）が
読むのは `prompt_cards` と `card_slots` と `tags` の3つだけ。
`draft_sessions` も `draft_candidates` も参照しない。
つまり**「prompts と prompt_cards さえ揃えばクイズは作れる。」**

誤答の作りかたは、正解と同じ分類（`pool_key`）から、そのお題で使った語と
同義グループの語を除いて最大3件。2件未満なら例外で止まる。

### 1-4. 投稿の受け口は、お題の持ち主と状態だけを見る

`create_work`（`20260803025753_works_write_rpcs.sql:245`）の6検査は
「登録済みか／そのお題の作成者か／お題が active か／まだ作品が無いか／
部門とファンアート項目の整合／画像の置き場所が規約どおりか」。
**お題がどうやって作られたかは1つも見ていない。**
通ったあと、お題を `submitted` にして未選択カードを開示する。

### 1-5. 出どころの列は、すでに存在する

`prompts.origin`（`20260808120000_f0_prompt_origin_and_indexes.sql`）。
`not null default 'draft'`、CHECK は `('draft', 'saved', 'daily')`。

意味は「お題の出どころ」で、いま書いているのは `complete_draft` だけ
（持ち出しを使ったら `saved`、それ以外は `draft`）。
**読んでいる関数は1つも無い。**画面にも出ていない
（`src` 全体を検索して、この列を読む箇所は0件）。
`daily` は値として許してあるが、書く経路はまだ無い。

### 1-6. 実測に近い証拠: 試験はすでに「ドラフト無しのお題」を作っている

`test/db/helpers.mjs:231` の `buildPromptWithTags` は、`prompts` に1行入れ、
`prompt_cards` を語の数だけ入れ、`build_quiz_for_prompt` を呼ぶ。
ドラフトを1つも作らない。この方法で作ったお題で、
回答・採点・集計・結果表示の試験（`test/db/run.mjs` 145件）が通っている。

**逆方向モードで必要なDB操作は、この3手と同じである。**
違うのは、語を選ぶのが抽選ではなく作者だという点だけ。

### 1-7. J の10問への答え

| # | 問い | 答え |
|---|---|---|
| 1 | prompt と work の関係 | `works.prompt_id` が `not null unique` で `prompts.id` を指す。1お題1作品。クライアントには返さない（D23） |
| 2 | 「通常のお題由来」を前提にしている箇所 | 3か所だけ。(a) `/works/new` が `?promptId=` を必須にし `get_my_prompt` で本人確認する（`src/app/works/new/page.tsx`）。(b) お題の画面 `/prompt/[id]` が投稿の入口を出す。(c) `get_my_prompt` の「引かなかったカード」が `draft_candidates` を読む（`draft_session_id` が null なら空配列を返すので壊れない）。**DB の受け口 `create_work` にはこの前提が無い** |
| 3 | クイズ生成はどこで prompt を参照するか | `build_quiz_for_prompt(prompt_id)` の中だけ。参照先は `prompt_cards` / `card_slots` / `tags`。ドラフト側の表は見ない |
| 4 | 作者が既存語彙から選んで prompt 相当データを作れるか | 作れる。`prompts` 1行 ＋ `prompt_cards` N行を入れて `build_quiz_for_prompt` を呼べば、以降の経路（出題・回答・採点・集計・開示）はそのまま動く。試験が既にその形（1-6） |
| 5 | origin を足すならどこが最小か | 列は足さない。既存の `prompts.origin` の CHECK に値を1つ増やすだけ |
| 6 | 既存の origin フィールドの意味と流用可能性 | 「お題の出どころ」。いま `draft` / `saved` / `daily` の3値で、書き手は `complete_draft` のみ、読み手は無し。流用できる。ただし `saved` は「持ち出しを使った」という**別の軸**なので、将来この2つが同時に成り立つ設計になるなら列を分ける必要がある（逆方向モードは持ち出しを使わないので、いまは衝突しない） |
| 7 | 一覧・ランキング・回答不足救済への影響 | 一覧（`get_public_works`）と救済（`next_work_candidates` / `get_next_work`）は `prompts.origin` を読まないので、そのままでは混ざって出る。ランキングは `prompts.time_limit_seconds` で時間区分を決めるので、制限時間の無い持ち込み作品は全部「無制限」に入る（第5節） |
| 8 | AI部門・ファンアート部門との独立性 | 独立している。部門は `works.division`、出どころは `prompts.origin` で、表も列も別。持ち込み作品がファンアートやAI部門であってもよい |
| 9 | D165 全語出題へそのまま流せるか | 流せる。出題数は `prompt_cards` の枚数で決まる（`build_quiz_for_prompt` の返り値が問数）。語を3〜6個入れれば3〜6問になる |
| 10 | 過去作品との互換性 | 影響なし。列を足さず、既存行を書き換えない。CHECK に値を増やす操作は既存の行を検査し直すが、既存は全部 `draft` か `saved` なので通る |

---

## 2. 最小変更案

**入口だけを足し、投稿後の仕組みは1つも作り直さない。**

### 2-1. DB（migration 1本。表も列も増やさない）

1. `prompts_origin_check` を作り直して、値を1つ増やす。
2. `draft_modes` に持ち込み用の行を1つ足す（`is_active = false`）。
   理由は第5節の 5-4（診断 A4 / A4b が語数をモードの範囲で見ているため）。
3. 新しい RPC を2本。
   - 語の一覧を返す読み取り1本
   - お題を作って作品まで通す書き込み1本

### 2-2. 書き込み RPC は「お題と作品を1回で作る」形にする

**お題だけを先に作って画面を分けない。**理由は 5-1（作りかけの `active` な
お題が残ると、全ページ共通の帯に「制作中」が居座り、消す掃除も無いため）。

```
画面（既存絵を選ぶ → 語を選ぶ → 題名など）
   │  画像を Storage へ上げる（既存の works/new と同じ手順）
   ▼
create_art_first_work(work_id, tag_ids[], title, image_path, w, h, division, …)
   ├ 語の検査（本数・分類ごとの上限・語が実在して有効か）
   ├ insert prompts   （origin = 持ち込み、time_limit_seconds = null）
   ├ insert prompt_cards（選ばれた語。分類ごとに枠キーを割り当てる）
   ├ build_quiz_for_prompt(prompt_id)     ← 既存のまま
   └ create_work(...)                      ← 既存のまま（6検査もそのまま通る）
```

`create_work` を中から呼ぶので、投稿の検査・お題の `submitted` 化・
未選択カードの開示（持ち込みでは対象が0件）・作品の行の作りかたは
**1行も書き直さない。**

### 2-3. 画面（新規2枚 ＋ 既存1枚に入口）

- `/works/import`（仮）… 既存絵を選び、語を選び、題名・部門・完成度を入れる1枚。
  語の選択欄以外は `/works/new` の `_form.tsx` の作りをそのまま使える。
- 入口を `/play` かトップに1つ足す（「描いた絵で試す」）。
- 語の選択欄だけが新規の部品。

---

## 3. 流用できるところ（作り直さない）

| 何 | 実体 |
|---|---|
| クイズの生成 | `build_quiz_for_prompt` |
| 出題 | `get_work_quiz` |
| 回答と採点 | `submit_answer`（ビタ当て／2択当ても含む） |
| 集計 | `work_slot_stats` / `user_slot_stats` とトリガー |
| 結果表示 | `get_my_work_result` / `get_my_answer` |
| 答え合わせの開示 | `get_answered_prompt`（`prompt_cards` を読むだけ） |
| 投稿の検査と作品行 | `create_work` の6検査 |
| 画像の受け取り | `uploadWorkImage` と `{user_id}/{work_id}.拡張子` の規約 |
| 一覧・ランキング・次の作品 | `get_public_works` / `get_rankings` / `get_next_work` |
| 作者本人のお題表示 | `get_my_prompt`（未選択カードは空配列になる） |

---

## 4. 新しく作るもの

1. migration 1本（第2節の1〜3）。
2. 読み取り RPC 1本 … 選べる語の一覧。
   `tags` は `id / pool_key / label` が anon にも読めるが
   （`20260905096000_vocab_provenance.sql:143`）、
   `draw_categories` の読み取り列に `pool_key` が入っていないため
   （`20260904090000_draw_categories.sql:159`）、
   「どの分類の語か」をクライアント側で結べない。RPC で結んで返す。
   **これは新しい情報の公開ではない。**語そのものは既に誰でも読める。
3. 書き込み RPC 1本 … `create_art_first_work`。
4. 画面2枚（持ち込みの投稿画面、入口）。語の選択部品1つ。
5. 検査（第8節）。

### 語の選択部品について（分量の見積もり）

いま選べる語は `docs/vocab-inventory.md` の数え直しで
モーフ127・状態8分類で194・カラー16の**337語**。
（`motif` 102 / `species` 24 / `genre` 15 の141語は 2026-09-04 より前の
旧語彙で、生成用カテゴリを持たないため対象外。試験の
`buildPromptWithTags` と同じ絞り込みになる。）

337語から3〜6語を選ばせるので、**分類で畳んだ一覧と絞り込みが要る。**
ここがこの機能でいちばん手間のかかる画面になる。

---

## 5. 競合（先に潰さないと壊れるもの）

### 5-1. 全ページ共通の帯（挑戦中の表示）

`get_active_challenge`（`20260905090000_challenge_clock.sql:673`）は
「進行中のドラフト → `status = 'active'` のお題」の順に1件返す。
持ち込みのお題を先に作って画面を分けると、投稿をやめた人のところに
`active` なお題が残り、帯に「制作中」が出続ける。
`cleanup_orphan_prompts`（`20260804120000_cleanup_jobs.sql:79`）は
`created_by is null` の行しか消さないので、**持ち主のいるこの行は誰も消さない。**

→ 2-2 の「1回で作る」形にすれば、`active` の状態は同一トランザクション内で
終わるので、この問題は起きない。

### 5-2. 経過時間が 0 秒になる

`prompts_record_elapsed`（`20260905090000_challenge_clock.sql:464`）は
投稿時に `started_at` からの経過を記録する。持ち込みは開始も投稿も同じ瞬間なので
`elapsed_seconds` がほぼ 0 になる。作者本人のお題画面は「かかった時間」を出す
（`src/app/prompt/[id]/_timer.tsx:84`）。**0秒と表示されると嘘になる。**

→ 持ち込みのお題ではタイマーの箱と経過時間を出さない、が最小の対処。
どう見せるかは未確定（第9節）。

### 5-3. ランキングの時間区分

`get_rankings`（`20260803204740_ranking_rpc.sql:171`）は
`prompts.time_limit_seconds` が null なら「無制限」に入れる。
持ち込み作品は制限時間を持たないので**全部「無制限」に入る。**
何日もかけた既存絵と、無制限で引いて描いた作品が同じ土俵に並ぶ。

→ 初期実装で分けないなら、そのことを承知のうえで出す判断が要る。
分けるなら、それは第9節の未確定（origin 別ランキング）に当たる。

### 5-4. 診断 A4 / A4b（語数とモードの範囲）

`scripts/db-checks.mjs:2214` と `:2226`。

- A4 … 枠が固定のモード（`uses_two_stage = false`）は、答えの枚数が
  `draft_mode_slots` の行数と一致すること。
- A4b … 2段抽選のモード（`uses_two_stage = true`）は、答えの枚数が
  そのモードの `word_count_min`〜`word_count_max` に収まること。

持ち込みのお題を `normal`（3〜4語）で作ると、5語や6語を選んだ時点で
A4b が不合格になる。かといって `uses_two_stage = false` の新モードにすると、
`draft_mode_slots` に行が無いので A4 が不合格になる。

→ 新しいモード行を `uses_two_stage = true` ＋ 語数 3〜6 で入れるのが、
検査を1行も直さずに済む唯一の形。`is_active = false` にしておけば
`start_draft` は受け付けない（モードの検査が `is_active` を見るため）ので、
お題を引く画面には出ない。

**名前が実態とずれる点は言っておく。**「2段抽選を使う」という列を true に
するが、持ち込みは抽選をしない。列の意味は「枠を固定しない」であって
抽選の有無ではない、と読み替えることになる。読み替えたくないなら、
A4 / A4b の側に「持ち込みは対象外」を書き足す形になり、そのときは
検査を1行直す。どちらを採るかは未確定。

### 5-5. D169（回答不足救済）と回答の供給

`next_work_candidates`（`20260906090000_...`）は
「回答0件の帯」を最優先で配る。出どころを見ていない。
持ち込み作品は制作コストが低いので大量に入りうる。入れば
0回答の帯を持ち込みが占め、お題から描いた作品へ回答が届きにくくなる。

投稿の A-9 は「初期実装時には無理に分離ロジックを作らなくてよいが、
出どころ別の投稿量・0回答率・回答供給量を観測できること」を将来要件と
している。**観測は列を足さずにできる。**`works` → `prompts.origin` を
security definer の関数の中で結べばよい（`works.prompt_id` は外へ出さない）。
観測用の関数を作るかどうかは、この調査の範囲外。

### 5-6. カラーの枠は1つしかない

枠（`card_slots`）は `morph_1〜3`、8つの状態が各 `_1〜3`、そして
`color_1` の1つだけ（`20260904090000_draw_categories.sql:237` と
`20260905095000_d165_all_words_quiz.sql:88`）。
`prompt_cards` は `(prompt_id, card_slot_key)` が一意なので、
**色を2つ選ばせると入れる枠が無い。**

→ 色は1つまで、が最小。抽選側の `draw_categories.max_per_prompt` も
カラーは1なので、規則としても揃う。

### 5-7. 誤答が作れない組み合わせがある

`build_quiz_for_prompt` は、正解と同じ分類から誤答を最低2件作れないと
例外で止まる。分類ごとの語数は状態が24〜25語なので、同じ分類から3語選んでも
残りは21語あり、いまの語彙では起きない。ただし
**同義グループを除いた結果2件を割る可能性は残る**ので、
語を選び終えた時点で「この組み合わせでは出題を作れません」と返す道が要る。
（例外がそのまま投稿失敗として出ると、利用者には理由が分からない。）

### 5-8. AI部門・ファンアート部門

衝突しない。部門は `works.division`、出どころは `prompts.origin`。
既存絵がファンアートなら `division = 'fanart'` で投稿でき、
元作品名の必須検査もそのまま効く。AI部門を一覧から分ける既存の仕様も
そのまま働く。

---

## 6. データ形式の案（現行の命名・型に沿った具体案）

**名前は決めていない。**下は「現行の書きかたに合わせるとこうなる」という形で、
採否と語はユーザーの判断（第9節の1と2）。

```sql
-- (1) 出どころの値を1つ増やす。列は足さない
alter table public.prompts drop constraint prompts_origin_check;
alter table public.prompts
  add constraint prompts_origin_check
  check (origin in ('draft', 'saved', 'daily', '<持ち込みの値>'));

-- (2) 持ち込み用のモード。お題を引く画面には出さない
insert into public.draft_modes
  (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
   sort_order, is_active, uses_two_stage, word_count_min, word_count_max, morph_max)
values
  ('<持ち込みのモードキー>', '<表示名>', 2, 0, 3, 5, false, true, 3, 6, 3);
```

- `candidate_count` は 2〜10 の CHECK があるので、使わなくても2を入れる。
- `quiz_question_count` は D165 以降どこも使っていない残りの列だが、
  `not null` なので値が要る（`20260905095000_d165_all_words_quiz.sql:11`）。
- `max_rerolls = 0`（引き直しの概念が無い）。
- `sort_order = 5` は空いている（easy 1 / standard 2 / normal 3 / hard 4）。
- `word_count_min/max = 3/6` は投稿の K「3〜6項目程度」から。
- `morph_max = 3` は枠が `morph_1〜3` までしか無いことによる上限。

```
-- (3) 書き込み RPC の形（引数と検査だけ。中身は第2節の図のとおり）
create_art_first_work(
  p_work_id             uuid,
  p_tag_ids             bigint[],     -- 作者が選んだ語。3〜6件
  p_title               text,
  p_image_path          text,
  p_image_width         int,
  p_image_height        int,
  p_division            text,
  p_source_title        text default null,
  p_source_character    text default null,
  p_fanart_note         text default null,
  p_actual_time_seconds int default null,
  p_is_published        boolean default true
) returns jsonb        -- create_work と同じく work_id と is_published だけを返す
```

語の検査（この関数が持つぶん）:

1. 3〜6件であること。重複が無いこと。
2. すべて `tags.is_active` で、分類が `draw_categories.is_active` の中にあること
   （旧語彙は選べない）。
3. 分類ごとの上限。カラーは1件、それ以外は3件まで
   （枠が `_1〜3` までしか無いため）。
4. モーフを1件以上にするかどうかは**未確定**（抽選側は必須にしている）。
5. 枠キーの割り当ては、分類ごとに出てきた順で `<pool_key>_1`, `_2`, `_3`。
   `slot_order` は選んだ順の通し番号。
   （試験の `buildPromptWithTags` と同じ規則。`test/db/helpers.mjs:255` 付近）

`prompts` へ入れる値:

| 列 | 値 | 理由 |
|---|---|---|
| `created_by` | `auth.uid()` | 本人以外がお題を作れないため |
| `mode_key` | 持ち込みのモード | 5-4 |
| `time_limit_seconds` | `null` | 制作時間の概念が無い。期限のトリガーも素通りする |
| `origin` | 持ち込みの値 | 出どころを失わないため（投稿の A-7） |
| `status` | `'active'` | 直後に `create_work` が `submitted` にする |
| `draft_session_id` | `null` | ドラフトを通っていない。列は null 可 |
| `was_rerolled` / `reroll_count` | `false` / `0` | 引き直しが無い |

---

## 7. 移行

- **既存の作品・お題・回答・集計に影響しない。**列を足さず、行を書き換えない。
- CHECK を作り直すとき、Postgres は既存行を検査し直す。既存の `prompts` は
  `draft` か `saved` しか持たないので通る（`origin` は `not null default 'draft'`
  で入り、書き手は `complete_draft` だけ）。
- 新しいモード行は `is_active = false` なので、お題を引く画面の選択肢は変わらない。
- 戻しかた: モード行を消す（参照するお題があれば消せない）、CHECK を元の3値に戻す、
  RPC を2本 drop する。**この3つだけで元に戻る。**ただし持ち込みで作った
  お題が1件でもあると CHECK を戻せない。戻す前にその行の扱いを決める必要がある。

---

## 8. 最低限必要な検査

DB の試験（`test/db/run.mjs` に足す）:

1. 語を3件選んで持ち込みのお題と作品ができ、`prompt_cards` が3件、
   出題が3問できる。`origin` に持ち込みの値が入っている。
2. 語を6件でも同じように通る。7件は断られる。2件も断られる。
3. 同じ語を2回入れたら断られる（`prompt_cards` の一意制約より前に、
   分かる言葉で断る）。
4. カラーを2件入れたら断られる（枠が1つしかないため）。
5. 旧語彙（`motif` など生成用カテゴリの無い分類）の語は選べない。
6. 他人の `work_id` や規約外の `image_path` は `create_work` の検査で止まる
   （持ち込み経路でも6検査が効いていることの確認）。
7. できたクイズに他人が回答でき、採点・集計・結果表示が通常の作品と同じに動く。
8. 途中で失敗したとき、`prompts` の行も `prompt_cards` も残らない
   （1つの関数＝1トランザクションであることの確認）。
9. 診断を通す。特に A4 / A4b（語数とモードの範囲）と A5（submitted なのに
   作品が無いお題）が増えないこと。

画面の試験（`test/e2e/browser.mjs` に足す）:

10. 持ち込みの投稿画面で語を選んで投稿すると、作品ページへ着く。
11. 語を選ばずに投稿しようとすると、断りの文が出る。
12. 投稿後、全ページ共通の帯に「制作中」が残っていない（5-1 の確認）。

本番前:

13. `npm run db:verify`（診断）と、既存の smoke が落ちないこと。

---

## 9. この調査では決めていないこと

投稿の L に挙がっているもののうち、この機能に直接かかるもの。

1. モードの正式名称（`mode_key` と表示名）
2. `origin` に入れる値の名前
3. 持ち込み作品を一覧で明示表示するか
4. `origin` 別タブ・別ランキングを作るか
5. D169 の救済で出どころごとの割当をするか
6. AI 画像解析による候補提示を初期実装するか（投稿の A-5 では将来案）
7. 自由入力語を許すか（投稿の A-6 では初期は行わない）

この調査で見つかった、上に無い未確定。

8. モーフを1件以上必須にするか（抽選側は必須。持ち込みも揃えるかは未定）
9. 持ち込みのお題でタイマー・経過時間をどう扱うか（5-2）
10. 5-4 の読み替え（`uses_two_stage` を true にする）を受け入れるか、
    診断側に例外を書くか
