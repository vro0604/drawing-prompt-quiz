-- ============================================================================
-- 20260808120000_f0_prompt_origin_and_indexes.sql
--   S18 ／ F0 共通基盤。お題の出どころ・クイズの版・タグの索引3本
-- ============================================================================
--
-- 【なぜ、いま入れるか】
--   後から足すと **516件のお題を遡って意味づけることになる。**
--   いま入れれば、既定値がそのまま正しい。
--
--     origin        既存516件は全部ランダム抽選なので 'draft' が正しい
--     quiz_version  既存のクイズは全部 v1 なので 1 が正しい
--
--   1か月後に足すと、その間に増えたぶんの出どころが分からなくなる。
--   **「あとで埋める」ができない列だから、先に入れる。**
--
-- 【タグの近さは入れない】
--   F0 の3つ目「タグの近さ」は論点7（単一所属か複数所属か）が未決で、
--   しかも F1 の分類作業とセットでないと形が決まらない。
--   無理に押し込むと、**形だけ作って中身が空の列が残る。**
--   他の2列とは独立に足せるので、これだけ先送りする。
--
-- 【索引3本】
--   `tag_id` を含む索引は本番に1本も無い（付録A の実測）。
--   公開前デバッグの「索引の無い FK が15本ある」のうちの3本にあたる。
--
--   **D118（同じ札の作品）は、この索引が無いと成立しない**（D127）。
--   完全一致では0件なので共有タグで引くことになり、
--   `prompt_cards (tag_id)` を必ず通る。
--
-- 【戻しかた】
--   このファイルの末尾に rollback を書いてある。
--   列は default 付きで足すだけ、索引は付けるだけなので、
--   **既存の読み書きは1つも壊れない。**
--
-- 【危なくない理由】
--   ・not null default 付きの列追加は、Postgres 11 以降は表を書き直さない
--   ・索引は concurrently を使わない。516行・1,990行・1,089行と小さく、
--     一瞬で終わる。migration の中で concurrently は使えない
--     （トランザクションの中で走れないため）
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. prompts.origin ／ お題の出どころ
-- ----------------------------------------------------------------------------
--
-- ランダム抽選・保存構成・毎日のお題を区別できるようにする。
-- いまは区別する必要が無いが、**F5 と F6 が入った瞬間に必要になり、
-- そのときには遡れない。**
--
-- 値は CHECK で固定する（既存の division / status と同じ書きかた）。
-- 知らない値が入る余地を残さない。

alter table public.prompts
  add column if not exists origin text not null default 'draft';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.prompts'::regclass
       and conname  = 'prompts_origin_check'
  ) then
    alter table public.prompts
      add constraint prompts_origin_check
      check (origin in ('draft', 'saved', 'daily'));
  end if;
end $$;

comment on column public.prompts.origin is
  'お題の出どころ。draft=ランダム抽選 / saved=保存構成から / daily=毎日のお題。'
  '既存516件は draft。F3 F5 F6 が区別に使う。';


-- ----------------------------------------------------------------------------
-- 2. prompts.quiz_version ／ クイズの版
-- ----------------------------------------------------------------------------
--
-- 出題ルールを変えると、**過去の回答の意味が変わる。**
-- 既に 363件の回答と 1,089件の回答項目があり、
-- ここに新しい方式の数字を混ぜると、どちらも読めなくなる。
--
-- 版を持てば、混ぜずに数えられる。
--   v1 … いまの方式（誤答は同じプールからランダム）
--   v2 … F2 の方式（近縁誤答・仕掛けカード）
--
-- **CHECK は付けない。**版は増える一方で、増えるたびに
-- migration が要る形にすると、足すのをためらう理由になる。

alter table public.prompts
  add column if not exists quiz_version int not null default 1;

comment on column public.prompts.quiz_version is
  'このお題のクイズを作った出題ルールの版。既存は 1。'
  'F2 で方式を変えたとき、古い回答と混ぜずに数えるために使う。';


-- ----------------------------------------------------------------------------
-- 3. 索引3本 ／ tag_id を含むもの
-- ----------------------------------------------------------------------------
--
-- どれも「タグから引く」ための索引。いまは1本も無いので、
-- タグを条件にした問い合わせは全件走査になる。
-- 行数が小さいうちは気づかないが、**F3 / F4 / F7 / D118 は全部ここを通る。**

-- タグ検索（F7）と、同じ札の作品（D118）。いちばん効く
create index if not exists prompt_cards_tag_id_idx
  on public.prompt_cards (tag_id);

-- タグ別の提示回数と採用回数（F3）。
-- 8,802件の候補のうち 6,708件は一度も見られていないので、
-- 「配られたが選ばれなかった」を数えるのに要る
create index if not exists draft_candidates_tag_id_idx
  on public.draft_candidates (tag_id);

-- 何を何と間違えたか（F4）。1,089件の回答項目を誤答側から引く
create index if not exists answer_items_selected_tag_id_idx
  on public.answer_items (selected_tag_id);


-- ----------------------------------------------------------------------------
-- 4. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------
--
-- **投入の検証は migration の中に書く。**
-- あとで確かめる形にすると、確かめないまま次へ進む。

do $$
declare
  v_prompts      int;
  v_draft        int;
  v_version      int;
  v_indexes      int;
begin
  select count(*) into v_prompts from public.prompts;
  select count(*) into v_draft   from public.prompts where origin = 'draft';
  select count(*) into v_version from public.prompts where quiz_version = 1;

  -- 既存のお題は全部ランダム抽選で、全部 v1 のはず。
  -- 1件でも違えば既定値の指定を間違えている
  if v_draft <> v_prompts then
    raise exception
      'origin の既定値が効いていません（全%件のうち draft は%件）', v_prompts, v_draft;
  end if;

  if v_version <> v_prompts then
    raise exception
      'quiz_version の既定値が効いていません（全%件のうち 1 は%件）', v_prompts, v_version;
  end if;

  select count(*) into v_indexes
    from pg_indexes
   where schemaname = 'public'
     and indexname in (
       'prompt_cards_tag_id_idx',
       'draft_candidates_tag_id_idx',
       'answer_items_selected_tag_id_idx'
     );

  if v_indexes <> 3 then
    raise exception '索引が3本そろっていません（%本）', v_indexes;
  end if;

  raise notice 'S18 完了: お題%件に origin と quiz_version を入れ、索引を3本足しました',
    v_prompts;
end $$;


-- ============================================================================
-- rollback（手で流す用。migration としては実行しない）
-- ============================================================================
--
--   drop index if exists public.prompt_cards_tag_id_idx;
--   drop index if exists public.draft_candidates_tag_id_idx;
--   drop index if exists public.answer_items_selected_tag_id_idx;
--   alter table public.prompts drop constraint if exists prompts_origin_check;
--   alter table public.prompts drop column if exists origin;
--   alter table public.prompts drop column if exists quiz_version;
--
-- **列を落としても既存の読み書きは壊れない。**
-- どの RPC もこの2列を読んでいないため（S18 の時点では、まだ誰も使わない）。
-- ============================================================================
