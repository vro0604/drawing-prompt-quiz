#!/usr/bin/env node
/**
 * smoke-fixtures.mjs ／ 検査用の利用者を片づける（本番の入口から）
 *
 * 【なぜ要るか】
 *   検査用の利用者を消す道具は `scripts/_smoke-users.mjs --purge` にあるが、
 *   これは**本番へは届かない。**接続先と秘密鍵を読むのは
 *   `scripts/run-production-smoke.mjs` から起動されたときだけで、
 *   `npm run smoke:fixtures:purge` はその入口を通っていない。
 *   2026-09-10 に、切り替えのあとの片づけをしようとして気づいた。
 *
 *   入口を増やさずに済ませるため、片づけもスモークの1つとして置く。
 *   **本番へ向かう道は run-production-smoke.mjs のままで、増えていない。**
 *
 * 【何を消すか】
 *   検査用の利用者だけ。見分けかたは scripts/_test-accounts.mjs の1か所
 *   （dpq-fixture-…@dpq-smoke.invalid ／ dpq-smoke-…-数字-数字@example.com ／
 *   dpq-probe-数字@example.com）。この形に当たらない人には触れない。
 *   利用者を消すと、その人のプロフィール・ドラフト・集計も一緒に消える。
 *   同意の記録は**残るが、誰のものか分からなくなる**
 *   （terms_agreements.user_id は ON DELETE SET NULL）。
 *   これは規約11条・ポリシー5条に書いてある扱いそのもの。
 *
 * 【何を消さないか】
 *   本物の利用者。作品・お題・回答は、持ち主が空になるだけで残る
 *   （works.user_id / prompts.created_by / answers.user_id は ON DELETE SET NULL）。
 *   作品を片づけるのは `npm run cleanup:testdata`（別の道具）。
 *   **作品を持つ使い捨て利用者を消すときは、先に作品を片づけること。**
 *   2026-09-11 の dpq-smoke 330人は、作品・お題・回答を ID を固定したトランザクションで
 *   先に消し、そのあとでこの道具で利用者を消した。
 *
 * 【使い方】
 *   npm run smoke:prod -- fixtures                    … 下見（何も消さない）
 *   npm run smoke:prod -- fixtures --apply            … 実行
 *   npm run smoke:prod -- fixtures --apply --expect N … 対象がちょうど N 人のときだけ実行
 *   npm run smoke:prod -- fixtures --why              … 消せないときに理由を見る
 *
 * 【--why について】
 *   これは下見ではない。**1人だけ本当に消しにいって、返ってきた答えを
 *   HTTP の番号ごとそのまま出す。**--apply の側も本文を読むようになったが
 *   （2026-09-10）、こちらは1人だけを狙って、加工せずに見るためのもの。
 *   --apply がすでに全員に対して同じことを試したあとに使うので、
 *   ここで1人増えて消えても新しい害は無い。
 */

import { purgeFixtureUsers, fixtureUserIds } from "./_smoke-users.mjs";
import { targetEnv } from "./_smoke-http.mjs";

const APPLY = process.argv.includes("--apply");
const WHY = process.argv.includes("--why");
/** --expect N。対象が N 人でなければ、1人も消さずに止める */
const EXPECT_AT = process.argv.indexOf("--expect");
const EXPECTED = EXPECT_AT >= 0 ? Number(process.argv[EXPECT_AT + 1]) : null;
if (EXPECTED !== null && !Number.isInteger(EXPECTED)) {
  console.log("  --expect のあとに人数（整数）を書いてください。");
  process.exit(1);
}

/**
 * 消せなかったときに、認証側が何を返しているのかを、そのまま見る。
 * supabase-js は本文を捨ててしまうので、生のまま1回だけ叩く。
 */
if (WHY) {
  const env = targetEnv();
  const ids = await fixtureUserIds();
  if (ids.length === 0) {
    console.log("  対象がいません。");
    process.exit(0);
  }
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${ids[0]}`, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
  });
  console.log(`  試した相手の識別子: ${ids[0]}`);
  console.log(`  1人だけ消してみた結果: ${res.status} ${res.statusText}`);
  console.log(`  本文: ${(await res.text()).slice(0, 500)}`);
  process.exit(0);
}

console.log("");
console.log("[検査用の利用者の片づけ]");
console.log("");

const before = await purgeFixtureUsers({ dryRun: true, expected: EXPECTED });

console.log(`  ぜんぶの利用者        ${before.scanned} 人`);
console.log(`  消す（検査用）        ${before.matched} 人`);
console.log(`  残す                  ${before.kept} 人`);

if (before.byRole && before.byRole.size > 0) {
  console.log("");
  console.log("  内訳（役割ごと）");
  for (const [role, n] of [...before.byRole].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${role.padEnd(24)} ${n} 人`);
  }
}

if (!APPLY) {
  console.log("");
  console.log("  ［下見］何も書き換えていません。");
  console.log("  実行するには: npm run smoke:prod -- fixtures --apply");
  process.exit(0);
}

if (before.matched === 0) {
  console.log("");
  console.log("  消すものはありません。");
  process.exit(0);
}

console.log("");
console.log("  消します…");

const after = await purgeFixtureUsers({ expected: before.matched });

console.log(`  消しました            ${after.removed} 人`);
if (after.removed < after.matched) {
  console.log(`  消せなかった          ${after.matched - after.removed} 人`);
  for (const m of after.failures) console.log(`      ${m}`);
}
console.log(`  消したあとも名簿に残る ${after.remaining} 人`);
console.log("");
console.log("  作品には触れていません（片づけるなら npm run cleanup:testdata）。");
console.log("  同意の記録は残りますが、誰のものかは分からなくなっています。");

// 消えた数が対象と合い、名簿にも1人も残っていないときだけ成功
process.exit(after.ok ? 0 : 1);
