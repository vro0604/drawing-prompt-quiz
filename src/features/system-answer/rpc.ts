import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type {
  SystemAnswerJob,
  SystemAnswerSelection,
} from "@/features/system-answer/types";

/**
 * システム回答（D195）を積む・取り出す・保存する、ただ1組の経路。サーバー専用。
 *
 * 【なぜ普通の呼び出しではないのか】
 *   ふだんの DB 呼び出しは、その人のサインインの証明書を持って行う。
 *   ところがその証明書はブラウザから読み取れる（部品の既定が httpOnly: false）。
 *   だから「システムの回答を作る」窓口を利用者の役へ配ると、画面を通さず
 *   直接叩いて、仕組みが答えたことにできてしまう。
 *   出所: ユーザー指示（2026-09-10）「anonから呼べない / authenticatedから
 *   呼べない / trusted server/service-roleのみ」。
 *
 *   ここではサーバーだけが持つ秘密の鍵で呼ぶ。**その鍵はブラウザへ渡らない。**
 *
 * 【秘密の鍵は守りを素通りする】
 *   だから相手の DB 関数の側で、作品・公開状態・表示の状態・お題の出どころ・
 *   問・選択肢・重複・数を全部見直している。1つでも食い違えば1行も書かれない。
 *
 * 【この段では、まだ誰もここを呼ばない】
 *   作品の投稿処理からは呼んでいない。将来の工程がここを使う。
 *   出所: ユーザー指示（2026-09-10）「Phase 2ではcreate_workから自動で呼ばない。」
 */

/** 秘密の鍵が無い環境。何もしなかったことを残すだけで、投げない */
function noAdmin(where: string): void {
  console.warn(`[system-answer] サーバーの鍵が無いので ${where} を行いませんでした`);
}

/**
 * この作品について、システム回答を作る仕事を1件積む。
 *
 * 積めたら true。積まなかったときは false。
 * 積まない理由は異常ではない（消された／公開されていない／表示を止められた／
 * art_first ／もう回答がある／すでに積んである）。
 *
 * **投げない。**呼ぶ側は作品の投稿を終えた後になる見込みで、
 * ここで投げると投稿が成立したのに画面が失敗表示になる。
 */
export async function enqueueSystemAnswer(workId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("待ち行列へ積むこと"); return false; }

  const { data, error } = await admin.rpc("enqueue_system_answer", {
    p_work_id: workId,
  });

  if (error) {
    // 握り潰さない。原因を追えるように残す
    console.error("[system-answer] 待ち行列へ積めませんでした", {
      workId,
      message: error.message,
    });
    return false;
  }

  return data === true;
}

/**
 * 待っている仕事を取り出して、処理中にする。
 *
 * 押さえた行は他の働き手からは見えないので、同じ仕事を2人が取ることはない。
 * 取り出せなければ空の配列。
 */
export async function claimSystemAnswerJobs(
  limit = 1,
): Promise<{ id: number; work_id: string; owner_user_id: string | null; attempts: number }[]> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("仕事の取り出し"); return []; }

  const { data, error } = await admin.rpc("claim_system_answer_jobs", {
    p_limit: limit,
  });

  if (error) {
    console.error("[system-answer] 仕事を取り出せませんでした", {
      message: error.message,
    });
    return [];
  }

  return (data ?? []) as {
    id: number;
    work_id: string;
    owner_user_id: string | null;
    attempts: number;
  }[];
}

/**
 * システム回答を1件だけ保存する。
 *
 * 渡すのは「どの問に、どの語を選んだか」だけ。
 * **合っているかどうかは渡さない。**DB の側が決める。
 *
 * 保存できたら true。保存しなかったときは false
 * （人間が先に答えていた／作品が対象外になった／すでにシステム回答がある）。
 * 形が壊れているときだけ DB が例外を返し、ここでは false になる。
 */
export async function saveSystemAnswer(
  workId: string,
  selections: SystemAnswerSelection[],
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("システム回答の保存"); return false; }

  const { data, error } = await admin.rpc("save_system_answer", {
    p_work_id: workId,
    p_selections: selections,
  });

  if (error) {
    console.error("[system-answer] システム回答を保存できませんでした", {
      workId,
      message: error.message,
    });
    return false;
  }

  return data === true;
}

/** 失敗の印を付ける。戻せばもう一度試せる */
export async function markSystemAnswerFailed(
  workId: string,
  reason: string,
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("失敗の印"); return false; }

  const { data, error } = await admin.rpc("mark_system_answer_failed", {
    p_work_id: workId,
    p_error: reason,
  });

  if (error) {
    console.error("[system-answer] 失敗の印を付けられませんでした", {
      workId,
      message: error.message,
    });
    return false;
  }

  return data === true;
}

/** 作る必要が無くなった仕事を終わらせる */
export async function cancelSystemAnswerJob(
  workId: string,
  reason: string | null = null,
): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("仕事の取り消し"); return false; }

  const { data, error } = await admin.rpc("cancel_system_answer_job", {
    p_work_id: workId,
    p_reason: reason,
  });

  if (error) {
    console.error("[system-answer] 仕事を取り消せませんでした", {
      workId,
      message: error.message,
    });
    return false;
  }

  return data === true;
}

/**
 * 失敗した仕事を、待っている状態へ戻す。
 *
 * **自動では戻さない。**何度でも勝手に試し続ける形にしないため、
 * 戻すのは呼んだときだけ。上限の回数はまだ決めていない。
 * 出所: ユーザー指示（2026-09-10）「最終retry回数はまだ決めない。
 * 自動無限retryは作らない。」
 */
export async function retrySystemAnswerJob(workId: string): Promise<boolean> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("再試行の準備"); return false; }

  const { data, error } = await admin.rpc("retry_system_answer_job", {
    p_work_id: workId,
  });

  if (error) {
    console.error("[system-answer] 再び試せる状態へ戻せませんでした", {
      workId,
      message: error.message,
    });
    return false;
  }

  return data === true;
}

/** 待ち行列の様子を1件読む。無ければ null */
export async function getSystemAnswerJob(
  workId: string,
): Promise<SystemAnswerJob | null> {
  const admin = createSupabaseAdminClient();
  if (admin === null) { noAdmin("待ち行列の読み取り"); return null; }

  const { data, error } = await admin.rpc("get_system_answer_job", {
    p_work_id: workId,
  });

  if (error) {
    console.error("[system-answer] 待ち行列を読めませんでした", {
      workId,
      message: error.message,
    });
    return null;
  }

  const rows = (data ?? []) as SystemAnswerJob[];
  return rows[0] ?? null;
}
