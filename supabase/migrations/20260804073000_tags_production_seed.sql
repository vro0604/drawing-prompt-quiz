-- ============================================================================
-- tags_production_seed ／ 本番タグ156件を投入する（Step 3D）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 実行前の姿を控える（タグのID・参照表の中身）
--   2. 本番タグ156件を upsert する（新規110件・既存46件の重み更新）
--   3. **控えと突き合わせて8項目を検証する。1つでも外れたら全部取り消す**
--
-- 【このファイルがやらないこと】
--   ・タグを1行も削除しない（`delete` を1つも書かない）
--   ・既存46件の `id` と `label` を変えない
--   ・既存のお題・クイズ・回答に触れない
--   ・表・列・制約・権限・関数・RLS に触れない
--   ・`tag_pools` / `card_slots` / `draft_modes` に触れない
--
-- 【実行方法】
--   npm run db:deploy
--
-- 【取り消し】
--   supabase/rollback/019_tags_production_seed_rollback.sql
--
-- 【原案】
--   docs/tags-master.md（2026-08-04 目視確認・承認済み）
--   採用理由・落とした候補・重みの設計はすべてそちらにある。
--   このファイルは**その表を SQL にしただけ**で、判断は書かない。
--
--
-- ============================================================================
-- 内訳
-- ============================================================================
--
--   motif   102件（既存16 + 新規86）… 標準モードが1回に10件使う。最も厚く積む
--   color    15件（既存10 + 新規 5）… 増やすと隣の色と見分けがつかなくなる
--   species  24件（既存10 + 新規14）… MVPでは出題されない（優先度4のため）
--   genre    15件（既存10 + 新規 5）… 広いジャンルと類型は同居させない
--   ────────────────────────────────
--   合計    156件（既存46 + 新規110）
--
--
-- ============================================================================
-- なぜ検証をこのファイルに書くか
-- ============================================================================
--
--   タグは**他の全部が乗っている土台**で、`prompt_cards` も `quiz_choices` も
--   `tags.id` を参照している（どちらも on delete restrict）。
--
--   ここで id がずれると、過去のお題が別のタグを指す。しかも
--   **エラーにならない**。お題カードの表示と、クイズの正解だけが静かに変わる。
--   気づくのは「答えが合っているのに不正解になる」と言われたときになる。
--
--   だから deploy と同じトランザクションの中で確かめる。
--   1項目でも外れたら例外を投げ、**投入ごと巻き戻す**。
--   db:verify は投入後の状態しか見られないので、
--   「投入前と比べて変わっていないこと」はここでしか確かめられない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 実行前の姿を控える
-- ----------------------------------------------------------------------------
--
-- 同じセッションで作り直せるように、先に落としておく。

drop table if exists _tags_before;
drop table if exists _refs_before;
drop table if exists _tags_upsert;


-- 1-a. タグの id と label（id が変わっていないことの照合に使う）

create temporary table _tags_before as
  select id, pool_key, label, weight
    from public.tags;


-- 1-b. タグを参照している表の中身
--
-- 件数だけでは足りない。**同じ件数のまま中身が入れ替わる**のがいちばん怖い。
-- 並び順に依存しないよう、行を文字列にして並べ替えてから md5 を取る。

create temporary table _refs_before as
select
  (select count(*) from public.prompt_cards)   as n_cards,
  (select count(*) from public.quiz_questions) as n_questions,
  (select count(*) from public.quiz_choices)   as n_choices,
  (select count(*) from public.prompts)        as n_prompts,

  (select md5(coalesce(string_agg(s, '|' order by s), ''))
     from (select prompt_id::text || '/' || card_slot_key || '/'
                  || slot_order::text || '/' || tag_id::text
             from public.prompt_cards) x(s))   as h_cards,

  (select md5(coalesce(string_agg(s, '|' order by s), ''))
     from (select question_id::text || '/' || position::text || '/'
                  || tag_id::text || '/' || is_correct::text
             from public.quiz_choices) x(s))   as h_choices;


-- ----------------------------------------------------------------------------
-- 2. 本番タグ156件
-- ----------------------------------------------------------------------------
--
-- 【重みの意味】docs/tags-master.md 2章
--   140 骨格 … それ1つで絵の主題が決まる
--   100 既定 … 大多数
--    70 抑制 … どこにでも足せて絵が似通う
--    45 希少 … 描く負担が大きい／画面を占有する
--
-- 【note の扱い】
--   `coalesce(excluded.note, public.tags.note)` で当てるため、
--   ここで null を書いた行は**既存のメモを消さない**。
--
-- 【固有名詞】
--   作品名・キャラクター名・商品名は1件も入れていない。
--   一般名詞・伝承・類型だけで構成する（R14）。

create temporary table _tags_upsert (
  id          bigint,
  pool_key    text,
  label       text,
  was_updated boolean
);

with upserted as (
  insert into public.tags (pool_key, label, weight, is_active, note) values

  -- ==========================================================================
  -- motif ／ モチーフ 102件
  -- ==========================================================================

  -- --- 既存16件（id は変わらない。weight だけ変わる）-------------------------
  ('motif', '傘',            140, true, '単体で主題が立つ'),
  ('motif', '灯台',          100, true, null),
  ('motif', '三日月',        100, true, '満月とは欠け方で見分ける'),
  ('motif', '歯車',           70, true, 'どこにでも足せるため抑制'),
  ('motif', '風船',           70, true, 'どこにでも足せるため抑制'),
  ('motif', '花束',          100, true, null),
  ('motif', '古書',          100, true, '「本」は上位語なので入れない'),
  ('motif', '万年筆',        100, true, '「羽根ペン」は近すぎるので入れない'),
  ('motif', '砂時計',        100, true, null),
  ('motif', '折り鶴',        100, true, null),
  ('motif', '観覧車',         45, true, '描く負担が大きく背景が固定される'),
  ('motif', '提灯',          100, true, '「灯籠」は紛れるので入れない'),
  ('motif', '錨',            100, true, null),
  ('motif', '蓄音機',        100, true, '「レコード盤」は一部なので入れない'),
  ('motif', '温室',           45, true, '背景を占有する'),
  ('motif', '螺旋階段',       45, true, '描く負担が大きい'),

  -- --- 新規：自然・天体 10件 -------------------------------------------------
  ('motif', '満月',          100, true, null),
  ('motif', '流れ星',         70, true, '背景に足せるため抑制'),
  ('motif', '雷雲',          100, true, null),
  ('motif', '虹',             70, true, '背景に足せるため抑制'),
  ('motif', '大樹',          100, true, null),
  ('motif', '枯れ木',        100, true, '大樹とは季節と生死で描き分ける'),
  ('motif', '蔦',             70, true, 'どこにでも絡ませられるため抑制'),
  ('motif', '苔むした岩',    100, true, null),
  ('motif', '砂丘',           45, true, '背景が固定される'),
  ('motif', '渦潮',           45, true, '描く負担が大きい'),

  -- --- 新規：生き物とその痕跡 10件 -------------------------------------------
  ('motif', '黒猫',          140, true, '主題として強く構図が立つ'),
  ('motif', '梟',            100, true, null),
  ('motif', '鯨',             45, true, '画面を占有する'),
  ('motif', '蝶',             70, true, 'どこにでも足せるため抑制'),
  ('motif', '蛇',            100, true, 'species の「蛇人」とは別プールなので競合しない'),
  ('motif', '鹿',            100, true, null),
  ('motif', '金魚',          100, true, null),
  ('motif', '蜘蛛の巣',       70, true, '背景に足せるため抑制'),
  ('motif', '鳥籠',          140, true, '主題が立ち物語を含む'),
  ('motif', '羽根',           70, true, 'どこにでも足せるため抑制'),

  -- --- 新規：建物・場所 10件 -------------------------------------------------
  ('motif', '廃駅',           45, true, '背景の作り込みが要る'),
  ('motif', '時計塔',         45, true, '背景の作り込みが要る'),
  ('motif', '井戸',          100, true, null),
  ('motif', '石橋',          100, true, '「橋」だと広すぎるので素材で限定した'),
  ('motif', '鳥居',          100, true, null),
  ('motif', '縁側',          100, true, null),
  ('motif', '屋根裏部屋',     45, true, '室内の作り込みが要る'),
  ('motif', '地下室',         45, true, '屋根裏部屋とは光の入り方で分かれる'),
  ('motif', '迷路',           45, true, '描く負担が大きい'),
  ('motif', '遺跡',           45, true, '描く負担が大きい'),

  -- --- 新規：乗り物 8件 ------------------------------------------------------
  ('motif', '気球',          100, true, null),
  ('motif', '飛行船',         45, true, '気球と近い。硬い骨格の有無で描き分ける'),
  ('motif', '帆船',           45, true, null),
  ('motif', '潜水艦',         45, true, null),
  ('motif', '蒸気機関車',     45, true, null),
  ('motif', '自転車',        140, true, '日常にも幻想にも置ける'),
  ('motif', '手漕ぎボート',  100, true, '帆船とは規模で分かれる'),
  ('motif', '荷馬車',        100, true, null),

  -- --- 新規：道具 14件 -------------------------------------------------------
  ('motif', '鍵',            140, true, '「錠前」は対で描かれるので入れない'),
  ('motif', '眼鏡',          140, true, null),
  ('motif', '望遠鏡',        100, true, null),
  ('motif', '羅針盤',        100, true, null),
  ('motif', '古地図',        100, true, '「地図」だと広いので時代で限定した'),
  ('motif', '手紙',          140, true, null),
  ('motif', '宝箱',          100, true, null),
  ('motif', '鏡',            100, true, null),
  ('motif', '天秤',          100, true, null),
  ('motif', '仮面',          140, true, '主題が立つ'),
  ('motif', '王冠',          100, true, '「花冠」は冠として紛れるので入れない'),
  ('motif', '指輪',          100, true, null),
  ('motif', '万華鏡',         45, true, '内部の描写に手が要る'),
  ('motif', '標本瓶',        100, true, '「蜂蜜の瓶」は瓶として紛れるので入れない'),

  -- --- 新規：機械・からくり 8件 ----------------------------------------------
  ('motif', 'タイプライター', 100, true, null),
  ('motif', 'カメラ',        100, true, null),
  ('motif', '黒電話',        100, true, '「電話」だと現代機と紛れるので限定した'),
  ('motif', '真空管ラジオ',  100, true, '「ラジオ」だと現代機と紛れるので限定した'),
  ('motif', 'オルゴール',    100, true, null),
  ('motif', '地球儀',        100, true, '「天球儀」は紛れるので入れない'),
  ('motif', 'ミシン',        100, true, null),
  ('motif', 'からくり人形',   45, true, 'species の「機械人形」とは別プールなので競合しない'),

  -- --- 新規：衣・装身 6件 ----------------------------------------------------
  ('motif', 'マント',        100, true, null),
  ('motif', '麦わら帽子',    140, true, null),
  ('motif', '長靴',          100, true, null),
  ('motif', 'リボン',         70, true, 'どこにでも足せるため抑制'),
  ('motif', '手袋',          100, true, null),
  ('motif', '鎧',             45, true, '描く負担が大きい'),

  -- --- 新規：食・器・硝子 6件 ------------------------------------------------
  ('motif', 'ティーカップ',  140, true, null),
  ('motif', '焼き菓子',      100, true, null),
  ('motif', '果実',          100, true, null),
  ('motif', 'パン',          100, true, null),
  ('motif', '卵',            100, true, null),
  ('motif', 'ステンドグラス', 45, true, '描く負担が大きい'),

  -- --- 新規：音・文字・祈り 4件 ----------------------------------------------
  ('motif', '楽譜',          100, true, null),
  ('motif', 'ヴァイオリン',  100, true, '一般名詞。製作者名は使わない'),
  ('motif', '太鼓',          100, true, null),
  ('motif', '石碑',          100, true, null),

  -- --- 新規：戦い・拘束 4件 --------------------------------------------------
  ('motif', '剣',            140, true, null),
  ('motif', '弓矢',          100, true, null),
  ('motif', '盾',            100, true, '鎧と並びうるが別の物体として見分ける'),
  ('motif', '鎖',             70, true, 'どこにでも足せるため抑制'),

  -- --- 新規：その他 6件 ------------------------------------------------------
  ('motif', '硝子玉',        100, true, null),
  ('motif', '風車小屋',      100, true, '観覧車と近い。「風車」だと羽根単体とも読めるため小屋を付けた'),
  ('motif', '丸窓',          100, true, null),
  ('motif', '噴水',          100, true, null),
  ('motif', '落ち葉',         70, true, '背景に足せるため抑制'),
  ('motif', '雪だるま',      100, true, null),

  -- ==========================================================================
  -- color ／ 色 15件
  -- ==========================================================================
  --
  -- 単字で表せる色は単字にそろえる（既存の赤・青に合わせる）。
  -- 表せないものだけ慣用表記にする（水色・黄緑）。「茶色」「灰色」とは書かない。
  --
  -- 32件へ増やす案は取りやめた。色は連続量なので、増やすほど隣が近づき、
  -- 4択が絵から決められなくなる。落とした候補は docs/tags-master.md 4-2。

  ('color', '赤',     100, true, null),
  ('color', '青',     100, true, null),
  ('color', '黄',     100, true, null),
  ('color', '緑',     100, true, null),
  ('color', '紫',     100, true, null),
  ('color', '橙',     100, true, null),
  ('color', '桃',     100, true, null),
  ('color', '白',      70, true, '背景と同化しやすく指定として弱い'),
  ('color', '黒',      70, true, '画面を支配し他の色指定を飲み込む'),
  ('color', '金',      45, true, '強すぎて他の色指定を飲み込む'),
  ('color', '茶',     100, true, null),
  ('color', '灰',     100, true, '白・黒とは明度で分かれる'),
  ('color', '銀',      45, true, '灰と近い。金属光沢の有無で描き分ける'),
  ('color', '水色',   100, true, '青と近い。明度差で見分ける'),
  ('color', '黄緑',   100, true, '黄・緑の中間だがどちらとも見分ける'),

  -- ==========================================================================
  -- species ／ 種族 24件
  -- ==========================================================================
  --
  -- MVPでは出題されない（優先度4で、出題は上位3枠まで届かない）。
  -- 将来出題されうるので、ハズレとして成立する基準で選んである。

  ('species', '人間',       70, true, '最も汎用。出続けると絵が似通うため抑制'),
  ('species', '獣人',      100, true, '哺乳類型として運用する。鳥人・蛇人・昆虫人と分ける'),
  ('species', 'エルフ',    100, true, '一般的な幻想種'),
  ('species', 'ドラゴン',   45, true, '画面を占有する。「竜」は同義なので入れない'),
  ('species', '人魚',      100, true, null),
  ('species', '天使',      100, true, '「堕天使」は天使・悪魔と紛れるので入れない'),
  ('species', '悪魔',      100, true, null),
  ('species', '妖精',      100, true, '「精霊」は紛れるので入れない'),
  ('species', '機械人形',  100, true, '「アンドロイド」「サイボーグ」は紛れるので入れない'),
  ('species', '幽霊',      100, true, '「亡霊」「死霊」は同義なので入れない'),
  ('species', '巨人',       45, true, '画面を占有する。小人族と対'),
  ('species', '小人族',    100, true, '「小人」だと背丈の話とも読めるため族を付けた'),
  ('species', '骸骨',      100, true, null),
  ('species', 'ゴーレム',  100, true, '伝承由来の一般名詞。機械人形とは素材で分かれる'),
  ('species', 'スライム',  100, true, '粘体状の不定形生物という一般名詞として採用（承認済み）'),
  ('species', '吸血鬼',    100, true, null),
  ('species', '鬼',        100, true, '悪魔とは角と肌の色で分かれる'),
  ('species', '鳥人',      100, true, '獣人を哺乳類型に限る前提'),
  ('species', '昆虫人',    100, true, '獣人を哺乳類型に限る前提'),
  ('species', '植物人',    100, true, null),
  ('species', '半魚人',    100, true, '人魚と近い。魚頭の人型か、人の上体に魚の尾かで分かれる'),
  ('species', '蛇人',      100, true, null),
  ('species', '影の生命体', 45, true, '「影」だと motif の陰影と読み違えるため'),
  ('species', '獣',        100, true, '人型でないもの。獣人とは二足歩行と衣服で分かれる'),

  -- ==========================================================================
  -- genre ／ ジャンル類型 15件
  -- ==========================================================================
  --
  -- 【この問が測るもの】
  --   「唯一正しい客観的分類」を当てる問ではない。
  --   **指定されたジャンル傾向が、絵から最も強く伝わったか**を測る。
  --   正答率が低いことは「分類を間違えた」ではなく
  --   「その傾向が他の候補より強くは伝わらなかった」を意味する。
  --
  -- 【類型を混ぜない理由】
  --   変身戦士・魔法少女・巨大ロボ・怪獣・学園異能・宇宙騎士・収集育成型怪物は
  --   既存の広いジャンルの下位にあたり、絵にすると上位のタグも当てはまる。
  --   ハズレが正解になりうるので、この工程では入れない。
  --   削除ではなく、将来の独立プール archetype へ回す（後続課題 P7）。
  --
  --   ジャンルは**お手軽モードで実際に出題される**ので、ここが曖昧だと
  --   正答率が「絵の伝わりやすさ」を測らなくなる。
  --
  -- 45 は置かない。15件しかないプールで1件だけ大きく下げると、
  -- そのタグが選択肢に並んだときの偏りが読み取れてしまう。

  ('genre', '日常',         70, true, '最も汎用。絵の方向が決まらないため抑制'),
  ('genre', 'バトル',      100, true, null),
  ('genre', 'ホラー',       70, true, '画面全体を支配し他の指定を飲み込むため抑制'),
  ('genre', 'ファンタジー', 70, true, '広すぎて絵を縛らないため抑制'),
  ('genre', 'SF',          100, true, null),
  ('genre', '和風',        100, true, null),
  ('genre', 'ミステリー',   70, true, '抽象度が高く絵にしにくいため抑制'),
  ('genre', 'コメディ',    100, true, null),
  ('genre', 'ロマンス',    100, true, null),
  ('genre', '冒険',        100, true, '「旅」「探検」は同義なので入れない'),
  ('genre', '西部劇',      100, true, '時代と土地が固有。既存と入れ子にならない'),
  ('genre', 'スポーツ',    100, true, '動作と道具が固有'),
  ('genre', '音楽',        100, true, '楽器と場が固有'),
  ('genre', 'ものづくり',  100, true, '作業と工房が固有'),
  ('genre', '演劇',        100, true, '舞台・幕・照明が固有。コメディは調子、演劇は場の様式')

  on conflict (pool_key, label) do update
     set weight    = excluded.weight,
         is_active = excluded.is_active,
         -- null を書いた行は既存のメモを消さない
         note      = coalesce(excluded.note, public.tags.note)

  -- xmax は「この行を更新した取引の番号」。挿入された行では 0 のまま。
  -- これで挿入と更新を数え分ける。
  returning id, pool_key, label, (xmax::text::bigint <> 0) as was_updated
)
insert into _tags_upsert (id, pool_key, label, was_updated)
select id, pool_key, label, was_updated from upserted;


-- ----------------------------------------------------------------------------
-- 3. 検証（1つでも外れたら投入ごと巻き戻す）
-- ----------------------------------------------------------------------------

do $$
declare
  v_before_total   int;
  v_before_matched int;
  v_upserted       int;
  v_inserted       int;
  v_updated        int;
  v_id_changed     int;
  v_label_lost     int;
  v_active_total   int;
  v_dup            int;
  v_motif          int;
  v_color          int;
  v_species        int;
  v_genre          int;
  v_extra          int;
  r_before         record;
  r_after          record;
begin

  -- --- 検証1: upsert の総数 -------------------------------------------------

  select count(*) into v_upserted from _tags_upsert;
  if v_upserted <> 156 then
    raise exception 'タグの投入件数が156ではありません（実際 %）', v_upserted;
  end if;
  raise notice '検証1 OK: 投入対象は156件';


  -- --- 検証2: 既存46件の id が変わっていない -------------------------------
  --
  -- 【なぜ最重要か】
  --   prompt_cards.tag_id と quiz_choices.tag_id はこの id を指している。
  --   ずれても**エラーにならない**。過去のお題が別のタグを指し、
  --   クイズの正解だけが静かに変わる。

  select count(*) into v_id_changed
    from _tags_before b
    left join public.tags t
      on t.pool_key = b.pool_key and t.label = b.label
   where t.id is distinct from b.id;

  if v_id_changed <> 0 then
    raise exception '既存タグの id が変わりました（% 件）', v_id_changed;
  end if;

  -- label が消えていないこと（消えていれば上でも捕まるが、理由を分けて出す）
  select count(*) into v_label_lost
    from _tags_before b
   where not exists (select 1 from public.tags t
                      where t.pool_key = b.pool_key and t.label = b.label);

  if v_label_lost <> 0 then
    raise exception '既存タグの label が失われました（% 件）', v_label_lost;
  end if;

  select count(*) into v_before_total from _tags_before;
  raise notice '検証2 OK: 既存 % 件の id と label が変わっていない', v_before_total;


  -- --- 検証3: 挿入と更新の件数 ----------------------------------------------
  --
  -- **再実行しても通るように書く。**
  -- 期待する挿入数は「156 − 実行前から在った件数」。
  -- 初回は 156−46＝110、2回目以降は 156−156＝0 になる。

  select count(*) into v_before_matched
    from _tags_before b
    join _tags_upsert u
      on u.pool_key = b.pool_key and u.label = b.label;

  select count(*) filter (where not was_updated),
         count(*) filter (where was_updated)
    into v_inserted, v_updated
    from _tags_upsert;

  if v_inserted <> 156 - v_before_matched then
    raise exception '新規挿入件数が合いません（期待 % / 実際 %）',
                    156 - v_before_matched, v_inserted;
  end if;

  if v_updated <> v_before_matched then
    raise exception '更新件数が合いません（期待 % / 実際 %）',
                    v_before_matched, v_updated;
  end if;

  -- 初回だけ、指定どおりの数字になっていることを明示的に確かめる
  if v_before_total = 46 then
    if v_updated <> 46 then
      raise exception '既存46件の更新件数が46ではありません（実際 %）', v_updated;
    end if;
    if v_inserted <> 110 then
      raise exception '新規挿入件数が110ではありません（実際 %）', v_inserted;
    end if;
    raise notice '検証3 OK: 初回投入。更新46件 / 新規110件';
  else
    raise notice '検証3 OK: 再実行。更新 % 件 / 新規 % 件（重複挿入なし）',
                 v_updated, v_inserted;
  end if;


  -- --- 検証4: 有効タグの総数 ------------------------------------------------

  select count(*) into v_active_total
    from public.tags where is_active;

  if v_active_total <> 156 then
    raise exception '有効タグの総数が156ではありません（実際 %）', v_active_total;
  end if;

  -- 156件以外の行が残っていないこと（停止中の行も含めて確かめる）
  select count(*) into v_extra
    from public.tags t
   where not exists (select 1 from _tags_upsert u where u.id = t.id);

  if v_extra <> 0 then
    raise exception '想定外のタグが % 件あります', v_extra;
  end if;
  raise notice '検証4 OK: 有効タグは156件。想定外の行なし';


  -- --- 検証5: pool_key + label の重複 ---------------------------------------
  --
  -- UNIQUE 制約があるので本来起きない。制約が外れていないことの確認を兼ねる。

  select count(*) into v_dup from (
    select pool_key, label from public.tags
     group by pool_key, label having count(*) > 1
  ) d;

  if v_dup <> 0 then
    raise exception 'pool_key + label の重複が % 件あります', v_dup;
  end if;
  raise notice '検証5 OK: 重複なし';


  -- --- 検証6: プールごとの有効件数 ------------------------------------------

  select count(*) filter (where pool_key = 'motif'),
         count(*) filter (where pool_key = 'color'),
         count(*) filter (where pool_key = 'species'),
         count(*) filter (where pool_key = 'genre')
    into v_motif, v_color, v_species, v_genre
    from public.tags where is_active;

  if v_motif <> 102 or v_color <> 15 or v_species <> 24 or v_genre <> 15 then
    raise exception
      'プール別の件数が合いません（motif % / color % / species % / genre %）',
      v_motif, v_color, v_species, v_genre;
  end if;
  raise notice '検証6 OK: motif 102 / color 15 / species 24 / genre 15';


  -- --- 検証7: 既存のお題・クイズが変わっていない ----------------------------
  --
  -- 件数だけでなく中身の md5 も見る。
  -- **同じ件数のまま中身が入れ替わる**のがいちばん危ない。

  select * into r_before from _refs_before;

  select
    (select count(*) from public.prompt_cards)   as n_cards,
    (select count(*) from public.quiz_questions) as n_questions,
    (select count(*) from public.quiz_choices)   as n_choices,
    (select count(*) from public.prompts)        as n_prompts,
    (select md5(coalesce(string_agg(s, '|' order by s), ''))
       from (select prompt_id::text || '/' || card_slot_key || '/'
                    || slot_order::text || '/' || tag_id::text
               from public.prompt_cards) x(s))   as h_cards,
    (select md5(coalesce(string_agg(s, '|' order by s), ''))
       from (select question_id::text || '/' || position::text || '/'
                    || tag_id::text || '/' || is_correct::text
               from public.quiz_choices) x(s))   as h_choices
    into r_after;

  if r_before.n_cards <> r_after.n_cards
     or r_before.n_questions <> r_after.n_questions
     or r_before.n_choices <> r_after.n_choices
     or r_before.n_prompts <> r_after.n_prompts then
    raise exception
      '参照表の件数が変わりました（お題 %→% / カード %→% / 問 %→% / 選択肢 %→%）',
      r_before.n_prompts, r_after.n_prompts,
      r_before.n_cards, r_after.n_cards,
      r_before.n_questions, r_after.n_questions,
      r_before.n_choices, r_after.n_choices;
  end if;

  if r_before.h_cards <> r_after.h_cards then
    raise exception 'prompt_cards の中身が変わりました';
  end if;

  if r_before.h_choices <> r_after.h_choices then
    raise exception 'quiz_choices の中身が変わりました';
  end if;

  raise notice
    '検証7 OK: お題 % 件・カード % 件・問 % 件・選択肢 % 件が変わっていない',
    r_after.n_prompts, r_after.n_cards, r_after.n_questions, r_after.n_choices;


  -- --- 検証8: 参照の宛先が全部いる ------------------------------------------
  --
  -- 外部キーがあるので本来起きない。制約が外れていないことの確認。

  if exists (select 1 from public.prompt_cards pc
              where not exists (select 1 from public.tags t where t.id = pc.tag_id)) then
    raise exception 'prompt_cards が存在しないタグを指しています';
  end if;

  if exists (select 1 from public.quiz_choices qc
              where not exists (select 1 from public.tags t where t.id = qc.tag_id)) then
    raise exception 'quiz_choices が存在しないタグを指しています';
  end if;
  raise notice '検証8 OK: 参照の宛先はすべて存在する';

  raise notice '── タグ投入 全8項目 OK ──';
end $$;


-- ----------------------------------------------------------------------------
-- 4. 控えを片づける
-- ----------------------------------------------------------------------------

drop table if exists _tags_before;
drop table if exists _refs_before;
drop table if exists _tags_upsert;


comment on table public.tags is
  'タグ本体（マスタ）。本番156件（motif 102 / color 15 / species 24 / genre 15）。'
  '原案と採用理由は docs/tags-master.md。';
