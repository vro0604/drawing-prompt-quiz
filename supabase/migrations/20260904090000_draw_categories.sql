-- ============================================================================
-- draw_categories ／ お題を「モーフ」と「状態」で組み立てるための土台（D158〜D160）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 語彙の入れ物（tag_pools）に、新しい9分類ぶんの行を足す
--   2. お題生成用カテゴリの表（draw_categories）を作る
--   3. tags に「誤答用の分類」の列を2本足す（生成用カテゴリとは別物。D160）
--   4. お題カードの枠（card_slots）に、カテゴリ×出現回数ぶんの27行を足す
--   5. ドラフトのモードに「二段階抽選を使うか」と語数の範囲を足し、
--      通常（normal）と高難度（hard）の2モードを登録する
--   6. 抽選確率の設定表（draw_config）を作る
--
-- 【このファイルがやらないこと】
--   ・既存の行を1行も消さない
--   ・既存のタグの pool_key を書き換えない
--     （書き換えると、過去1,050件のお題が指す分類の意味が黙って変わる）
--   ・既存のモード easy / standard の行を消さない。is_active を false にするだけ
--   ・語彙そのものは入れない（次のファイル 20260904091000 が入れる）
--
-- 【なぜ「枠」を捨てずに残すのか】
--   D159 は「枠を先に決めてから語彙を引く」現行方式と方式が違うと書き、
--   「置き換えるか、枠をカテゴリの入れ物として読み替えるかは実装時の判断」と
--   している。ここでは**読み替える**ほうを採った。
--
--   理由は3つ。
--   (1) prompt_cards / quiz_questions / work_slot_stats / answer_items の4表が
--       すべて card_slot_key を主キーの一部に持っている。枠を捨てると、
--       既存の889作品・648回答・1,944回答項目の集計キーが行き場を失う。
--   (2) 枠の名前を「カテゴリ＋その お題の中での何個目か」（morph_1, emotion_2 …）
--       にすると、同じカテゴリが2回出ても別々の枠として記録でき、
--       prompt_cards の unique(prompt_id, card_slot_key) をそのまま使える。
--   (3) 「項目別の伝達率」が「モーフの伝達率」「感情の伝達率」として意味を持つ。
--       枠を elem_1, elem_2 のような通し番号にすると、この画面が読めなくなる。
--
--   **枠を先に決める作りは捨てる。**どの枠を使うかはドラフトごとに抽選し、
--   その結果を draft_session_slots（次のファイル）へ書く。
--   draft_mode_slots（モードごとに枠を固定する表）は、新モードでは使わない。
--
-- 【取り消し】
--   supabase/rollback/020_draw_categories_rollback.sql
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 語彙の入れ物を9つ足す
-- ----------------------------------------------------------------------------
--
-- tag_pools は「1つのタグが必ず1つだけ属する分類」。
-- ここへモーフと状態8カテゴリを足す。既存の8行（motif / color / …）は残す。
--
-- sort_order は既存が 1〜8 なので 11 から始める。

insert into public.tag_pools (pool_key, label, sort_order) values
  ('morph',        'モーフ',     11),
  ('emotion',      '感情',       12),
  ('action',       '動作',       13),
  ('body_state',   '身体状態',   14),
  ('change',       '変化',       15),
  ('environment',  '環境',       16),
  ('relation',     '関係',       17),
  ('property',     '性質',       18),
  ('social_state', '社会状態',   19)
on conflict (pool_key) do update
  set label      = excluded.label,
      sort_order = excluded.sort_order;


-- ----------------------------------------------------------------------------
-- 2. お題生成用カテゴリ（D158 / D159）
-- ----------------------------------------------------------------------------
--
-- **これは「誤答を選ぶための分類」ではない**（D160）。
-- 用途は1つだけ：お題を組み立てるとき、先にこの表から何を使うかを抽選する。
--
-- kind は3つ。
--   morph … 絵の核になる具体的な対象。すべてのお題に最低1個必要
--   state … 対象へ解釈を要求するもの。感情・動作・身体状態・変化・
--           環境・関係・性質・社会状態の**8つだけ**
--   color … 色彩語。**状態ではない独立の上位種別**
--           （このファイルでは行を作らない。20260905095000 が入れる）
--
-- 「モーフ以外はすべて状態」とは書かない。カラーがそこへ紛れ込む。
--
-- pool_key は語彙の引き先。いまは 1:1 で対応させているが、
-- **同じものだと文書化しない。**カテゴリは抽選の単位、プールは語彙の入れ物で、
-- 将来1つのカテゴリが複数のプールから引く形になっても表は壊れない。

create table if not exists public.draw_categories (
  category_key text primary key
    constraint draw_categories_key_format check (category_key ~ '^[a-z][a-z0-9_]{1,19}$'),

  -- 上位種別。'morph' / 'state' / 'color' の3つ。
  -- モーフ最低1個の判定と、モーフ上限の判定に使う。
  -- **カラーは状態ではない。**独立した上位種別として持つ
  -- （2026-09-05 のユーザー発言「カラーは状態ではありません。
  --  状態カテゴリは8つのまま維持してください」）。
  kind text not null
    constraint draw_categories_kind_valid check (kind in ('morph', 'state', 'color')),

  label text not null
    constraint draw_categories_label_length check (char_length(label) between 1 and 30),

  -- 語彙の引き先。分類が消えるとカテゴリの意味が失われるため RESTRICT
  pool_key text not null
    references public.tag_pools (pool_key) on delete restrict on update restrict,

  -- 1つのお題の中で、このカテゴリが最大何回まで出られるか。
  -- card_slots に morph_1〜morph_3 の3枠しか作らないので、上限は3。
  max_per_prompt int not null default 3
    constraint draw_categories_max_range check (max_per_prompt between 1 and 3),

  sort_order int not null
    constraint draw_categories_sort_positive check (sort_order >= 1),

  is_active boolean not null default true,

  constraint draw_categories_sort_unique unique (sort_order)
    deferrable initially deferred
);

comment on table public.draw_categories is
  'お題生成用カテゴリ（D158 / D159）。抽選はまずこの表から行う。'
  'D96 のクイズ誤答用分類とは用途が違う別物（D160）。同一視しない。';
comment on column public.draw_categories.kind is
  '上位種別。morph = 描く対象／state = 対象への解釈要求（8カテゴリ）／'
  'color = 色彩語。**カラーは状態に含めない。**モーフ最低1個の判定に使う。';
comment on column public.draw_categories.pool_key is
  '語彙の引き先。いまは 1:1 だが、概念としては別（カテゴリ＝抽選単位、プール＝語彙の入れ物）。';

insert into public.draw_categories
  (category_key, kind, label, pool_key, max_per_prompt, sort_order) values
  ('morph',        'morph', 'モーフ',   'morph',        3, 1),
  ('emotion',      'state', '感情',     'emotion',      3, 2),
  ('action',       'state', '動作',     'action',       3, 3),
  ('body_state',   'state', '身体状態', 'body_state',   3, 4),
  ('change',       'state', '変化',     'change',       3, 5),
  ('environment',  'state', '環境',     'environment',  3, 6),
  ('relation',     'state', '関係',     'relation',     3, 7),
  ('property',     'state', '性質',     'property',     3, 8),
  ('social_state', 'state', '社会状態', 'social_state', 3, 9)
on conflict (category_key) do update
  set kind           = excluded.kind,
      label          = excluded.label,
      pool_key       = excluded.pool_key,
      max_per_prompt = excluded.max_per_prompt,
      sort_order     = excluded.sort_order;

alter table public.draw_categories enable row level security;

drop policy if exists draw_categories_select_active on public.draw_categories;
create policy draw_categories_select_active
  on public.draw_categories for select to anon, authenticated
  using (is_active = true);

-- 新しい表には Supabase が既定で ALL を配る。打ち消してから読みだけ配る（D65）。
revoke all on table public.draw_categories from public, anon, authenticated;
grant select (category_key, kind, label, max_per_prompt, sort_order, is_active)
  on public.draw_categories to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. クイズ誤答用の分類（D96）。**生成用カテゴリとは別の列に持つ**（D160）
-- ----------------------------------------------------------------------------
--
-- D96 は2階層を決めている。
--   ・誤答を引いてくる母集団（distractor_class）
--   ・正解と意味が近すぎて誤答にしてはいけない集まり（synonym_group）
--
-- これを pool_key で兼ねると、「お題の作りを変えたらクイズの誤答も変わる」
-- という結びつきができてしまい、片方だけ直せなくなる。
-- **列を分けておけば、あとで別々に育てられる。**
--
-- いまは distractor_class に pool_key と同じ値を入れる。値が同じであることと、
-- 概念が同じであることは別。ここを混ぜないために列を分ける。

alter table public.tags
  add column if not exists distractor_class text;

alter table public.tags
  add column if not exists synonym_group text;

comment on column public.tags.distractor_class is
  'クイズの誤答を引いてくる母集団（D96）。お題生成用カテゴリ（draw_categories）'
  'とは用途が違う（D160）。初期値は pool_key と同値だが、同じ概念ではない。';
comment on column public.tags.synonym_group is
  '意味が近すぎて同じ問の誤答に並べてはいけない語の集まり（D96）。'
  'フレーバーの正解漏洩判定（D162）でも使う。null は「グループ無し」。';

-- 既存156件と、これから入る語彙の既定値をそろえる
update public.tags
   set distractor_class = pool_key
 where distractor_class is null;

create index if not exists tags_distractor_class_idx
  on public.tags (distractor_class) where is_active;

create index if not exists tags_synonym_group_idx
  on public.tags (synonym_group) where synonym_group is not null;

-- 列を足したので、読める列の権限を配り直す。
-- **weight は配らない。**出やすさが見えると「重みが小さいから正解ではなさそう」
-- という推測ができてしまう（baseline の tags の権限設計と同じ理由）。
-- distractor_class と synonym_group も同じ理由で配らない。
-- 近い語がどれか見えると、4択のうち2つを消せてしまう。
revoke all on table public.tags from public, anon, authenticated;
grant select (id, pool_key, label) on public.tags to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. お題カードの枠を27足す（カテゴリ × そのお題の中での何個目か）
-- ----------------------------------------------------------------------------
--
-- morph_1 / morph_2 / morph_3 / emotion_1 … social_state_3 の27枠。
--
-- 【なぜ3個ずつなのか】
--   総語数の上限が6語（高難度）で、モーフの上限が3個（通常の低確率）。
--   1つのカテゴリが4回出る組み合わせは作らないので、3で足りる。
--   draw_categories.max_per_prompt が同じ3を持っていて、抽選側もそれを見る。
--
-- 【quiz_priority】
--   既存9枠が 1〜9 を使っているので 21 から振る。
--   出題する枠はこの順（モーフ → 感情 → 動作 → …）で選ぶ。
--   既存 complete_draft と同じ選び方をそのまま引き継いだもので、
--   新しい決定ではない。

--
-- 【表示名に番号を入れない】
--   `morph_1` `morph_2` の表示名を「モーフ 1」「モーフ 2」にすると、
--   1番目が主で2番目が従だと読める。D158 は
--   「複数のモーフに主対象・副対象の区別を設けない」と決めているので、
--   **3つとも同じ「モーフ」にする。**番号はキーの中だけに残す。
--   キーを分けるのは、同じお題に2個出たときの記録を分けるためであって、
--   順位を付けるためではない。

insert into public.card_slots
  (card_slot_key, label, pool_key, quiz_priority, is_quiz_eligible) values
  ('morph_1',        'モーフ',     'morph',        21, true),
  ('morph_2',        'モーフ',     'morph',        22, true),
  ('morph_3',        'モーフ',     'morph',        23, true),
  ('emotion_1',      '感情',       'emotion',      24, true),
  ('emotion_2',      '感情',       'emotion',      25, true),
  ('emotion_3',      '感情',       'emotion',      26, true),
  ('action_1',       '動作',       'action',       27, true),
  ('action_2',       '動作',       'action',       28, true),
  ('action_3',       '動作',       'action',       29, true),
  ('body_state_1',   '身体状態',   'body_state',   30, true),
  ('body_state_2',   '身体状態',   'body_state',   31, true),
  ('body_state_3',   '身体状態',   'body_state',   32, true),
  ('change_1',       '変化',       'change',       33, true),
  ('change_2',       '変化',       'change',       34, true),
  ('change_3',       '変化',       'change',       35, true),
  ('environment_1',  '環境',       'environment',  36, true),
  ('environment_2',  '環境',       'environment',  37, true),
  ('environment_3',  '環境',       'environment',  38, true),
  ('relation_1',     '関係',       'relation',     39, true),
  ('relation_2',     '関係',       'relation',     40, true),
  ('relation_3',     '関係',       'relation',     41, true),
  ('property_1',     '性質',       'property',     42, true),
  ('property_2',     '性質',       'property',     43, true),
  ('property_3',     '性質',       'property',     44, true),
  ('social_state_1', '社会状態',   'social_state', 45, true),
  ('social_state_2', '社会状態',   'social_state', 46, true),
  ('social_state_3', '社会状態',   'social_state', 47, true)
on conflict (card_slot_key) do update
  set label            = excluded.label,
      pool_key         = excluded.pool_key,
      quiz_priority    = excluded.quiz_priority,
      is_quiz_eligible = excluded.is_quiz_eligible;


-- ----------------------------------------------------------------------------
-- 5. モード。二段階抽選を使うかどうかと、語数の範囲を持たせる
-- ----------------------------------------------------------------------------
--
-- 既存の easy / standard は「枠を先に固定する」方式のまま残す。
-- 消さないのは、過去1,050件のお題が mode_key で参照しているため
-- （prompts.mode_key は on delete restrict）。
-- is_active を false にすると、RLS により一般利用者からは見えなくなる。

alter table public.draft_modes
  add column if not exists uses_two_stage boolean not null default false;

alter table public.draft_modes
  add column if not exists word_count_min int;

alter table public.draft_modes
  add column if not exists word_count_max int;

alter table public.draft_modes
  add column if not exists morph_max int;

comment on column public.draft_modes.uses_two_stage is
  'true なら D159 の二段階抽選（カテゴリ→語彙）。false なら draft_mode_slots で'
  '枠を固定する旧方式。旧方式のモードは過去のお題のために残してある。';
comment on column public.draft_modes.word_count_min is
  '1つのお題に入る語の数の下限。二段階抽選のときだけ使う（D158）。';
comment on column public.draft_modes.morph_max is
  '自動抽選で入るモーフの上限（D158）。持ち出し（D161）はこの上限を超えてよい。';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.draft_modes'::regclass
       and conname  = 'draft_modes_two_stage_fields'
  ) then
    alter table public.draft_modes
      add constraint draft_modes_two_stage_fields check (
        (uses_two_stage = false
          and word_count_min is null and word_count_max is null and morph_max is null)
        or
        (uses_two_stage = true
          and word_count_min is not null and word_count_max is not null
          and morph_max is not null
          and word_count_min between 1 and 10
          and word_count_max between word_count_min and 10
          and morph_max between 1 and 3)
      );
  end if;
end $$;

-- 通常と高難度（D158）。
--   通常   3〜4語。モーフは主に1〜2個、3個は低確率 → morph_max = 3
--   高難度 5〜6語。モーフは最大2個                 → morph_max = 2
insert into public.draft_modes
  (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
   sort_order, is_active, uses_two_stage, word_count_min, word_count_max, morph_max)
values
  ('normal', '通常',   5, 1, 3, 3, true, true, 3, 4, 3),
  ('hard',   '高難度', 5, 1, 3, 4, true, true, 5, 6, 2)
on conflict (mode_key) do update
  set label               = excluded.label,
      candidate_count     = excluded.candidate_count,
      max_rerolls         = excluded.max_rerolls,
      quiz_question_count = excluded.quiz_question_count,
      sort_order          = excluded.sort_order,
      is_active           = excluded.is_active,
      uses_two_stage      = excluded.uses_two_stage,
      word_count_min      = excluded.word_count_min,
      word_count_max      = excluded.word_count_max,
      morph_max           = excluded.morph_max;

-- 旧方式の2モードを一般利用者から隠す。行は消さない。
update public.draft_modes
   set is_active = false
 where mode_key in ('easy', 'standard');

-- 列を足したので権限を配り直す（新しい列は既定で誰にも見えないため）
revoke all on table public.draft_modes from public, anon, authenticated;
grant select (mode_key, label, candidate_count, max_rerolls, quiz_question_count,
              sort_order, uses_two_stage, word_count_min, word_count_max, morph_max)
  on public.draft_modes to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 6. 抽選確率の設定表
-- ----------------------------------------------------------------------------
--
-- 【重要：ここに入る値の大半は、まだ決まっていない】
--   D158 は「通常3語と4語の比率」「モーフ1〜3個の確率」「カテゴリ重複率」を
--   **未確定の運用値**として明記している。動かすために値が要るので入れるが、
--   is_provisional = true を立てて「実装用の暫定初期値」であることを行に残す。
--
--   **承認済みの決定として扱わない。**限定公開後のフィードバックで変える。
--
--   これは D163 の3係数（0.25 / 0.75 / 0.5）とは扱いが違う。
--   あちらは初期値が承認済みで、こちらは値そのものが未確定。

create table if not exists public.draw_config (
  config_key text primary key
    constraint draw_config_key_format check (config_key ~ '^[a-z][a-z0-9_]{1,49}$'),

  -- 0〜1 の確率か、個数などの数値
  config_value numeric not null,

  -- true = 実装用の暫定初期値。ユーザー承認済みの決定ではない
  is_provisional boolean not null default true,

  note text not null
    constraint draw_config_note_length check (char_length(note) between 1 and 300),

  updated_at timestamptz not null default now()
);

comment on table public.draw_config is
  'お題抽選の確率。is_provisional = true の行は「実装用の暫定初期値」で、'
  'ユーザー承認済みの決定ではない（D158 の未確定の運用値）。';

insert into public.draw_config (config_key, config_value, is_provisional, note) values
  ('normal_word_count_3_ratio', 0.50, true,
   '通常で総語数が3語になる確率。残りが4語。D158 は比率を未確定としている'),
  ('normal_morph_1_ratio', 0.55, true,
   '通常でモーフが1個になる確率。D158「主に1〜2個」の内訳は未確定'),
  ('normal_morph_2_ratio', 0.40, true,
   '通常でモーフが2個になる確率。1個・2個・3個の合計が1になるよう扱う'),
  ('normal_morph_3_ratio', 0.05, true,
   '通常でモーフが3個になる確率。D158「3個は低確率」を満たす暫定値'),
  ('hard_word_count_5_ratio', 0.50, true,
   '高難度で総語数が5語になる確率。残りが6語'),
  ('hard_morph_1_ratio', 0.50, true,
   '高難度でモーフが1個になる確率。残りが2個。D158「最大2個」'),
  ('state_category_repeat_ratio', 0.10, true,
   '状態カテゴリを重複させる確率。D158「完全禁止にしないが低確率」を満たす暫定値')
on conflict (config_key) do nothing;

alter table public.draw_config enable row level security;

-- 確率は運営用。一般利用者には読ませない。
-- 見えると「モーフが3個なのは珍しい」といった推測の材料になる。
revoke all on table public.draw_config from public, anon, authenticated;
