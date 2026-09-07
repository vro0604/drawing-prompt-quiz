-- ============================================================================
-- 20260907094000 ／ カテゴリの表示名を1か所から変えられるようにする
-- ============================================================================
--
-- 出所: ユーザー指示（2026-09-07）。決定記録は D171。
--
-- 【何が散っていたか】
--   表示名が2つの表にあった。
--     draw_categories.label … 抽選・語彙の棚卸しが読む
--     tag_pools.label       … **画面が読むのはこちら**
--   RPC の 'category_label' はすべて tp.label（tag_pools）から出ている（実測）。
--   つまり draw_categories.label を直しても、利用者の画面は変わらない。
--
-- 【今回やること】
--   ・分類の構造は1つも変えない。category_key も pool_key も触らない
--   ・**表示名を変える入口を1本にする。**その1本が両方の表を同時に直す
--   ・2つがずれていないことを検査で見張る
--
-- 【最終的な名前は決めていない】
--   いまの10個の値をそのまま入れ直すだけ。名前を変える判断はしていない。
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 表示名を変える唯一の入口
-- ----------------------------------------------------------------------------
--
-- ここを1回呼べば、抽選側（draw_categories）と画面側（tag_pools）の
-- 両方が同じ名前になる。**片方だけ直す道を残さない**ため、
-- 名前を変える作業はこの関数を通すことにする。

create or replace function public.set_category_label(
  p_category_key text,
  p_label        text
)
returns void
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_pool text;
begin
  if p_label is null or btrim(p_label) = '' then
    raise exception 'LABEL_EMPTY: 表示名が空です。';
  end if;

  select dc.pool_key into v_pool
    from public.draw_categories dc
   where dc.category_key = p_category_key;

  if v_pool is null then
    raise exception 'CATEGORY_NOT_FOUND: カテゴリ % はありません。', p_category_key;
  end if;

  update public.draw_categories set label = p_label
   where category_key = p_category_key;

  update public.tag_pools set label = p_label
   where pool_key = v_pool;
end;
$fn$;

comment on function public.set_category_label(text, text) is
  'カテゴリの表示名を変える唯一の入口（D171）。'
  '抽選側（draw_categories）と画面側（tag_pools）を同時に直す。'
  '分類の構造（category_key / pool_key）には触らない。';

revoke all on function public.set_category_label(text, text)
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. いまの10個を、その入口を通して入れ直す
-- ----------------------------------------------------------------------------
--
-- **値は変えていない。**いまの名前をそのまま通し、
-- 2つの表がずれていない状態から始める。
-- 名前を決めたら、この呼び出しの第2引数を書き換えるだけで全画面に反映される。

select public.set_category_label('morph',        'モーフ');
select public.set_category_label('emotion',      '感情');
select public.set_category_label('action',       '動作');
select public.set_category_label('body_state',   '身体状態');
select public.set_category_label('change',       '変化');
select public.set_category_label('environment',  '環境');
select public.set_category_label('relation',     '関係');
select public.set_category_label('property',     '性質');
select public.set_category_label('social_state', '社会状態');
select public.set_category_label('color',        'カラー');


-- ----------------------------------------------------------------------------
-- 3. ずれていないことを、あとから数えられるようにする
-- ----------------------------------------------------------------------------

create or replace function public.category_label_mismatches()
returns table (category_key text, draw_label text, pool_label text)
language sql
stable
security definer
set search_path = ''
as $fn$
  select dc.category_key, dc.label, tp.label
    from public.draw_categories dc
    join public.tag_pools tp on tp.pool_key = dc.pool_key
   where dc.label is distinct from tp.label;
$fn$;

comment on function public.category_label_mismatches() is
  '表示名が2つの表でずれているカテゴリを返す（D171）。0件が正しい状態。';

revoke all on function public.category_label_mismatches()
  from public, anon, authenticated;
