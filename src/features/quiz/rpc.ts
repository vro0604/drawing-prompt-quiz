import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type { AnswerSelection, MyAnswer, WorkQuiz } from "@/features/quiz/types";
import type { WorkImportState } from "@/features/quiz/capacity";
import type {
  AnswerFilter,
  Drilldown,
  MyAnswerAnalysis,
  WorkAnswerAnalysis,
  WorkAnswerList,
} from "@/features/quiz/results";

/**
 * クイズ関連の DB 呼び出し。サーバー専用。
 *
 * 【正解がどこから出るか】
 *   quiz_choices.is_correct を読める経路は submit_answer だけ。
 *   その結果を返すのは get_my_answer だけ。
 *   出題（get_work_quiz）は is_correct に一切触れない。
 *
 *   だからこのファイルには「採点する関数」が無い。
 *   採点は DB の中だけで終わり、ここは呼ぶだけ。
 */

/**
 * 作品1件ぶんの出題。誰でも（未サインインでも）呼べる。
 *
 * 公開条件を満たさない作品には null が返る。
 * 返り値に正解は含まれない。ページのソースを見ても答えは出てこない。
 */
export async function fetchWorkQuiz(workId: string): Promise<WorkQuiz | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_quiz", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkQuiz | null) ?? null;
}

/**
 * 自分の回答1件。未回答なら null。
 *
 * **正解タグが外へ出る唯一の経路。** 自分が回答済みの作品にしか返らないので、
 * 「正解を見るには先に答える」という前提がここで守られる。
 *
 * この RPC は authenticated だけが呼べる。未サインイン（anon）が呼ぶと
 * permission denied になるため、呼ぶ前にサインイン済みか確かめること。
 */
export async function fetchMyAnswer(workId: string): Promise<MyAnswer | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_answer", { p_work_id: workId });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as MyAnswer | null) ?? null;
}

/**
 * 回答を送って採点してもらう。
 *
 * 採点・保存・集計はすべて DB 側（submit_answer とトリガー）。
 * ここでやるのは選択の一覧を渡すことだけで、正しさの判定はしない。
 *
 * 戻り値は get_my_answer と同じ形なので、送信直後の表示と
 * あとから開き直したときの表示を同じ部品で描ける。
 */
export async function callSubmitAnswer(
  workId: string,
  selections: AnswerSelection[],
): Promise<MyAnswer> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("submit_answer", {
    p_work_id: workId,
    p_selections: selections,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as MyAnswer;
}

/**
 * 作者が見る集計。作者以外・未サインインには null が返る。
 *
 * **正解を含む。**呼べるのは DB 側で作者だけに絞ってあるので、
 * ここで持ち主を確かめ直していない（確かめる場所を2つにしない）。
 */
export async function fetchWorkAnswerAnalysis(
  workId: string,
): Promise<WorkAnswerAnalysis | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_answer_analysis", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkAnswerAnalysis | null) ?? null;
}

/**
 * 答え終わった本人が見る集計。まだ答えていない人には null が返る。
 *
 * 未サインイン（anon）が呼ぶと権限エラーになるので、
 * 回答済みだと分かってから呼ぶこと。
 */
export async function fetchMyAnswerAnalysis(
  workId: string,
): Promise<MyAnswerAnalysis | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_my_answer_analysis", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as MyAnswerAnalysis | null) ?? null;
}

/**
 * 条件で絞った集団の語の分布（作者だけ）。
 *
 * 絞り込みは「問のIDと語のIDの組」だけを渡す。SQL の断片は渡さない。
 * 集団が少人数のときは、DB 側が人数も内訳も返さない。
 */
export async function fetchWorkDrilldown(
  workId: string,
  pattern: string | null,
  filters: AnswerFilter[],
): Promise<Drilldown | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_drilldown", {
    p_work_id: workId,
    p_pattern: pattern,
    p_filters: filters,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as Drilldown | null) ?? null;
}

/** 作者向けの回答一覧。誰が答えたかは入っていない */
export async function fetchWorkAnswerList(
  workId: string,
): Promise<WorkAnswerList | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_answer_list", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkAnswerList | null) ?? null;
}

/** 回答を作者の分析から外す／戻す。回答そのものは消えない */
export async function callSetAnswerExcluded(
  workId: string,
  answerNos: number[],
  excluded: boolean,
): Promise<{ changed: number; excluded_count: number; analysed_count: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_answer_excluded", {
    p_work_id: workId,
    p_answer_nos: answerNos,
    p_excluded: excluded,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { changed: number; excluded_count: number; analysed_count: number };
}

/**
 * 作者が見る取り込み枠の状態と履歴。作者以外・未サインインには null。
 *
 * 削除した作品でも下書きでも返る（買った枠と取り込んだ記録は残るため）。
 */
export async function fetchWorkImportState(
  workId: string,
): Promise<WorkImportState | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_work_import_state", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data as WorkImportState | null) ?? null;
}

/**
 * 残り枠を使って、古い回答から順に取り込む。
 *
 * **購入ではない。**既に持っている枠を使うだけ。作品の持ち主だけが呼べる
 * （断るのは DB 側）。
 */
export async function callImportAnswers(
  workId: string,
): Promise<{ imported_now: number; imported: number; remaining: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("import_answers", {
    p_work_id: workId,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { imported_now: number; imported: number; remaining: number };
}

/**
 * 自動の取り込みを入れる／切る。
 *
 * 入れた瞬間に、溜まっている未取り込みの回答を古い順に取り込む。
 * そこで枠が尽きれば、そのまま切れる。
 */
export async function callSetAutoImport(
  workId: string,
  on: boolean,
): Promise<{ auto_import: boolean; imported_now: number; remaining: number }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("set_auto_import", {
    p_work_id: workId,
    p_on: on,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return data as { auto_import: boolean; imported_now: number; remaining: number };
}
