-- ============================================================================
-- draw_vocabulary_seed ／ モーフと状態8カテゴリの語彙を投入する（D158）
-- ============================================================================
--
-- 【このファイルがやること】
--   1. 旧プール motif（102件）と species（24件）の語を、新しい morph へ写す
--   2. 状態8カテゴリの語を 24件ずつ、合計192件入れる
--   3. 誤答用の分類（distractor_class）と同義グループ（synonym_group）を付ける
--   4. 数え直して検証する。1つでも外れたら投入ごと巻き戻す
--
-- 【このファイルがやらないこと】
--   ・既存タグを1行も消さない
--   ・既存タグの pool_key / id / label を1文字も変えない
--   ・既存のお題・クイズ・回答に触れない
--
-- ============================================================================
-- 旧プールの語彙をどう移したか（実際に数えて決めた）
-- ============================================================================
--
--   旧 motif   102件 → morph へ写す
--     全部が「物・自然物・人工物」で、D158 のモーフの定義
--     （絵の核になる具体的な対象。物、生物、人物類型、人工物）に当てはまる。
--     判断が割れうるものを先に挙げておく:
--       地下室・屋根裏部屋・廃駅・温室・縁側 … 場所だが、描く対象そのもの。
--         D158 の「環境」の例（水中・強風・暗闇・降雪）は場所ではなく状況で、
--         こちらとは別物。よってモーフに置く。
--       渦潮・砂丘・虹・雷雲・満月・三日月・流れ星 … 自然物。
--         「降雪」のような状況ではなく、画面に描かれる物体。よってモーフ。
--
--   旧 species  24件 → morph へ写す
--     エルフ・ドラゴン・人間 … すべて D158 の「生物・人物類型」。
--
--   旧 color    15件 → **移さない。**
--     D158 の分類は「モーフ」と「状態8カテゴリ（感情・動作・身体状態・変化・
--     環境・関係・性質・社会状態）」だけで、色の行き先が無い。
--     性質（重い・脆い・透明・粘着）は手触りの語で、色はそこに入らない。
--     **推測で入れない。**旧プールに残し、新方式の抽選では引かない。
--
--   旧 genre    15件 → **移さない。**
--     SF・ファンタジー・和風などのジャンル類型も、9カテゴリに行き先が無い。
--     同上の理由で旧プールに残す。
--
-- 【なぜ「移動」ではなく「写し」なのか】
--   tags の行の pool_key を書き換えると、その行を指している過去の
--   prompt_cards（既存1,050件のお題）の分類が黙って変わる。
--   get_my_prompt は tags.pool_key をそのまま返しているので、
--   **過去のお題の表示内容が変わる。**
--   新しい行として入れれば、過去のお題は1件も変わらない。
--   同じ語が旧 motif と新 morph の両方に存在するが、
--   tags の一意制約は (pool_key, label) なので衝突しない。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 0. 実行前の姿を控える（過去のお題が変わっていないことの照合に使う）
-- ----------------------------------------------------------------------------

drop table if exists _vocab_before;

create temporary table _vocab_before as
select
  (select count(*) from public.tags)                              as n_tags,
  (select count(*) from public.tags where pool_key = 'motif')     as n_motif,
  (select count(*) from public.tags where pool_key = 'species')   as n_species,
  (select count(*) from public.tags where pool_key = 'color')     as n_color,
  (select count(*) from public.tags where pool_key = 'genre')     as n_genre,
  (select count(*) from public.prompt_cards)                      as n_cards,
  (select md5(coalesce(string_agg(s, '|' order by s), ''))
     from (select prompt_id::text || '/' || card_slot_key || '/'
                  || slot_order::text || '/' || tag_id::text
             from public.prompt_cards) x(s))                      as h_cards,
  (select coalesce(max(id), 0) from public.tags)                  as max_tag_id,
  (select md5(coalesce(string_agg(s, '|' order by s), ''))
     from (select id::text || '/' || pool_key || '/' || label
             from public.tags) x(s))                              as h_tags;


-- ----------------------------------------------------------------------------
-- 1. モーフ ← 旧 motif ＋ 旧 species
-- ----------------------------------------------------------------------------
--
-- weight（出やすさ）も一緒に写す。docs/tags-master.md で目視確認済みの値で、
-- ここで作り直す理由が無い。

insert into public.tags (pool_key, label, weight, is_active, note)
select 'morph',
       t.label,
       t.weight,
       t.is_active,
       '旧 ' || t.pool_key || ' から移行（D158）'
  from public.tags t
 where t.pool_key in ('motif', 'species')
on conflict (pool_key, label) do nothing;


-- ----------------------------------------------------------------------------
-- 2. 状態8カテゴリ（各24語）
-- ----------------------------------------------------------------------------
--
-- 【weight について】
--   全部 100（既定）にした。旧プールでは 140 / 100 / 70 / 45 の4段階を
--   docs/tags-master.md で1語ずつ検討して付けているが、状態語について
--   その検討をした資料は無い。**根拠なく段差を付けない。**
--   限定公開後、実際の使われ方を見てから付ける。
--
-- 【24語ずつにした理由】
--   4択のクイズは、1つの分類につき「正解1 ＋ 誤答3」を要求する。
--   同じカテゴリが1つのお題に3回出て3問とも出題される最悪の場合、
--   同じ分類から 3 + 3×3 = 12 語を重複なく引く必要がある（quiz_choice_dedupe）。
--   24語あれば、その最悪の場合でも倍の余裕がある。
--   （12 は計算の結果。24 という数は私が置いた暫定値。）

insert into public.tags (pool_key, label) values
  -- 感情
  ('emotion', '怒り'), ('emotion', '安心'), ('emotion', '嫉妬'), ('emotion', '羞恥'),
  ('emotion', '焦燥'), ('emotion', '歓喜'), ('emotion', '悲嘆'), ('emotion', '恐怖'),
  ('emotion', '郷愁'), ('emotion', '憧憬'), ('emotion', '諦念'), ('emotion', '高揚'),
  ('emotion', '孤独'), ('emotion', '困惑'), ('emotion', '期待'), ('emotion', '後悔'),
  ('emotion', '敵意'), ('emotion', '慈愛'), ('emotion', '驚愕'), ('emotion', '退屈'),
  ('emotion', '誇り'), ('emotion', '罪悪感'), ('emotion', '熱狂'), ('emotion', '憂鬱'),

  -- 動作
  ('action', '眠る'), ('action', '逃げる'), ('action', '待つ'), ('action', '運ぶ'),
  ('action', '隠れる'), ('action', '探す'), ('action', '踊る'), ('action', '落ちる'),
  ('action', '登る'), ('action', '抱える'), ('action', '見つめる'), ('action', '叫ぶ'),
  ('action', '食べる'), ('action', '泳ぐ'), ('action', '走る'), ('action', '座る'),
  ('action', '覗く'), ('action', '投げる'), ('action', '引きずる'), ('action', '差し出す'),
  ('action', '振り返る'), ('action', '祈る'), ('action', '笑う'), ('action', '崩れ落ちる'),

  -- 身体状態
  ('body_state', '負傷'), ('body_state', '疲労'), ('body_state', '膨張'), ('body_state', '凍結'),
  ('body_state', '発熱'), ('body_state', '空腹'), ('body_state', '渇き'), ('body_state', '眠気'),
  ('body_state', '硬直'), ('body_state', '出血'), ('body_state', '痩身'), ('body_state', '肥大'),
  ('body_state', '欠損'), ('body_state', '麻痺'), ('body_state', '汗だく'), ('body_state', '息切れ'),
  ('body_state', '眩暈'), ('body_state', '傷跡'), ('body_state', '白髪'), ('body_state', '脱力'),
  ('body_state', '痙攣'), ('body_state', '火照り'), ('body_state', '骨折'), ('body_state', '老い'),

  -- 変化
  ('change', '溶ける'), ('change', '腐る'), ('change', '機械化'), ('change', '植物化'),
  ('change', '石化'), ('change', '結晶化'), ('change', '発光'), ('change', '燃焼'),
  ('change', '錆びる'), ('change', '崩壊'), ('change', '分裂'), ('change', '反転'),
  ('change', '巨大化'), ('change', '縮小'), ('change', '透明化'), ('change', '液状化'),
  ('change', '砂化'), ('change', '氷解'), ('change', '風化'), ('change', '増殖'),
  ('change', '変色'), ('change', '硬質化'), ('change', '蒸発'), ('change', '再生'),

  -- 環境
  ('environment', '水中'), ('environment', '強風'), ('environment', '暗闇'), ('environment', '降雪'),
  ('environment', '豪雨'), ('environment', '濃霧'), ('environment', '灼熱'), ('environment', '極寒'),
  ('environment', '無重力'), ('environment', '逆光'), ('environment', '水没'), ('environment', '砂嵐'),
  ('environment', '雷雨'), ('environment', '夕暮れ'), ('environment', '深夜'), ('environment', '真昼'),
  ('environment', '密室'), ('environment', '廃墟'), ('environment', '高所'), ('environment', '地下'),
  ('environment', '群衆'), ('environment', '荒野'), ('environment', '火の海'), ('environment', '星空'),

  -- 関係
  ('relation', '主従'), ('relation', '対立'), ('relation', '保護'), ('relation', '依存'),
  ('relation', '師弟'), ('relation', '親子'), ('relation', '恋慕'), ('relation', '共犯'),
  ('relation', '裏切り'), ('relation', '再会'), ('relation', '別離'), ('relation', '取引'),
  ('relation', '競争'), ('relation', '和解'), ('relation', '支配'), ('relation', '献身'),
  ('relation', '監視'), ('relation', '救出'), ('relation', '拒絶'), ('relation', '同盟'),
  ('relation', '模倣'), ('relation', '継承'), ('relation', '対話'), ('relation', '共存'),

  -- 性質
  ('property', '重い'), ('property', '脆い'), ('property', '透明'), ('property', '粘着'),
  ('property', '鋭い'), ('property', '柔らかい'), ('property', '巨大'), ('property', '微小'),
  ('property', '熱い'), ('property', '冷たい'), ('property', '滑らか'), ('property', '粗い'),
  ('property', '軽い'), ('property', '硬い'), ('property', '湿った'), ('property', '乾いた'),
  ('property', '眩しい'), ('property', '静か'), ('property', '騒がしい'), ('property', '香る'),
  ('property', '古びた'), ('property', '真新しい'), ('property', '対称'), ('property', '歪んだ'),

  -- 社会状態
  ('social_state', '追放'), ('social_state', '祝福'), ('social_state', '拘束'), ('social_state', '即位'),
  ('social_state', '逃亡者'), ('social_state', '罪人'), ('social_state', '英雄'), ('social_state', '奴隷'),
  ('social_state', '巡礼'), ('social_state', '隠遁'), ('social_state', '婚礼'), ('social_state', '葬送'),
  ('social_state', '裁判'), ('social_state', '反乱'), ('social_state', '祭礼'), ('social_state', '亡命'),
  ('social_state', '就任'), ('social_state', '引退'), ('social_state', '破門'), ('social_state', '表彰'),
  ('social_state', '借金'), ('social_state', '指名手配'), ('social_state', '戒厳'), ('social_state', '開戦')
on conflict (pool_key, label) do nothing;


-- ----------------------------------------------------------------------------
-- 3. 誤答用の分類（D96 / D160）
-- ----------------------------------------------------------------------------
--
-- distractor_class の初期値は pool_key と同値。
-- **同値であることと、同じ概念であることは違う**（D160）。列が分かれているので、
-- 片方だけを後から変えられる。

update public.tags
   set distractor_class = pool_key
 where distractor_class is distinct from pool_key;

-- synonym_group ／ 同じ問の4択に並べてはいけない語
--
-- **1件ずつ目で見て決めたものだけを入れる。**
-- 意味が近いかどうかを機械で判定する手段が無いので、
-- 「近いはずだ」で一括投入しない。ここに無い語は「グループ無し」であって
-- 「近い語が無いことを確認済み」ではない。
--
-- いま入れるのは、同じプールの中で片方が正解のとき
-- もう片方も正解と言える2組だけ。
update public.tags set synonym_group = 'swelling'
 where pool_key = 'body_state' and label in ('膨張', '肥大');

update public.tags set synonym_group = 'melting'
 where pool_key = 'change' and label in ('溶ける', '液状化');


-- ----------------------------------------------------------------------------
-- 4. 検証（1つでも外れたら投入ごと巻き戻す）
-- ----------------------------------------------------------------------------

do $$
declare
  b            record;
  v_morph      int;
  v_state      int;
  v_bad        int;
  v_cards_now  int;
  v_hash_now   text;
  v_cat        record;
begin
  select * into b from _vocab_before;

  -- 4-1. 旧プールが1件も減っていない・増えていない
  if (select count(*) from public.tags where pool_key = 'motif')   <> b.n_motif
  or (select count(*) from public.tags where pool_key = 'species') <> b.n_species
  or (select count(*) from public.tags where pool_key = 'color')   <> b.n_color
  or (select count(*) from public.tags where pool_key = 'genre')   <> b.n_genre then
    raise exception 'VOCAB_OLD_POOL_CHANGED: 旧プールの件数が変わりました。';
  end if;

  -- 4-2. 実行前から在った行の id / pool_key / label が1つも変わっていない
  select md5(coalesce(string_agg(s, '|' order by s), ''))
    into v_hash_now
    from (select id::text || '/' || pool_key || '/' || label
            from public.tags where id <= b.max_tag_id) x(s);

  if v_hash_now <> b.h_tags then
    raise exception
      'VOCAB_EXISTING_TAGS_CHANGED: 既存タグの id / 分類 / 表記が変わりました。';
  end if;

  -- 4-3. 過去のお題カードが1行も変わっていない
  select count(*) into v_cards_now from public.prompt_cards;
  select md5(coalesce(string_agg(s, '|' order by s), ''))
    into v_hash_now
    from (select prompt_id::text || '/' || card_slot_key || '/'
                 || slot_order::text || '/' || tag_id::text
            from public.prompt_cards) x(s);

  if v_cards_now <> b.n_cards or v_hash_now <> b.h_cards then
    raise exception
      'VOCAB_PROMPT_CARDS_CHANGED: 過去のお題カードが変わりました（%件→%件）。',
      b.n_cards, v_cards_now;
  end if;

  -- 4-4. モーフが 126件（旧 motif 102 ＋ 旧 species 24）
  select count(*) into v_morph from public.tags where pool_key = 'morph';
  if v_morph <> b.n_motif + b.n_species then
    raise exception 'VOCAB_MORPH_COUNT: モーフが %件です（必要 %件）。',
      v_morph, b.n_motif + b.n_species;
  end if;

  -- 4-5. 状態8カテゴリが 24件ずつ
  for v_cat in
    select category_key, pool_key from public.draw_categories
     where kind = 'state' order by sort_order
  loop
    select count(*) into v_state
      from public.tags where pool_key = v_cat.pool_key and is_active;
    if v_state <> 24 then
      raise exception 'VOCAB_STATE_COUNT: % が %件です（必要 24件）。',
        v_cat.category_key, v_state;
    end if;
  end loop;

  -- 4-6. すべての生成用カテゴリに、4択が作れるだけの語がある
  --      最悪の場合（同じカテゴリが3回出て3問とも出題）に 12語が要る
  select count(*) into v_bad
    from public.draw_categories dc
   where dc.is_active
     and (select count(*) from public.tags t
           where t.pool_key = dc.pool_key and t.is_active) < 12;

  if v_bad > 0 then
    raise exception 'VOCAB_TOO_FEW: 12語に満たないカテゴリが%件あります。', v_bad;
  end if;

  -- 4-7. distractor_class が空の行が無い
  select count(*) into v_bad from public.tags where distractor_class is null;
  if v_bad > 0 then
    raise exception 'VOCAB_NO_DISTRACTOR_CLASS: 誤答分類の無いタグが%件あります。', v_bad;
  end if;
end $$;
