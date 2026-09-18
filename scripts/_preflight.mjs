/**
 * _preflight.mjs ／ 本番を変える前に、この作業木が安全かを機械的に判定する共通部分
 *
 * 【何を防ぐか】
 *   この計算機には作業木（git worktree）が6つある。そのうち主作業木は
 *   2026-09-18 の実測で origin/main より 86 コミット遅れ、3 コミット進み、
 *   未コミットの変更が 181 件あった。**その状態から本番へ出すと、
 *   本番が 86 コミットぶん巻き戻る。**
 *
 *   直近2回はどちらも途中で人が気づいて作業木を作り直したため事故にならなかった。
 *   気づくかどうかに頼るのをやめる、というのがこのファイルの目的である。
 *
 * 【どこで止めるか】
 *   本番を変える操作の**直前**に、次の3つを見る。
 *     1. いま遠くの main が何を指しているか（毎回取り直す。控えを信じない）
 *     2. この作業木の HEAD が、その main を含んでいるか
 *     3. 身に覚えのない未コミットの変更が無いか
 *   加えて、DBへ書くときだけ migration の並びも見る。
 *
 * 【直さない】
 *   条件を満たさないとき、この道具は**何も直さない。**
 *   merge も rebase も reset も stash も行わない。やることを文章で出して、
 *   終了コード 1 で止まるだけである。直すのは人の判断に属する。
 *   （主作業木の未コミット 181 件は、触れば消える種類のものなので特にそうする）
 *
 * 【事実と判定を分ける】
 *   collectFacts が git から事実を集め、judge がその事実だけを見て合否を出す。
 *   judge は git を呼ばないので、**古い作業木や遠くの main が進んだ状況を
 *   机の上で作って試験できる。**test/preflight/selftest.mjs がそれを使う。
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * 未コミットでも数えない2つのパス。**この2つだけ。完全一致だけ。**
 *
 * 出所: ユーザー承認（2026-09-18）「統合.md と 統合サムネイル/ の2パスだけは
 * com.kazushi.weave が継続的に生成するため、dirty stop 条件から除外してよい」。
 * 条件も同じ発言で指定されている。
 *   ・完全一致のパスだけ
 *   ・類似名や親ディレクトリ全体を許可しない
 *   ・migration の判定には影響させない
 *   ・出す対象ファイルの判定には使わない
 *   ・この例外があることを出力に明示する
 *
 * だから前方一致も部分一致もしない。`統合.md.bak` も `統合サムネイル/1.png` も
 * 例外にならず、ふつうの未コミットとして数える（＝止まる）。
 * migration の欠落と版番号の重複は別の場所（collectMigrations）で数えていて、
 * この一覧を一度も見ない。出すコミットの中身もこの一覧を見ない。
 */
export const AUTO_NOISE = ["統合.md", "統合サムネイル/"];

/** 判定の種類。核はどれにも入っている */
export const MODES = {
  core: "共通（本番を変える操作すべて）",
  deploy: "画面を本番へ出す（origin の main を進める）",
  db: "本番のデータベースへ書く",
  push: "main を更新する push（pre-push hook から）",
};

/* ------------------------------------------------------------------ *
 * git を呼ぶ側
 * ------------------------------------------------------------------ */

/** git を1回呼ぶ。失敗は例外にせず { ok:false } で返す */
export function runGit(args, { cwd = process.cwd(), timeout = 60_000 } = {}) {
  try {
    const out = execFileSync("git", args, {
      cwd,
      timeout,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: out.replace(/\n$/, "") };
  } catch (e) {
    const stderr = (e.stderr || "").toString().trim();
    return { ok: false, out: "", error: stderr || e.message };
  }
}

/**
 * 遠くの main が「いま」何を指しているかを、取り直して読む。
 *
 * 手元の refs/remotes/origin/main は**前回 fetch したときの控え**である。
 * 控えを信じると、確認してから push するまでの間に main が進んでいても気づけない。
 * だから ls-remote で毎回引く。
 */
export function readRemoteMain({ cwd = process.cwd(), remote = "origin", branch = "main" } = {}) {
  const r = runGit(["ls-remote", remote, `refs/heads/${branch}`], { cwd });
  if (!r.ok) return { ok: false, error: r.error };
  const line = r.out.split("\n").find((l) => l.trim().length > 0);
  if (!line) return { ok: false, error: `${remote} に ${branch} がありません。` };
  return { ok: true, sha: line.split(/\s+/)[0] };
}

/**
 * 判定に使う事実を全部集める。**ここでは合否を出さない。**
 *
 * fetch を既定で行う。「fetch 済みかどうか」を当てに行くより、
 * 自分で引いてしまうほうが確実で、引けなかったこと自体も事実として残せる。
 */
export function collectFacts({
  cwd = process.cwd(),
  doFetch = true,
  remote = "origin",
  branch = "main",
} = {}) {
  const facts = {
    at: new Date().toISOString(),
    remote,
    branch,
    repo: null,
    worktree: null,
    head: null,
    headSubject: null,
    onBranch: null,
    fetch: { done: false, error: null },
    remoteMain: { sha: null, error: null },
    localRemoteRef: { sha: null, error: null },
    refMatchesRemote: null,
    mergeBase: null,
    behind: null,
    ahead: null,
    dirty: { unexpected: [], noise: [] },
    migrations: null,
    error: null,
  };

  const top = runGit(["rev-parse", "--show-toplevel"], { cwd });
  if (!top.ok) {
    facts.error = `git のリポジトリの中ではありません（${cwd}）。`;
    return facts;
  }
  facts.repo = top.out;
  facts.worktree = top.out;

  const common = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
  const gitdir = runGit(["rev-parse", "--path-format=absolute", "--git-dir"], { cwd });
  facts.isMainWorktree = common.ok && gitdir.ok ? common.out === gitdir.out : null;

  const head = runGit(["rev-parse", "HEAD"], { cwd });
  facts.head = head.ok ? head.out : null;
  const subject = runGit(["log", "-1", "--pretty=%s"], { cwd });
  facts.headSubject = subject.ok ? subject.out : null;
  const br = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd });
  facts.onBranch = br.ok ? br.out : null;

  if (doFetch) {
    const f = runGit(["fetch", remote, branch], { cwd });
    facts.fetch.done = f.ok;
    facts.fetch.error = f.ok ? null : f.error;
  }

  const rm = readRemoteMain({ cwd, remote, branch });
  facts.remoteMain.sha = rm.ok ? rm.sha : null;
  facts.remoteMain.error = rm.ok ? null : rm.error;

  const localRef = runGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], { cwd });
  facts.localRemoteRef.sha = localRef.ok && localRef.out ? localRef.out : null;
  facts.localRemoteRef.error = localRef.ok ? null : localRef.error;

  if (facts.remoteMain.sha && facts.localRemoteRef.sha) {
    facts.refMatchesRemote = facts.remoteMain.sha === facts.localRemoteRef.sha;
  }

  // 遠くの main を基準に測る。手元の控えではなく、いま引いた値を使う。
  const target = facts.remoteMain.sha || facts.localRemoteRef.sha;
  if (target && facts.head) {
    const mb = runGit(["merge-base", target, "HEAD"], { cwd });
    facts.mergeBase = mb.ok ? mb.out : null;
    const counts = runGit(["rev-list", "--left-right", "--count", `${target}...HEAD`], { cwd });
    if (counts.ok) {
      const [behind, ahead] = counts.out.split(/\s+/).map((n) => Number(n));
      facts.behind = Number.isFinite(behind) ? behind : null;
      facts.ahead = Number.isFinite(ahead) ? ahead : null;
    }
  }

  const status = runGit(["status", "--porcelain=v1", "-z"], { cwd });
  if (status.ok) {
    for (const entry of status.out.split("\0")) {
      if (!entry) continue;
      const code = entry.slice(0, 2);
      const file = entry.slice(3);
      if (!file) continue;
      const item = { code, path: file };
      if (isAutoNoise(file)) facts.dirty.noise.push(item);
      else facts.dirty.unexpected.push(item);
    }
  } else {
    facts.error = `git status を読めませんでした: ${status.error}`;
  }

  facts.migrations = collectMigrations({ cwd, root: facts.repo, target });

  return facts;
}

/**
 * AUTO_NOISE の2つと**完全に同じ綴りか。**
 *
 * 前方一致にしない。`統合サムネイル/1.png` のように中の1件が別々に出てきたら、
 * それは例外にせず、ふつうの未コミットとして数える。
 * git status は、中に追跡済みのファイルが無いフォルダを `統合サムネイル/` の
 * 1行にまとめて出す（-z で引用もしない）。ふだん出るのはこの形である。
 */
export function isAutoNoise(file) {
  const clean = file.replace(/^"|"$/g, "");
  return AUTO_NOISE.includes(clean);
}

/**
 * migration の並びを集める。
 *
 * 【なぜ見るか】
 *   2026-09-09 に、2つの作業線が同じ版番号 20260909180000 を別々の SQL に
 *   使った。本番の履歴には billing_founding_creator_v0 が、片方の作業木には
 *   profile_rpc_revoke_anon が、同じ番号で入っていた。
 *   **古い作業木から当てると、本番に無いほうを本番の番号で当ててしまう。**
 *
 * 【3つ数える】
 *   欠落      … origin/main にあって、この作業木に無い（＝作業木が古い決定的な印）
 *   手元だけ  … この作業木にあって origin/main に無い（＝これから出すもの。異常ではない）
 *   版番号重複 … 同じ14桁が2つ以上の名前に使われている（＝上の事故そのもの）
 */
export function collectMigrations({ cwd = process.cwd(), root, target } = {}) {
  const dir = path.join(root || cwd, "supabase", "migrations");
  const local = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  let remote = [];
  let remoteError = null;
  if (target) {
    const r = runGit(["ls-tree", "-r", "--name-only", target, "--", "supabase/migrations"], { cwd });
    if (r.ok) {
      remote = r.out
        .split("\n")
        .filter((f) => f.endsWith(".sql"))
        .map((f) => path.basename(f))
        .sort();
    } else {
      remoteError = r.error;
    }
  }

  const localSet = new Set(local);
  const remoteSet = new Set(remote);
  const missing = remote.filter((f) => !localSet.has(f));
  const localOnly = local.filter((f) => !remoteSet.has(f));

  const byVersion = new Map();
  for (const name of new Set([...local, ...remote])) {
    const version = name.split("_")[0];
    if (!/^\d{14}$/.test(version)) continue;
    if (!byVersion.has(version)) byVersion.set(version, new Set());
    byVersion.get(version).add(name);
  }
  const collisions = [...byVersion.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([version, names]) => ({ version, names: [...names].sort() }));

  return {
    dir,
    exists: existsSync(dir),
    local,
    remote,
    remoteError,
    missing,
    localOnly,
    collisions,
  };
}

/* ------------------------------------------------------------------ *
 * 判定する側（git を呼ばない。事実だけを見る）
 * ------------------------------------------------------------------ */

/**
 * 事実から合否を出す。**この関数は git も網も触らない。**
 *
 * 戻り値 { ok, blockers, notes }。blockers が1つでもあれば ok は false で、
 * 呼び出し側は終了コード 1 で止まる。
 */
export function judge(facts, { mode = "core", push = null } = {}) {
  const blockers = [];
  const notes = [];
  const add = (code, title, detail, todo) => blockers.push({ code, title, detail, todo });

  if (facts.error) {
    add("E0", "作業木を読めない", facts.error, "このフォルダが git の作業木かを確かめてください。");
    return { ok: false, mode, blockers, notes };
  }

  // --- 1. 遠くの main の最新値を持っているか -------------------------
  if (!facts.remoteMain.sha) {
    add(
      "C1",
      `${facts.remote} の ${facts.branch} を読めない`,
      facts.remoteMain.error || "git ls-remote が値を返しませんでした。",
      "網につながっているか、リポジトリへの権限があるかを確かめてください。" +
        "読めないあいだは、本番を変える操作をしません。",
    );
  } else if (facts.fetch.done === false && facts.fetch.error) {
    notes.push({
      title: "fetch は失敗したが、遠くの値は読めた",
      detail: facts.fetch.error,
    });
  }

  if (facts.remoteMain.sha && facts.refMatchesRemote === false) {
    add(
      "C2",
      "手元の控えが古い",
      `refs/remotes/${facts.remote}/${facts.branch} は ${short(facts.localRemoteRef.sha)}、` +
        `いま遠くにあるのは ${short(facts.remoteMain.sha)}。`,
      `git fetch ${facts.remote} ${facts.branch} を実行してから、もう一度この確認を通してください。`,
    );
  }

  // --- 2. この作業木が、その main を含んでいるか ----------------------
  if (facts.behind === null) {
    add(
      "C3",
      "遅れの量を測れない",
      "HEAD と遠くの main の距離を数えられませんでした。",
      "git fetch を済ませてから、もう一度この確認を通してください。",
    );
  } else if (facts.behind > 0) {
    add(
      "C3",
      `${facts.branch} より ${facts.behind} コミット遅れている`,
      `この作業木の HEAD は ${short(facts.head)}。` +
        `${facts.remote}/${facts.branch} の ${facts.behind} 件がまだ入っていません。` +
        `ここから本番へ出すと、その ${facts.behind} 件ぶんが本番から消えます。`,
      [
        "この作業木は1バイトも動かさず、新しい作業木を作ってください。",
        `  git fetch ${facts.remote}`,
        `  git worktree add -b <枝の名前> ../dpq-<名前> ${facts.remote}/${facts.branch}`,
        "  cp -al node_modules ../dpq-<名前>/node_modules",
        "（この道具は merge も rebase も reset もしません）",
      ].join("\n"),
    );
  }

  // --- 3. 身に覚えのない未コミットの変更が無いか ----------------------
  if (facts.dirty.unexpected.length > 0) {
    const list = facts.dirty.unexpected.slice(0, 10).map((d) => `  ${d.code} ${d.path}`).join("\n");
    const more =
      facts.dirty.unexpected.length > 10
        ? `\n  … ほか ${facts.dirty.unexpected.length - 10} 件`
        : "";
    add(
      "C4",
      `未コミットの変更が ${facts.dirty.unexpected.length} 件ある`,
      `本番へ出るのはコミットされた内容だけです。手元の変更は出ません。` +
        `出すつもりのものが入っていないか、出すつもりのないものが混ざっていないかが、` +
        `この状態では分かりません。\n${list}${more}`,
      "出すものをコミットし、出さないものは別の作業木に残してください。" +
        "（この道具は commit も stash も reset もしません）",
    );
  }
  // 例外があること自体を、当たっていてもいなくても毎回書く。
  // 出所: ユーザー承認（2026-09-18）「この例外があることを出力に明示」。
  notes.push({
    title:
      facts.dirty.noise.length > 0
        ? `未コミットから外した例外 ${facts.dirty.noise.length} 件（完全一致の2パスのみ）`
        : "未コミットから外す例外は、完全一致の2パスのみ（今回は該当なし）",
    detail:
      (facts.dirty.noise.length > 0
        ? `${facts.dirty.noise.map((d) => `${d.code} ${d.path}`).join(" / ")}。`
        : "") +
      `例外は ${AUTO_NOISE.join(" と ")} だけ（常駐ジョブ com.kazushi.weave が作り直す）。` +
      "前方一致も部分一致もしない。migration の判定と、出すコミットの中身には使わない。",
  });

  // --- 4. 進みぶんの申告 ----------------------------------------------
  if (facts.ahead !== null) {
    notes.push({
      title:
        facts.ahead === 0
          ? `${facts.remote}/${facts.branch} との差は無い（出すものが無い）`
          : `この作業木にしか無いコミットが ${facts.ahead} 件ある`,
      detail:
        facts.ahead === 0
          ? "push しても本番は変わりません。"
          : `この ${facts.ahead} 件が、今回本番へ出るものです。`,
    });
  }

  // --- 5. 種類ごとの追加条件 ------------------------------------------
  if (mode === "deploy" || mode === "push") judgeDeploy(facts, notes);
  if (mode === "db" || mode === "push") judgeDb(facts, add, notes);
  if (mode === "push") judgePushedRef(facts, push, add, notes);

  return { ok: blockers.length === 0, mode, blockers, notes };
}

/**
 * pre-push hook から呼ばれたときだけの追加条件。
 *
 * 【なぜ HEAD だけでは足りないか】
 *   `git push origin feature/foo:main` は、いま取り出している内容と関係なく、
 *   別の枝の先端を main へ送れる。上の判定は**この作業木の HEAD**を測っているので、
 *   送るものが HEAD でなければ、測ったものと送るものが別になる。
 *   測っていないものは通さない。
 *
 * 【消す push】
 *   `git push origin :main` は main そのものを消す。本番の枝が無くなる。
 *   遅れも汚れも関係なく、常に止める。
 */
function judgePushedRef(facts, push, add, notes) {
  if (!push) {
    add(
      "P0",
      "送るものが分からない",
      "pre-push が渡す ref の行を読めませんでした。",
      "この形の push は通しません。`npm run deploy:main -- --apply` を使ってください。",
    );
    return;
  }

  notes.push({
    title: "送り先は main",
    detail: `${push.localRef || "(削除)"} → ${push.remoteRef}`,
  });

  if (push.deleting) {
    add(
      "P1",
      "main を消す push である",
      "本番の枝そのものを消す操作です。確かめようがありません。",
      "main を消す必要が本当にあるなら、この柵を外すのではなく、手順を相談してください。",
    );
    return;
  }

  if (push.localSha && facts.head && push.localSha !== facts.head) {
    add(
      "P2",
      "送るものが、この作業木の内容ではない",
      `送ろうとしているのは ${short(push.localSha)}（${push.localRef || "?"}）ですが、` +
        `この作業木が取り出しているのは ${short(facts.head)} です。` +
        "上の遅れ・汚れ・migration の判定は、取り出している側を測ったものなので、" +
        "送るものについては何も確かめられていません。",
      "送りたい内容を取り出している作業木へ移ってから、もう一度 push してください。",
    );
  }
}

/** 画面を本番へ出すときの追加条件 */
function judgeDeploy(facts, notes) {
  // 早送りできるか。behind が 0 なら早送りになるので、ここは基点の申告だけ。
  if (facts.behind === 0 && facts.mergeBase && facts.remoteMain.sha) {
    notes.push({
      title: "早送りで出せる",
      detail: `基点 ${short(facts.mergeBase)} が、いまの ${facts.remote}/${facts.branch} と同じです。`,
    });
  }
  if (facts.onBranch === null) {
    notes.push({
      title: "枝の上にいない（detached HEAD）",
      detail: "コミットは HEAD を名指しして出すことになります。",
    });
  }
}

/** 本番のデータベースへ書くときの追加条件 */
function judgeDb(facts, add, notes) {
  const m = facts.migrations;
  if (!m) {
    add("D0", "migration の並びを読めない", "supabase/migrations を読めませんでした。", "作業木の状態を確かめてください。");
    return;
  }
  if (m.remoteError) {
    add(
      "D0",
      "origin/main 側の migration を読めない",
      m.remoteError,
      "git fetch を済ませてから、もう一度この確認を通してください。",
    );
    return;
  }

  if (m.missing.length > 0) {
    const list = m.missing.slice(0, 10).map((f) => `  ${f}`).join("\n");
    const more = m.missing.length > 10 ? `\n  … ほか ${m.missing.length - 10} 本` : "";
    add(
      "D1",
      `${facts.remote}/${facts.branch} にあって、この作業木に無い migration が ${m.missing.length} 本ある`,
      `この作業木は、本番に当たっているはずの SQL を持っていません。` +
        `ここから当てると、本番の履歴とファイルの対応が崩れます。\n${list}${more}`,
      `新しい作業木を ${facts.remote}/${facts.branch} から作り直してください。`,
    );
  }

  if (m.collisions.length > 0) {
    const list = m.collisions
      .map((c) => `  ${c.version} → ${c.names.join(" / ")}`)
      .join("\n");
    add(
      "D2",
      `同じ版番号を2つ以上のファイルが使っている（${m.collisions.length} 件）`,
      `版番号は本番の履歴表の主キーです。重複したまま当てると、` +
        `履歴には片方の名前が、本番には他方の中身が入ります。` +
        `2026-09-09 の 20260909180000 がこの形でした。\n${list}`,
      "どちらか一方の版番号を、まだ使われていない新しい番号へ付け替えてください。",
    );
  }

  if (m.localOnly.length > 0) {
    notes.push({
      title: `この作業木にしか無い migration が ${m.localOnly.length} 本`,
      detail:
        m.localOnly.join(" / ") +
        "（これから当てるもの。異常ではありませんが、当てる前に名前を見てください）",
    });
  }
  notes.push({
    title: "migration の本数",
    detail: `手元 ${m.local.length} 本 ／ ${facts.remote}/${facts.branch} ${m.remote.length} 本`,
  });
}

function short(sha) {
  return sha ? sha.slice(0, 7) : "（不明）";
}

/* ------------------------------------------------------------------ *
 * 人が読む形にする
 * ------------------------------------------------------------------ */

export function formatReport(facts, verdict) {
  const L = [];
  L.push("───────────────────────────────────────────");
  L.push(` 本番を変える前の確認 ／ ${MODES[verdict.mode] || verdict.mode}`);
  L.push("───────────────────────────────────────────");

  if (facts.error) {
    L.push(`  ${facts.error}`);
  } else {
    const kind = facts.isMainWorktree === false ? "副の作業木" : facts.isMainWorktree === true ? "主作業木" : "作業木";
    L.push(`  作業木        ${facts.worktree}（${kind}）`);
    L.push(`  枝            ${facts.onBranch || "（枝の上にいない）"}`);
    L.push(`  HEAD          ${short(facts.head)}  ${facts.headSubject || ""}`);
    L.push(`  手元の控え    ${short(facts.localRemoteRef.sha)}  refs/remotes/${facts.remote}/${facts.branch}`);
    L.push(
      `  いまの遠く    ${short(facts.remoteMain.sha)}  git ls-remote（${
        facts.refMatchesRemote === true ? "控えと一致" : facts.refMatchesRemote === false ? "控えと不一致" : "比べられない"
      }）`,
    );
    L.push(`  基点          ${short(facts.mergeBase)}`);
    L.push(`  遅れ / 進み   ${facts.behind ?? "?"} / ${facts.ahead ?? "?"}`);
    L.push(
      `  未コミット    ${facts.dirty.unexpected.length} 件` +
        (facts.dirty.noise.length ? `（自動生成の ${facts.dirty.noise.length} 件は別勘定）` : ""),
    );
    if (facts.migrations) {
      const m = facts.migrations;
      L.push(
        `  migration     手元 ${m.local.length} 本 ／ 遠く ${m.remote.length} 本 ／ ` +
          `欠落 ${m.missing.length} ／ 手元だけ ${m.localOnly.length} ／ 版番号の重複 ${m.collisions.length}`,
      );
    }
  }

  L.push("");
  if (verdict.notes.length > 0) {
    for (const n of verdict.notes) {
      L.push(`  ・${n.title}`);
      if (n.detail) L.push(`    ${n.detail}`);
    }
    L.push("");
  }

  if (verdict.ok) {
    L.push("  ○ 条件を満たしています。本番への変更に進めます。");
  } else {
    L.push(`  ✗ ${verdict.blockers.length} 件の条件を満たしていません。本番への変更は行いません。`);
    L.push("");
    for (const [i, b] of verdict.blockers.entries()) {
      L.push(`  ${i + 1}. [${b.code}] ${b.title}`);
      for (const line of String(b.detail).split("\n")) L.push(`     ${line}`);
      L.push("     やること:");
      for (const line of String(b.todo).split("\n")) L.push(`       ${line}`);
      L.push("");
    }
    L.push("  この道具は、自分では merge / rebase / reset / stash / commit を行いません。");
  }
  L.push("───────────────────────────────────────────");
  return L.join("\n");
}

/* ------------------------------------------------------------------ *
 * 呼び出し側から使う入口
 * ------------------------------------------------------------------ */

/**
 * 本番を変える前に必ず通す関門。満たしていなければ**その場でプロセスを終える。**
 *
 * 環境変数では外せない。外す口を作らないのは、環境変数は
 * シェルの設定・親プロセス・.env ファイルの3通りで「いつのまにか立つ」ためで、
 * それは test/guard/no-production.mjs が既に同じ理由で採っている作法である。
 */
export function requireSafeWorktree({ mode = "core", cwd = process.cwd(), label = "" } = {}) {
  const facts = collectFacts({ cwd });
  const verdict = judge(facts, { mode });
  console.log(formatReport(facts, verdict));
  if (!verdict.ok) {
    if (label) console.error(`\n✗ ${label} は実行しませんでした。`);
    process.exit(1);
  }
  return { facts, verdict };
}
