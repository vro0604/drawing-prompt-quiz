-- ============================================================================
-- vocab_provenance ／ 語彙が「どこから来たか」と「誰が承認したか」を記録する
-- ============================================================================
--
-- 【なぜ要るか】
--   2026-09-04〜05 に、私（Claude）が語彙を大量に足した。
--     状態語 192語（8カテゴリ × 24語）
--     フレーバー語 90語
--     読み 438件（お題語348 ＋ フレーバー語90）
--     明示的な禁止の組 9組
--
--   機能としては動いているが、**内容はユーザーの承認を受けていない。**
--   いまの表には「誰が書いたか」も「承認されたか」も残っていないので、
--   点検しようとしても、旧語彙と私が書いたぶんの区別がつかない。
--
-- 【2つのフラグを1つにしない】
--   machine_checked_at … 機械の検査を通った時刻（文字・読み・同義・禁止の組）
--   approved_by_user   … ユーザーが目で見て認めたか
--
--   意味だけが近い言い換え（「葬送」と「終わり」のように文字も読みも
--   重ならないもの）は、機械では拾えない。だから
--   **「検査済み」を「承認済み」の代わりにしない。**
--   1つの列にまとめると、検査を通しただけで承認済みに見える。
--
-- 【出所の分け方】
--   legacy       … 2026-08 までにあった語。私が作ったものではない
--   moved        … 旧語彙から新しい分類へ移しただけの語（表記は同じ）
--   claude_new   … 2026-09-04 に私が新しく書いた語
--
--   実測（2026-09-05、PGlite に全 migration を当てて数えた）:
--     morph 126語 = motif から102語 ＋ species から24語。**新語は0**
--     状態8カテゴリ 192語 = すべて claude_new
--     カラー 15語 = legacy（旧 color プールをそのまま使う）
--     フレーバー 90語 = すべて claude_new
--
-- ============================================================================


alter table public.tags
  add column if not exists vocab_origin text;
alter table public.tags
  add column if not exists reading_source text;
alter table public.tags
  add column if not exists machine_checked_at timestamptz;
alter table public.tags
  add column if not exists approved_by_user boolean not null default false;

alter table public.flavor_vocab
  add column if not exists vocab_origin text;
alter table public.flavor_vocab
  add column if not exists reading_source text;
alter table public.flavor_vocab
  add column if not exists machine_checked_at timestamptz;
alter table public.flavor_vocab
  add column if not exists approved_by_user boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tags'::regclass
                    and conname = 'tags_vocab_origin_valid') then
    alter table public.tags
      add constraint tags_vocab_origin_valid
      check (vocab_origin is null or vocab_origin in ('legacy', 'moved', 'claude_new'));
  end if;

  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.flavor_vocab'::regclass
                    and conname = 'flavor_vocab_origin_valid') then
    alter table public.flavor_vocab
      add constraint flavor_vocab_origin_valid
      check (vocab_origin is null or vocab_origin in ('legacy', 'moved', 'claude_new'));
  end if;
end $$;

comment on column public.tags.vocab_origin is
  'この語がどこから来たか。legacy＝2026-08 までにあった語／'
  'moved＝旧語彙から新しい分類へ移しただけ／claude_new＝2026-09-04 に Claude が書いた語。';
comment on column public.tags.approved_by_user is
  'ユーザーが目で見て認めたか。**機械の検査とは別。**'
  '意味だけが近い言い換えは機械では拾えないので、この列を検査の結果で立てない。';
comment on column public.tags.machine_checked_at is
  '機械の検査（文字・読み・同義グループ・登録済みの禁止）を通した時刻。'
  '承認ではない。approved_by_user と同じ意味にしない。';
comment on column public.flavor_vocab.approved_by_user is
  'ユーザーが目で見て認めたか。**機械の検査とは別。**';


-- --- 出所を入れる -----------------------------------------------------------

-- 旧語彙（2026-08 までの8プール）
update public.tags
   set vocab_origin = 'legacy'
 where vocab_origin is null
   and pool_key in ('motif', 'color', 'species', 'genre',
                    'role', 'era', 'gender', 'constraint');

-- モーフ。旧語彙に同じ表記があるものは「移しただけ」
update public.tags t
   set vocab_origin = 'moved'
 where t.vocab_origin is null
   and t.pool_key = 'morph'
   and exists (
     select 1 from public.tags o
      where o.label = t.label
        and o.pool_key in ('motif', 'species', 'genre', 'role', 'era', 'gender')
   );

-- 残りは私が新しく書いた語（状態8カテゴリの192語と、もしあればモーフの新語）
update public.tags
   set vocab_origin = 'claude_new'
 where vocab_origin is null;

-- フレーバー語はすべて 2026-09-04 に私が書いた
update public.flavor_vocab
   set vocab_origin = 'claude_new'
 where vocab_origin is null;

-- 読みは、旧語彙のぶんも含めて 2026-09-05 に私が1語ずつ書いた
update public.tags
   set reading_source = 'claude_2026_09_05'
 where reading is not null and reading_source is null;

update public.flavor_vocab
   set reading_source = 'claude_2026_09_05'
 where reading is not null and reading_source is null;


-- --- 既存の is_reviewed の意味を、あらためて書いておく ----------------------
--
-- **is_reviewed = true は「私が1語ずつ見た」という意味しか持たない。**
-- ユーザーの承認ではない。2026-09-04 に90語すべてを true にしたのは私で、
-- その判断は誰にも確認されていない。承認の記録は approved_by_user のほうにある。
comment on column public.flavor_vocab.is_reviewed is
  '**Claude が1語ずつ見たか。**未確認の語を無条件に通さないための関門。'
  'ユーザーの承認ではない（承認は approved_by_user）。2026-09-05 に意味を書き直した。';


-- --- 読める列を配り直す -----------------------------------------------------
--
-- **出所も承認も配らない。**「この語は新しい」「この語は未承認」が見えると、
-- 4択のうちどれが古い語かで絞り込めてしまう。
revoke all on table public.tags from public, anon, authenticated;
grant select (id, pool_key, label) on public.tags to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 語彙の棚卸しを1本の関数で返す（点検用。運営だけ）
-- ----------------------------------------------------------------------------
--
-- 画面には出さない。scripts/vocab-audit.mjs が呼んで一覧を作る。
-- **判定は flavor_block_reason に一本化したまま。**ここでは呼ぶだけで、
-- 同じ規則を書き写さない。

create or replace function public.vocab_inventory()
returns table (
  kind              text,
  id                bigint,
  label             text,
  category_key      text,
  category_label    text,
  reading           text,
  synonym_group     text,
  vocab_origin      text,
  reading_source    text,
  approved_by_user  boolean,
  is_active         boolean
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select 'tag'::text, t.id, t.label, t.pool_key, tp.label,
         t.reading, t.synonym_group, t.vocab_origin, t.reading_source,
         t.approved_by_user, t.is_active
    from public.tags t
    join public.tag_pools tp on tp.pool_key = t.pool_key
  union all
  select 'flavor'::text, v.id, v.label, v.kind, v.kind,
         v.reading, v.synonym_group, v.vocab_origin, v.reading_source,
         v.approved_by_user, v.is_active
    from public.flavor_vocab v
  order by 1, 4, 3;
$fn$;

comment on function public.vocab_inventory() is
  '語彙の棚卸し（点検用）。語・分類・読み・同義グループ・出所・承認の有無を返す。'
  '一般利用者には配らない（新しい語が見えると4択を絞れるため）。';

revoke all on function public.vocab_inventory()
  from public, anon, authenticated;


-- ----------------------------------------------------------------------------
-- 除外の理由を、正解語ごとに全部返す（点検用。運営だけ）
-- ----------------------------------------------------------------------------

create or replace function public.vocab_block_matrix()
returns table (
  tag_id      bigint,
  tag_label   text,
  pool_key    text,
  vocab_id    bigint,
  vocab_label text,
  reason      text
)
language sql
stable
security definer
set search_path = ''
as $fn$
  select t.id, t.label, t.pool_key, v.id, v.label,
         public.flavor_block_reason(v.id, t.id)
    from public.tags t
    cross join public.flavor_vocab v
   where t.is_active and v.is_active
     and public.flavor_block_reason(v.id, t.id) is not null
   order by t.pool_key, t.label, v.label;
$fn$;

comment on function public.vocab_block_matrix() is
  'どの正解語に対して、どのヒント語が、どの理由で除外されるか（点検用）。'
  '判定は flavor_block_reason 1本に集約したまま。ここでは呼ぶだけ。';

revoke all on function public.vocab_block_matrix()
  from public, anon, authenticated;
