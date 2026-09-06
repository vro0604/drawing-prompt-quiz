-- ============================================================================
-- D169 ／ 次の作品は「同じ部門」から「回答0件を最優先」で配る。
--        作品一覧に「未回答のみ」を足す。
-- ============================================================================
--
-- 出所: docs/decisions.md の D169（2026-09-06 にユーザーが確定）。
--       ここで実装するのは D169 のうち初期公開向けの3項目だけ。
--         ・12「次の作品では現在の部門を引き継ぐ」
--         ・3「救済帯は 回答0件／1件以上 の2つだけ」
--         ・11「一覧に 未回答のみ を足す」
--       個人適合（パーソナライズ）は1行も入れていない。
--
-- 【この migration が変えること】
--   1. next_work_candidates を新設する（次の作品の候補と、その救済帯）
--   2. get_next_work を、引数から部門を受け取らない形へ置き換える
--   3. get_public_works に「未回答のみ」を足す
--   4. 旧い画面が呼ぶ形の入口を2つ残す（互換ラッパー）
--        ・get_next_work(uuid, text)                     → 新版へ素通し
--        ・get_public_works(text,text,int,int,text)       → 新版へ素通し
--
-- 【なぜ互換ラッパーが要るか】
--   本番は「DBを先に更新し、そのあと画面を差し替える」順で当てる。
--   その間、**旧い画面と新しいDBが同時に動く時間帯**がある。
--   旧い形の入口を消すと、その時間帯に一覧と次の作品が落ちる。
--   落ちる時間を「数分だけ」と見積もって進めない。落ちない形にする。
--   旧い入口の削除は、新しい画面が本番で動くのを確かめた後の別 migration。
--
-- 【変えないこと】
--   ・既存の表・列・制約・索引は1つも変えない
--   ・データを1行も書き換えない
--   ・旧 get_public_works（5引数版）が返す列と既定値は1つも変えない
--   ・AI部門を通常の一覧から分ける既存の仕様（20260803041246）はそのまま
--   ・旧方式（3問）の作品を候補から外すようなことはしない
--
--
-- ============================================================================
-- 【なぜ部門を引数で受け取らないのか】
-- ============================================================================
--
--   これまでの get_next_work は p_division という引数で部門を受け取っていた。
--   引数のままで「現在の部門を引き継ぐ」を作ると、**引き継ぎは呼び出し側の
--   善意になる。**画面が渡す値を書き換えれば別の部門を取れてしまう。
--
--   D169 の12は「別部門へ自動的に連れ出さない」と決めている。これを
--   **DB の側で保証する**ためには、部門を外から受け取らないのがいちばん短い。
--   引数を消したので、渡す値が無い。改ざんできる入口がそもそも無くなる。
--
--   代わりに、部門は**いま答えた作品の行から読む。**
--   読めるのは公開・審査OK・未削除の作品だけなので、
--   非公開の作品のIDを渡して部門を探ることもできない。
--
--   【旧2引数版は消さない。互換ラッパーとして並べる】
--     本番は「DBを先に更新し、画面を後から差し替える」順で当てる。
--     その間、旧い画面と新しいDBが同時に動く時間帯がある。
--     旧い画面が2引数で呼んでも失敗しないよう、
--     **旧 get_next_work(uuid, text) を残す。**中身は新版を呼ぶだけで、
--     2番目の部門引数は受け取るが**使わない**（値を信用しない）。
--     部門は新版が現在作品の行から導出するので、
--     旧い画面から部門を改ざんしても D169 の12は破れない。
--
--     【並存させても曖昧にならない形にする（実測で確かめた）】
--       Postgres は「既定値つきの引数」を数に入れて候補を選ぶ。
--       旧2引数版の既定値をそのままにすると、引数1個の呼び出しが
--       (uuid) 版と (uuid, text) 版の**どちらにも当てはまり**、
--       `function is not unique` で両方とも失敗する
--       （実測: PGlite 上で `fd(p:=null)` が not unique になった）。
--
--       そこで旧2引数版からは既定値を外す。
--         ・引数1個の呼び出し → (uuid) 版だけに当てはまる
--         ・引数2個の呼び出し → (uuid, text) 版だけに当てはまる
--       どの呼び方でも候補が1つに決まる（実測で5通り確認）。
--
--     旧版の削除は、新しい画面が本番で動くのを確かめた後の
--     別 migration で行う。ここではしない。
--
--
-- ============================================================================
-- 【なぜ救済帯を「順位」ではなく「集合」で作るのか】
-- ============================================================================
--
--   前の実装は `order by answers_count asc, random()` だった。これは
--   **回答数の少ない順に並べる**作りで、1件の作品が10件の作品より
--   常に先に出る。D169 の3は、そこまでは決めていない。
--
--     第1救済帯 … 回答0件
--     第2救済帯 … 回答1件以上
--
--   決まっているのはこの2つの帯だけで、**帯の中は当面ランダム**である。
--   1件と10件は同じ帯なので、同じ資格で並ぶ。順位を付けない。
--
--   そこで「並べ替えて上から1件」ではなく
--   「いちばん上の帯だけを残し、その中から無作為に1件」にする。
--   min(band) を取ってから絞るので、第1帯が1件でもあれば
--   第2帯は**候補集合に残らない。**係数で逆転できる形にしていない
--   （D169 の2「救済はスコアではなく硬い制約」）。
--
--
-- ============================================================================
-- 【回答数をどこから数えるか】
-- ============================================================================
--
--   works.answers_count という列がある。ただしこれは回答が1行入るたびに
--   トリガーが +1 するだけの**控え**で、減らす経路が無い（20260803041353）。
--   帯の判定を控えの側で行うと、控えと実際の行がずれたときに
--   「0件なのに第2帯」「1件あるのに第1帯」が起きる。
--
--   **数える先を answers の行そのものにする。**
--   answers には (work_id, user_id) の一意制約があり、その索引が
--   work_id を先頭に持つので、行を数える形でも索引が効く。
--   ずれようがない数え方にしておけば、控えの同期を別に作らなくてよい。
--
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. 次の作品の候補と、その救済帯
-- ----------------------------------------------------------------------------
--
-- 【返すもの】
--   work_id … 候補の作品
--   band    … 1 なら回答0件、2 なら回答1件以上
--
-- 【並べない】
--   ここでは1件も並べ替えない。**順位を付けないことがこの機能の中身**なので、
--   並べ替えを書かないことに意味がある。選ぶのは呼んだ側。
--
-- 【誰が呼べるか】
--   anon と authenticated。返すのは「公開されている作品のID」と
--   「その作品に回答が1件でもあるか」だけで、どちらも作品ページと
--   一覧（get_public_works）から既に見えている情報しか含まない。
--   お題も正解も回答者も返さない。

create or replace function public.next_work_candidates(
  p_current_work_id uuid default null
)
returns table (
  work_id uuid,
  band    int
)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_uid      uuid := (select auth.uid());
  v_division text;
begin
  -- いま答えた作品の部門を、**その作品の行から**取る。
  -- クライアントは部門を渡せない（引数が無い）。
  if p_current_work_id is not null then
    select w.division
      into v_division
      from public.works w
     where w.id = p_current_work_id
       and w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null;

    -- 非公開・審査未通過・削除済み・存在しないID。
    -- **どれも同じ「候補なし」で返す。**理由を分けると、
    -- そのIDの作品が在るのか無いのかを外から数えられてしまう（D40）。
    --
    -- 判定に FOUND を使う。行が無いとき select into は変数を NULL にするので、
    -- 「見つかったか」を自前の真偽値で持つと `not NULL` が真にならず、
    -- **素通りする**（実測: 存在しないIDで次の作品が返った）。
    if not found then
      return;
    end if;
  end if;

  return query
    select w.id,
           case when exists (select 1 from public.answers a where a.work_id = w.id)
                then 2 else 1 end
      from public.works w
     where w.is_published
       and w.review_status = 'ok'
       and w.deleted_at is null
       -- いま見ている作品そのものは出さない
       and (p_current_work_id is null or w.id <> p_current_work_id)
       -- 部門。**現在の作品と同じものだけ**（D169 の12）。
       -- 現在の作品が無いとき（直接呼ばれたとき）だけ、
       -- 一覧の既定と同じ「AI以外」に落とす。AI を常に除く条件は残さない。
       and (
         case
           when v_division is not null then w.division = v_division
           else w.division <> 'ai'
         end
       )
       -- 自分の作品には答えられない（D28）
       and (v_uid is null or w.user_id <> v_uid)
       -- すでに答えた作品は出さない
       and (v_uid is null
            or not exists (select 1 from public.answers a
                            where a.work_id = w.id and a.user_id = v_uid));
end;
$fn$;

comment on function public.next_work_candidates(uuid) is
  '次の作品の候補と救済帯（D169 の3・12）。'
  'band 1 = 回答0件 / band 2 = 回答1件以上。部門は現在作品の行から取る。'
  '並べ替えは一切しない。回答数による順位も付けない。';

revoke all on function public.next_work_candidates(uuid)
  from public, anon, authenticated;
grant execute on function public.next_work_candidates(uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2. 次の作品を1件返す
-- ----------------------------------------------------------------------------
--
-- 【選び方】
--   1. 候補を出す（上の関数。部門・自作・回答済みはここで落ちている）
--   2. **いちばん上の帯だけ**を残す（第1帯があれば第1帯だけ）
--   3. その中から無作為に1件
--
--   2 と 3 の順番を入れ替えない。先に並べ替えてから帯を見る形にすると、
--   帯をまたいで押し上げる余地が生まれる（D169 の2で禁じている形）。
--
-- 【引数から部門が消えた】
--   新版は現在の作品のIDだけを受け取る。旧2引数版はこの下に
--   **互換ラッパーとして作り直す**（ファイル冒頭の理由のとおり）。
--
--   drop してから作り直すのは、旧2引数版の既定値を外すため。
--   既定値を残したままだと引数1個の呼び出しが曖昧になる。
--   drop と create は同じ migration＝同じトランザクションの中なので、
--   旧2引数版が存在しない時間は外から観測されない。

drop function if exists public.get_next_work(uuid, text);

create function public.get_next_work(
  p_current_work_id uuid default null
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with cand as (
    select c.work_id, c.band
      from public.next_work_candidates(p_current_work_id) c
  ),
  top_band as (
    select min(cand.band) as band from cand
  )
  select coalesce(
    (select jsonb_build_object('work_id', picked.work_id, 'has_next', true)
       from (
         select cand.work_id
           from cand, top_band
          where cand.band = top_band.band
          order by random()
          limit 1
       ) picked),
    jsonb_build_object('work_id', null, 'has_next', false)
  );
$$;

comment on function public.get_next_work(uuid) is
  'まだ回答していない公開作品を1件返す（D169）。'
  '部門は現在作品から引き継ぐ（引数では渡せない）。'
  '回答0件の作品があればその中だけから、無ければ回答1件以上から、無作為に1件。'
  '帯の中で回答数による順位は付けない。返り値は作品IDだけで、お題も正解も含まない。';

revoke all on function public.get_next_work(uuid) from public, anon, authenticated;
grant execute on function public.get_next_work(uuid) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 2b. 旧2引数版の互換ラッパー（互換期間だけ置く）
-- ----------------------------------------------------------------------------
--
-- 【何のためにあるか】
--   DBを先に更新し、画面を後から差し替える間だけ、旧い画面がここへ入る。
--   新しい画面はここを通らない。
--
-- 【部門引数を信用しない】
--   p_division は受け取るだけで、条件にも変数にも一切使わない。
--   使わないことがこの関数の中身である。**新版へそのまま素通しする。**
--   その結果、旧い画面が別部門を指定しても、返るのは
--   「現在の作品と同じ部門」の作品になる（D169 の12を DB 側で守る）。
--
-- 【既定値を付けない】
--   付けると引数1個の呼び出しが (uuid) 版と競合し、両方が失敗する。
--   ここに既定値を足さないこと。下の自己検査がそれを見張る。
--
-- 【いつ消すか】
--   新しい画面が本番で動くのを確かめた後の別 migration。
--   このファイルでは消さない。

create function public.get_next_work(
  p_current_work_id uuid,
  p_division        text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  -- p_division は意図的に使わない（旧い画面との互換のためだけに受け取る）
  select public.get_next_work(p_current_work_id);
$$;

comment on function public.get_next_work(uuid, text) is
  '【互換期間だけ置く旧版】旧い画面が2引数で呼ぶための入口。'
  'p_division は受け取るが使わない。部門は新版が現在作品の行から導出する。'
  '新しい画面が本番で動いたら別 migration で削除する。';

revoke all on function public.get_next_work(uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_next_work(uuid, text) to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3. 一覧に「未回答のみ」を足す（D169 の11）
-- ----------------------------------------------------------------------------
--
-- 【これは推薦ではない】
--   見る人が自分で選ぶ絞り込みである。システムが選ぶ「次の作品」とは
--   完全に別の道具で、互いのコードを共有していない（D169 の11）。
--
-- 【なぜ DB 側で外すのか】
--   取ってから画面で捨てると、1ページの件数がばらつき、
--   次のページに回答済みの作品が混ざる。**数える前に外す。**
--   部門と完成度をここで絞っているのと同じ理由（20260803041246 / 20260808140000）。
--
-- 【見ているのは回答の行だけ】
--   「開いたかどうか」は見ない。作品を開いただけでは消えない。
--   閲覧履歴という表は作っていないし、作る予定もここには無い
--   （D118 は未確定のまま。D169 は D118 を決めていない）。
--
-- 【利用者が分からないとき】
--   auth.uid() が取れなければ、誰の回答かを決められない。
--   そのときは**絞り込まない**（全部返す）。画面側は、その状態では
--   この絞り込みを押せないようにして、理由を書く。
--   ここで0件を返すと「作品が1件も無い」ように見えるので、そうしない。
--
-- 【引数が6つになる。旧5引数版は消さない】
--   本番は「DBを先に更新し、画面を後から差し替える」順で当てる。
--   その間、旧い画面（5引数で呼ぶ）と新しいDBが同時に動く。
--   ここで5引数版を drop すると、その時間帯の作品一覧が丸ごと落ちる。
--   **旧5引数版は残す。**中身は新6引数版を p_unanswered_only = false で
--   呼ぶだけのラッパーに差し替える（返す列は1つも変えない）。
--
--   【並存させても曖昧にならない形にする（実測で確かめた）】
--     Postgres は既定値つきの引数を数に入れて候補を選ぶ。
--     6引数版の6番目に既定値を付けると、5引数の呼び出しが
--     5引数版と6引数版の**どちらにも当てはまり**、両方とも
--     `function is not unique` で失敗する（実測: PGlite で確認）。
--
--     また Postgres は「既定値のある引数の後ろに、既定値の無い引数」を
--     許さない（実測: 42P13 input parameters after one with a default value
--     must also have defaults）。6番目だけ既定値を外すことはできない。
--
--     **そこで新6引数版は、6つとも既定値を持たない。**
--       ・引数5個以下の呼び出し → 旧5引数版だけに当てはまる
--       ・引数6個の呼び出し     → 新6引数版だけに当てはまる
--     どの呼び方でも候補が1つに決まる（実測で6通り確認）。
--     新しい画面は必ず6つとも渡す。
--
--   旧5引数版の削除は、新しい画面が本番で動くのを確かめた後の別 migration。

create function public.get_public_works(
  p_division         text,
  p_sort             text,
  p_limit            int,
  p_offset           int,
  p_completeness     text,
  p_unanswered_only  boolean
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  completeness        text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    w.id,
    w.title,
    w.image_path,
    w.image_width,
    w.image_height,
    w.division,
    w.completeness,
    w.source_title,
    w.source_character,
    w.fanart_note,
    w.actual_time_seconds,
    p.time_limit_seconds,
    p.mode_key,
    p.was_rerolled,
    w.likes_count,
    w.saves_count,
    w.answers_count,
    w.created_at,
    pr.id,
    pr.handle,
    pr.display_name
  from public.works w
  join public.prompts  p  on p.id  = w.prompt_id
  join public.profiles pr on pr.id = w.user_id
  where w.is_published
    and w.review_status = 'ok'
    and w.deleted_at is null
    and case
          when p_division is null  then w.division <> 'ai'
          when p_division = 'all'  then true
          else w.division = p_division
        end
    -- 知らない値が来たら0件になって終わる。部門と同じ扱い
    and (p_completeness is null or w.completeness = p_completeness)
    -- 未回答のみ（D169 の11）。利用者が分からないときは絞らない
    and (
      not coalesce(p_unanswered_only, false)
      or (select auth.uid()) is null
      or not exists (select 1 from public.answers a
                      where a.work_id = w.id
                        and a.user_id = (select auth.uid()))
    )
  order by
    case when p_sort = 'likes'   then w.likes_count   end desc nulls last,
    case when p_sort = 'answers' then w.answers_count end desc nulls last,
    w.created_at desc,
    w.id desc
  limit  least(greatest(coalesce(p_limit, 24), 1), 50)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

comment on function public.get_public_works(text, text, int, int, text, boolean) is
  '公開作品の一覧。prompt_id は返さない（D23）。'
  'p_division: null=通常（AI以外）／original／fanart／ai／all。'
  'p_completeness: null=すべて／sketch／lineart／finished。'
  'p_unanswered_only: true=自分が回答済みの作品を外す（D169 の11）。'
  '見ているのは回答の行だけで、閲覧履歴は見ない。';

revoke all on function public.get_public_works(text, text, int, int, text, boolean)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int, text, boolean)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 3b. 旧5引数版を、中身だけラッパーに差し替える（互換期間だけ）
-- ----------------------------------------------------------------------------
--
-- 【drop しない】
--   drop すると、旧い画面が動いている時間帯の作品一覧が落ちる。
--   `create or replace` なので、**この関数のOIDも権限も返す列も変わらない。**
--   変わるのは中身だけ。旧い画面から見た振る舞いは今までと同じ
--   （未回答フィルタを掛けない＝従来の表示条件）。
--
-- 【既定値はそのまま残す】
--   旧い画面や既存の検査が4引数・5引数で呼ぶ。既定値を外すとそれが落ちる。
--
-- 【いつ消すか】
--   新しい画面が本番で動くのを確かめた後の別 migration。ここではしない。

create or replace function public.get_public_works(
  p_division     text default null,
  p_sort         text default 'new',
  p_limit        int  default 24,
  p_offset       int  default 0,
  p_completeness text default null
)
returns table (
  id                  uuid,
  title               text,
  image_path          text,
  image_width         int,
  image_height        int,
  division            text,
  completeness        text,
  source_title        text,
  source_character    text,
  fanart_note         text,
  actual_time_seconds int,
  time_limit_seconds  int,
  mode_key            text,
  was_rerolled        boolean,
  likes_count         int,
  saves_count         int,
  answers_count       int,
  created_at          timestamptz,
  author_id           uuid,
  author_handle       text,
  author_display_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select * from public.get_public_works(
    p_division, p_sort, p_limit, p_offset, p_completeness, false
  );
$$;

comment on function public.get_public_works(text, text, int, int, text) is
  '【互換期間だけ置く旧版】旧い画面が5引数で呼ぶための入口。'
  '新6引数版を p_unanswered_only = false で呼ぶだけ。返す列は従来と同じ。'
  '新しい画面が本番で動いたら別 migration で削除する。';

revoke all on function public.get_public_works(text, text, int, int, text)
  from public, anon, authenticated;

grant execute on function public.get_public_works(text, text, int, int, text)
  to anon, authenticated;


-- ----------------------------------------------------------------------------
-- 4. 入ったことを、この場で確かめる（D69）
-- ----------------------------------------------------------------------------
--
-- **書いたとおりのものが入ったかを、その場で見る。**
-- 後から別の検査で見つけるより、入れた瞬間に止めたほうが安い。
--
-- ここで見るものが、前の版から1つ増えた。
-- 「旧版が消えたこと」ではなく、**「旧版と新版が並び、どの呼び方でも
-- 呼び先が1つに決まること」**を見る。並存が壊れていたら、
-- 本番でDBを先に更新した瞬間に旧い画面が落ちる。

do $$
declare
  v_def text;
  v_n   int;
begin
  -- 4-1. get_next_work が新1引数版と旧2引数版の2つあること
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_next_work'
       and p.pronargs = 1
  ) then
    raise exception 'get_next_work(uuid) がありません';
  end if;

  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_next_work'
       and p.pronargs = 2
  ) then
    raise exception
      '旧 get_next_work(uuid, text) の互換ラッパーがありません。'
      'これが無いと、DBだけ先に更新した時間帯に旧い画面が落ちます';
  end if;

  -- 4-2. 旧2引数版に既定値が付いていないこと。
  --      付いていると引数1個の呼び出しが両方に当てはまり、
  --      **旧い画面も新しい画面もまとめて失敗する。**
  select p.pronargdefaults into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_next_work' and p.pronargs = 2;
  if v_n <> 0 then
    raise exception
      '旧 get_next_work(uuid, text) に既定値が % 個あります。'
      '既定値があると引数1個の呼び出しが曖昧になります（0 にしてください）', v_n;
  end if;

  -- 4-3. 旧2引数版が部門を使っていないこと。
  --      受け取るだけで捨てるのが、この互換ラッパーの中身である。
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_next_work' and p.pronargs = 2;
  if v_def not like '%public.get_next_work(p_current_work_id)%' then
    raise exception
      '旧 get_next_work(uuid, text) が新版へ素通ししていません。'
      '部門引数を使う実装が残っている可能性があります';
  end if;

  -- 4-4. 回答数で順位を付ける並べ替えが、どこにも残っていないこと。
  --      **D169 の3が禁じているのは、まさにこの一行である。**
  --      見るのは2つ。
  --        ・控えの列（answers_count）を選定に使っていないこと
  --        ・order by が random 以外で並べていないこと
  for v_def in
    select pg_get_functiondef(p.oid)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_next_work', 'next_work_candidates')
  loop
    if lower(v_def) like '%answers_count%' then
      raise exception
        '次の作品の選定が works.answers_count（控えの列）を見ています。'
        '帯の判定は answers の行そのもので行うこと';
    end if;

    if exists (
      select 1
        from regexp_matches(lower(v_def), 'order\s+by\s+(\w+)', 'g') as m
       where m[1] <> 'random'
    ) then
      raise exception
        '次の作品の選定に、無作為以外の並べ替えが残っています（回答数の順位は付けない）';
    end if;
  end loop;

  -- 4-5. 未認証・匿名の双方から呼べること（ゲストも次の作品へ進める）
  if not has_function_privilege('anon', 'public.get_next_work(uuid)', 'execute') then
    raise exception 'anon が get_next_work(uuid) を呼べません';
  end if;
  if not has_function_privilege('authenticated', 'public.get_next_work(uuid)', 'execute') then
    raise exception 'authenticated が get_next_work(uuid) を呼べません';
  end if;
  if not has_function_privilege('anon', 'public.get_next_work(uuid, text)', 'execute') then
    raise exception 'anon が旧 get_next_work(uuid, text) を呼べません';
  end if;
  if not has_function_privilege('authenticated', 'public.get_next_work(uuid, text)', 'execute') then
    raise exception 'authenticated が旧 get_next_work(uuid, text) を呼べません';
  end if;
  if not has_function_privilege('anon', 'public.next_work_candidates(uuid)', 'execute') then
    raise exception 'anon が next_work_candidates を呼べません';
  end if;

  -- 4-6. 一覧が旧5引数版と新6引数版の2つあること
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_public_works'
       and p.pronargs = 5
  ) then
    raise exception
      '旧 get_public_works（5引数版）がありません。'
      'これが無いと、DBだけ先に更新した時間帯に作品一覧が落ちます';
  end if;
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'get_public_works'
       and p.pronargs = 6
  ) then
    raise exception 'get_public_works（6引数版）がありません';
  end if;

  -- 4-7. 新6引数版に既定値が1つも無いこと。
  --      1つでもあると5引数の呼び出しが曖昧になり、旧い画面が落ちる。
  select p.pronargdefaults into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_public_works' and p.pronargs = 6;
  if v_n <> 0 then
    raise exception
      '新 get_public_works（6引数版）に既定値が % 個あります。'
      '既定値があると5引数の呼び出しが曖昧になります（0 にしてください）', v_n;
  end if;

  -- 4-8. 旧5引数版が新6引数版へ素通ししていること
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_public_works' and p.pronargs = 5;
  if v_def not like '%public.get_public_works(%' then
    raise exception '旧 get_public_works（5引数版）が新版へ素通ししていません';
  end if;

  if not has_function_privilege(
       'anon',
       'public.get_public_works(text, text, int, int, text, boolean)',
       'execute') then
    raise exception 'anon が get_public_works（6引数版）を呼べません';
  end if;
  if not has_function_privilege(
       'anon',
       'public.get_public_works(text, text, int, int, text)',
       'execute') then
    raise exception 'anon が旧 get_public_works（5引数版）を呼べません';
  end if;

  -- 4-9. security definer と search_path が全部に付いていること
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('get_next_work', 'next_work_candidates', 'get_public_works')
       and (not p.prosecdef
            or coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%')
  ) then
    raise exception 'security definer か search_path が付いていない関数があります';
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- 5. どの呼び方でも呼び先が1つに決まることを、実際に呼んで確かめる
-- ----------------------------------------------------------------------------
--
-- 上の 4 はカタログ（関数の台帳）を読んだだけである。
-- **曖昧かどうかは、呼んでみないと分からない。**
-- 呼び先が2つに割れていれば Postgres が `function is not unique` で止まる。
--
-- ここで呼ぶのはすべて読み取りだけの関数で、1行も書かない。
-- 0件でも構わない。見ているのは「呼べたか」だけである。

do $$
declare
  v_ignore jsonb;
  v_n      int;
begin
  -- 次の作品：引数なし／引数1個／引数2個
  v_ignore := public.get_next_work();
  v_ignore := public.get_next_work(null::uuid);
  v_ignore := public.get_next_work(null::uuid, null::text);
  v_ignore := public.get_next_work(p_current_work_id := null);
  v_ignore := public.get_next_work(p_current_work_id := null, p_division := 'all');

  -- 一覧：引数4個（既存の検査）／5個（旧い画面）／6個（新しい画面）
  select count(*) into v_n from public.get_public_works(null, 'new', 1, 0);
  select count(*) into v_n from public.get_public_works(null, 'new', 1, 0, null);
  select count(*) into v_n from public.get_public_works(
    p_division := null, p_sort := 'new', p_limit := 1,
    p_offset := 0, p_completeness := null);
  select count(*) into v_n from public.get_public_works(null, 'new', 1, 0, null, false);
  select count(*) into v_n from public.get_public_works(
    p_division := null, p_sort := 'new', p_limit := 1,
    p_offset := 0, p_completeness := null, p_unanswered_only := true);
exception
  when others then
    raise exception
      '新旧の並存が曖昧です（% / %）。'
      'どれかの呼び方で呼び先が1つに決まっていません', sqlstate, sqlerrm;
end $$;
