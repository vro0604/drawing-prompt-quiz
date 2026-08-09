import Image from "next/image";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";
import { SavedList } from "@/app/_saved-list";
import {
  fetchHandleRedirect,
  fetchPublicAnswers,
  fetchPublicProfile,
  fetchSavedWorks,
  fetchUserWorks,
} from "@/features/profile/rpc";
import {
  PORTFOLIO_TABS,
  formatTotalTime,
  isCreatorHidden,
  percentOf,
  ratioPercent,
  type PublicProfile,
  type SlotStatSummary,
} from "@/features/profile/types";
import { workImageUrl } from "@/features/work/rpc";
import { divisionLabel, type PublicWorkListItem } from "@/features/work/types";
import { surface } from "@/app/_surface";

/**
 * /u/[handle] ／ 公開プロフィール（ポートフォリオ）。
 *
 * 【なぜ /u/ を挟むのか】
 *   `/{handle}` にすると、ID がアプリのページ名と同じ空間に並ぶ。
 *   あとからページを1つ増やすたびに「その名前の ID を持つ人」と
 *   ぶつかる可能性が出て、既存の利用者の URL を壊さないと
 *   新機能を出せなくなる。/u/ を挟めば衝突しようがない（D59）。
 *
 * 【公開設定の切れているタブは「出さない」】
 *   0件と書くのでも「非公開です」と書くのでもなく、**タブごと出さない**。
 *   「公開していない」のか「公開しているが空」なのかを画面が区別できない
 *   表示にすると、どちらとも取れる。件数を隠すだけでも
 *   「使っているかどうか」は伝わる（spec 12-1）。
 *
 *   DB 側も二重に守っている。設定が切れていれば get_saved_works /
 *   get_public_answers は他人へ0件しか返さない。
 *
 * 【描き手としての記録は常に公開】
 *   投稿した作品そのものが公開なので、その集計を隠す意味が無い（spec 12-0）。
 *
 * Next.js 16 では params / searchParams が Promise なので await が必要。
 */

const PAGE_SIZE = 24;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;
  const profile = await fetchPublicProfile(handle);

  if (!profile) return { title: "プロフィール" };

  return {
    title: `${profile.display_name}（@${profile.handle}）`,
    description: profile.bio ?? `${profile.display_name} さんの作品とお題の記録。`,
    // 正本はいまの ID。旧ID の URL はページ側で移すので、
    // 検索やSNSに旧ID が残らない
    alternates: { canonical: `/u/${profile.handle}` },
    openGraph: {
      type: "profile",
      title: `${profile.display_name}（@${profile.handle}）`,
      description: profile.bio ?? `${profile.display_name} さんの作品とお題の記録。`,
      url: `/u/${profile.handle}`,
    },
  };
}

/** 枠ごとの正答率。挑戦0回は「—」にする（0% と区別する） */
function SlotStatList({ stats }: { stats: SlotStatSummary[] }) {
  if (stats.length === 0) {
    return (
      <p className="text-xs text-faint">
        まだ枠ごとの記録がありません。
      </p>
    );
  }

  return (
    <ul className="space-y-1 text-xs">
      {stats.map((s) => {
        const percent = percentOf(s.corrects, s.attempts);
        return (
          <li key={s.card_slot_key} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-faint">{s.label}</span>
            <span className="font-bold tabular-nums">
              {percent === null ? "—" : `${percent}%`}
            </span>
            <span className="text-faint">
              {s.corrects} / {s.attempts}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function CreatorStats({ profile }: { profile: PublicProfile }) {
  const { creator } = profile;

  // 伏せられているときは、**そもそも節ごと出さない**（D136）。
  // 「非公開です」と書くと、隠していること自体が情報になる。
  // spec 12-1 が非公開のタブを「存在ごと見せない」としているのと同じ。
  if (isCreatorHidden(creator)) return null;

  const accuracy = ratioPercent(creator.accuracy);

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">描き手としての記録</h2>
        <p className="text-xs text-faint">
          {profile.is_self && !profile.show_creator_stats
            ? "公開設定が切れているので、他の人には出ていません。"
            : "公開した作品の集計です。"}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {[
          { label: "投稿数", value: `${creator.works_count}` },
          { label: "獲得いいね", value: `${creator.likes_received}` },
          { label: "受けた回答", value: `${creator.answers_count}` },
          { label: "総制作時間", value: formatTotalTime(creator.total_actual_seconds) },
        ].map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-faint">{item.label}</dt>
            <dd className="text-lg font-bold tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="space-y-2 border-t border-ink/10 pt-4">
        <div className="flex items-baseline gap-3">
          <h3 className="text-xs text-faint">伝わりやすさ</h3>
          <span className="text-lg font-bold tabular-nums">
            {accuracy === null ? "—" : `${accuracy}%`}
          </span>
          <span className="text-xs text-faint">
            回答が5人以上集まった作品だけで平均しています
          </span>
        </div>
        <SlotStatList stats={creator.slot_stats} />
      </div>
    </section>
  );
}

function AnswerStats({ profile }: { profile: PublicProfile }) {
  const stats = profile.answer_stats;
  if (!stats) return null;

  const overall = percentOf(stats.total_correct_items, stats.total_items);

  return (
    <section className={`${surface} space-y-4`}>
      <div className="space-y-1">
        <h2 className="text-sm font-bold">
          回答者としての記録
          {profile.is_self && !profile.show_answer_stats ? (
            <span className="ml-2 text-xs font-normal text-notice">
              （非公開。あなたにだけ見えています）
            </span>
          ) : null}
        </h2>
        <p className="text-xs text-faint">
          クイズにどれだけ当てられたかです。
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {[
          { label: "回答した作品", value: `${stats.total_answers}` },
          { label: "総合正答率", value: overall === null ? "—" : `${overall}%` },
          { label: "答えた設問", value: `${stats.total_items}` },
        ].map((item) => (
          <div key={item.label}>
            <dt className="text-xs text-faint">{item.label}</dt>
            <dd className="text-lg font-bold tabular-nums">{item.value}</dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-ink/10 pt-4">
        <SlotStatList stats={stats.slot_stats} />
      </div>
    </section>
  );
}

function WorkGrid({ works }: { works: PublicWorkListItem[] }) {
  if (works.length === 0) {
    return (
      <p className="text-sm text-faint">
        この部門の作品はまだありません。
      </p>
    );
  }

  return (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {works.map((w) => (
        <li key={w.id}>
          <Link
            href={`/works/${w.id}`}
            className="group block space-y-3 rounded-2xl border border-line p-3 transition hover:border-line-hover"
          >
            <div className="overflow-hidden rounded-xl bg-sunken">
              <Image
                src={workImageUrl(w.image_path)}
                alt={w.title}
                width={w.image_width}
                height={w.image_height}
                className="h-40 w-full object-cover transition group-hover:scale-[1.02]"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
              />
            </div>
            <div className="space-y-1 px-1 pb-1">
              <p className="truncate text-sm font-bold">{w.title}</p>
              {w.source_title ? (
                <p className="truncate text-xs text-faint">
                  {w.source_title}
                </p>
              ) : null}
              <p className="text-xs text-faint">
                {divisionLabel(w.division)}・回答 {w.answers_count}・いいね {w.likes_count}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ handle: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { handle } = await params;
  const { tab: rawTab } = await searchParams;

  const profile = await fetchPublicProfile(handle);

  // いまの ID で見つからないときだけ、旧ID かどうかを調べる（P5）。
  //
  // 【なぜ301（恒久）で移すのか】
  //   ID を変えたら古い URL は二度と別人のものにならない（旧ID は
  //   他人に渡さない）。恒久的な移動なので、検索エンジンにも
  //   新しい URL を覚えてもらってよい。
  //
  // 【旧ID を残さない】
  //   移した先で描画するので、ページの canonical も共有カードも
  //   いまの ID になる。旧ID は URL のやり取りにしか現れない。
  if (!profile) {
    const current = await fetchHandleRedirect(handle);
    if (current) {
      permanentRedirect(
        rawTab ? `/u/${current}?tab=${rawTab}` : `/u/${current}`,
      );
    }
    // 存在しない ID と、まだ handle を決めていない人を区別しない（D40）
    notFound();
  }

  // 公開設定の切れているタブは、そもそも一覧に載せない。
  // 本人には自分の設定が切れていても出す（自分の持ち物は常に見られる）。
  const tabs = PORTFOLIO_TABS.filter(
    (t) => t.gate === null || profile.is_self || profile[t.gate],
  );
  const tab = tabs.find((t) => t.key === rawTab) ?? tabs[0];

  const works =
    tab.division !== null
      ? await fetchUserWorks({
          userId: profile.id,
          division: tab.division,
          sort: "new",
          limit: PAGE_SIZE,
          offset: 0,
        })
      : [];

  const saves =
    tab.key === "saves"
      ? await fetchSavedWorks({ userId: profile.id, limit: PAGE_SIZE, offset: 0 })
      : [];

  const answers =
    tab.key === "answers"
      ? await fetchPublicAnswers({ userId: profile.id, limit: PAGE_SIZE, offset: 0 })
      : [];

  return (
    <main className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-10">
      {/* --- 見出し ------------------------------------------------------------ */}
      <header className="space-y-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold break-words">{profile.display_name}</h1>
          <p className="text-sm text-faint">@{profile.handle}</p>
        </div>

        {profile.bio ? (
          <p className="text-sm whitespace-pre-wrap break-words text-muted">
            {profile.bio}
          </p>
        ) : null}

        {Object.keys(profile.links).length > 0 ? (
          <ul className="flex flex-wrap gap-4 text-sm">
            {Object.entries(profile.links).map(([key, url]) => (
              <li key={key}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="underline"
                >
                  {key}
                </a>
              </li>
            ))}
          </ul>
        ) : null}

        {profile.is_self ? (
          <p className="text-sm">
            <Link href="/account" className="underline">
              プロフィールと公開設定を変更する
            </Link>
          </p>
        ) : null}
      </header>

      <CreatorStats profile={profile} />
      <AnswerStats profile={profile} />

      {/* --- タブ -------------------------------------------------------------- */}
      <nav className="flex flex-wrap gap-2 border-t border-ink/10 pt-6">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key === tabs[0].key ? `/u/${profile.handle}` : `/u/${profile.handle}?tab=${t.key}`}
            className={
              t.key === tab.key
                ? "rounded-full bg-accent px-4 py-2 text-xs font-bold text-on-accent"
                : "rounded-full border border-line-mid px-4 py-2 text-xs font-bold hover:bg-hover"
            }
          >
            {t.label}
            {t.gate !== null && profile.is_self && !profile[t.gate] ? "（非公開）" : ""}
          </Link>
        ))}
      </nav>

      {/* --- 中身 -------------------------------------------------------------- */}
      {tab.division !== null ? <WorkGrid works={works} /> : null}

      {tab.key === "saves" ? (
        <SavedList
          items={saves}
          showStatus={profile.is_self}
          emptyMessage="お気に入りに入れた作品はまだありません。"
        />
      ) : null}

      {tab.key === "answers" ? (
        answers.length === 0 ? (
          <p className="text-sm text-faint">
            回答した作品はまだありません。
          </p>
        ) : (
          <ul>
            {answers.map((a) => (
              <li
                key={a.work_id}
                className="border-b border-ink/10 py-4 last:border-b-0"
              >
                <Link href={`/works/${a.work_id}`} className="flex items-start gap-4 hover:opacity-80">
                  <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl bg-sunken">
                    <Image
                      src={workImageUrl(a.image_path)}
                      alt={a.title}
                      width={a.image_width}
                      height={a.image_height}
                      className="h-16 w-16 object-cover"
                      sizes="64px"
                    />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="truncate text-sm font-bold">{a.title}</p>
                    <p className="truncate text-xs text-faint">
                      {a.author_display_name}
                    </p>
                    <p className="text-xs text-faint">
                      {new Date(a.answered_at).toLocaleDateString("ja-JP")}・
                      {a.item_count}問中 {a.correct_count}問 正解
                    </p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </main>
  );
}
