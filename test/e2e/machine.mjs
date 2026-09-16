/**
 * machine.mjs ／ 試験を始める前に、計算機の混み具合を測って残す
 *
 * 【なぜ要るか】
 *   2026-09-10 に、ブラウザ全件試験（92件）が6回続けて緑にならなかった。
 *   90/92, 90/92, 起動失敗, 91/92, 60/92, 81/92。落ちる項目は毎回入れ替わり、
 *   回答の保存を1度も通らない群（管理画面・アカウント・持ち込み）まで落ちた。
 *
 *   原因は交換領域（swap。記憶領域が足りないときに、中身を保存装置へ
 *   一時的に追い出す仕組み）の枯渇だった。この端末は記憶領域が 8GB で、
 *   試験を始めた時点で交換領域を 13.0GB 使っていた。そこへ
 *   `next dev` と PGlite とブラウザを同時に立てたので、必要なものを
 *   出し入れし続けるだけで時間が過ぎた。
 *
 *   **証拠は、合格した試験まで含めて一様に遅くなっていたこと。**
 *   1件あたりの所要時間の中央値が 3,215ms から 24,217ms へ8倍に伸びていた。
 *   回答の保存経路を変えたことで、管理画面を開くだけの試験が8倍遅くなる
 *   ことはない。**遅いのは試験ではなく端末のほうだった。**
 *
 * 【ここで測るもの】
 *   ユーザー指示（2026-09-10）が挙げた4つのうち、始める前に測れる3つ。
 *   残る1つ（1件あたりの中央値）は、全部終わってからでないと出ないので
 *   record.mjs が出す。
 *     1. 交換領域の使用量
 *     2. 同時に走っている組み立て・試験
 *     3. next-server / ブラウザ / PGlite の負荷
 *
 * 【測るだけで、何も止めない】
 *   他の作業線のプロセスと、編集機の拡張のプロセスは**1つも止めない。**
 *   出所: ユーザー指示（2026-09-10）「他worktreeやVS Code拡張のprocessは
 *   勝手に停止しない。」
 *
 * 【失敗しても投げない】
 *   ここは試験の付随情報を集める場所で、試験そのものではない。
 *   測れなければ null を返す。**測れなかったことで試験を落とさない。**
 */

import { execFileSync } from "node:child_process";
import { loadavg, totalmem } from "node:os";

/** 外の道具を1つ呼ぶ。落ちたら null。**投げない** */
function run(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/**
 * 交換領域の使用量（MB）。
 *
 * macOS の `sysctl -n vm.swapusage` は
 * `total = 15360.00M  used = 13914.25M  free = 1445.75M  (encrypted)`
 * という1行を返す。**この形以外は読まない。**読めなければ null。
 */
export function readSwap() {
  const out = run("/usr/sbin/sysctl", ["-n", "vm.swapusage"]);
  if (out === null) return null;

  const mb = (name) => {
    const m = out.match(new RegExp(`${name}\\s*=\\s*([0-9.]+)M`));
    return m === null ? null : Number(m[1]);
  };

  const usedMb = mb("used");
  if (usedMb === null) return null;
  return { totalMb: mb("total"), usedMb, freeMb: mb("free") };
}

/**
 * 数えたい相手。**それぞれ別に数える。**
 * まとめて1つの数にすると、何が場所を取っているのか分からなくなる。
 *
 * 判定は「実行ファイルの名前」と「引数」の2段で行う。
 * **引数の文字列だけで数えない。**そうすると、同じ言葉を含む
 * 探し物の命令（grep など）や、それを包む shell の行まで数に入る
 * （実測: 引数だけで見た初版は、この探し物の命令そのものを
 * 「ブラウザ試験が2件走っている」と数えた）。
 */
const WATCHED = [
  {
    key: "next-server",
    exe: /^(next-server|next)$/,
    args: /next-server|\bdev\b|next-router-worker/,
  },
  { key: "ブラウザ", exe: /^chrome-headless-shell$/, args: /./ },
  { key: "縦断試験・ブラウザ試験", exe: /^node$/, args: /\btest\/(db|e2e)\/[a-z-]+\.mjs/ },
  { key: "組み立て・型検査", exe: /^(node|tsc|next)$/, args: /next build|\btsc\b|turbopack/ },
];

/**
 * いま走っている重い相手を数える。**自分自身は数えない。**
 *
 * PGlite は検証用サーバーと同じプロセスの中で動くので、独立した行は出ない。
 * その負荷は「縦断試験・ブラウザ試験」の行の使用率に含まれる。
 */
export function readBusyProcesses() {
  const out = run("/bin/ps", ["-Ao", "pid=,pcpu=,rss=,command="]);
  if (out === null) return null;

  const self = new Set([process.pid, process.ppid]);
  const found = new Map(WATCHED.map((w) => [w.key, { count: 0, cpu: 0, rssMb: 0 }]));

  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/);
    if (m === null) continue;
    const [, pid, cpu, rss, command] = m;
    if (self.has(Number(pid))) continue;

    // 最初の語が実行ファイル。末尾の名前だけを見る
    const exe = (command.split(/\s+/)[0] ?? "").split("/").pop();
    const args = command.slice(command.indexOf(" ") + 1);

    for (const w of WATCHED) {
      if (!w.exe.test(exe)) continue;
      if (!w.args.test(args)) continue;
      const slot = found.get(w.key);
      slot.count += 1;
      slot.cpu += Number(cpu);
      slot.rssMb += Number(rss) / 1024;
      break; // 1つのプロセスを2か所で数えない
    }
  }

  return [...found].map(([key, v]) => ({
    key,
    count: v.count,
    cpu: Math.round(v.cpu * 10) / 10,
    rssMb: Math.round(v.rssMb),
  }));
}

/** 交換領域・平均待ち行列・重いプロセスを、1つにまとめて測る */
export function readMachine() {
  return {
    at: new Date().toISOString(),
    swap: readSwap(),
    loadavg: loadavg().map((n) => Math.round(n * 100) / 100),
    totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    busy: readBusyProcesses(),
  };
}

/** 人が読む1行にする。記録にも画面にも同じ文字列を出す */
export function describeMachine(m, label) {
  if (m === null || m === undefined) return `（${label}: 測れませんでした）`;

  const swap = m.swap
    ? `交換領域 ${(m.swap.usedMb / 1024).toFixed(1)}GB 使用` +
      (m.swap.totalMb ? ` / ${(m.swap.totalMb / 1024).toFixed(1)}GB` : "")
    : "交換領域 不明";

  const busy = (m.busy ?? [])
    .filter((b) => b.count > 0)
    .map((b) => `${b.key} ${b.count}件（CPU ${b.cpu}%）`)
    .join(" / ");

  return (
    `（${label}: ${swap} ／ 記憶領域 ${m.totalMemGb}GB ／ ` +
    `平均待ち ${m.loadavg.join(" ")}${busy ? ` ／ 同時に動いている物: ${busy}` : " ／ 同時に動いている物: 無し"}）`
  );
}
