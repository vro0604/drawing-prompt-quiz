/**
 * DB の行の型。
 *
 * Step 3 でテーブルが出そろったら Supabase CLI の型生成
 * （supabase gen types typescript）に置き換える予定。
 * それまでは、使うぶんだけ手で書く。
 */

/** public.profiles の1行（supabase/migrations/001_profiles.sql） */
export type Profile = {
  id: string;
  handle: string | null;
  display_name: string;
  bio: string | null;
  links: Record<string, string>;
  is_anonymous: boolean;
  show_answer_stats: boolean;
  show_answer_history: boolean;
  show_saved_works: boolean;
  /** 描き手としての成績を他人に見せるか。既定 false（D136） */
  show_creator_stats: boolean;
  created_at: string;
};
