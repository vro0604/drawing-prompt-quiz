/**
 * _lock-probe.mjs ／ 重い検査の札を取って、少し持ってから返すだけの小さな道具
 *
 * 自己試験（record-selftest.mjs）から2つ同時に起動して、
 * **2つが同時に札を持てないこと**を確かめるために使う。
 * 取った時刻と返した時刻を1行ずつ出す。
 */
import { acquireHeavyLock } from "./exclusive.mjs";

const holdMs = Number.parseInt(process.argv[2] ?? "1500", 10);
const label = process.argv[3] ?? "probe";

const release = await acquireHeavyLock(`札の自己試験（${label}）`);
console.log(`ACQUIRED ${label} ${Date.now()}`);
await new Promise((r) => setTimeout(r, holdMs));
console.log(`RELEASED ${label} ${Date.now()}`);
release();
