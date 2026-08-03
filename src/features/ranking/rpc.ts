import { createSupabaseServerClient } from "@/lib/supabase/server";
import { readableRpcError } from "@/features/draft/rpc";
import type {
  RankingFeed,
  RankingItem,
  RankingType,
  TimeBucket,
} from "@/features/ranking/types";

/**
 * ランキングの取得。サーバー専用。
 *
 * works にも likes にも直接は触れない（テーブル権限が無い）。
 * 順位付けは**すべて DB 側**で行い、ここでは引数を渡すだけ。
 *
 * 画面で並べ替えないのは、上位20件を取ってから並べ替えても
 * 「全体の上位」にならないため。絞り込みも順位付けも件数を
 * 数える前に済んでいる必要がある（/works の一覧と同じ理由）。
 */
export async function fetchRankings(params: {
  type: RankingType;
  feed: RankingFeed;
  timeBucket: TimeBucket | null;
  limit: number;
  offset: number;
}): Promise<RankingItem[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("get_rankings", {
    p_type: params.type,
    p_feed: params.feed,
    p_time_limit: params.timeBucket,
    p_limit: params.limit,
    p_offset: params.offset,
  });

  if (error) throw new Error(readableRpcError(error.message));
  return (data ?? []) as RankingItem[];
}
