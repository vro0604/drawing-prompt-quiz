/**
 * 持ち込み（art_first）で使う型。
 *
 * 【この経路が何か】
 *   既に描いてある絵を持ち込み、**作者が「この絵で何が伝わるか」を
 *   現行の語彙から選ぶ。**選んだ語がそのままクイズの正解になる。
 *   お題を引いて描く経路とは入口が逆で、投稿より後ろは同じ仕組みを通る。
 *
 * 【語の型そのものは features/vocab に移した（2026-09-08）】
 *   プロフィールの「描くのが得意」「見るのが得意」でも同じ語彙から選ぶので、
 *   持ち込み専用の場所に置いておけなくなった。ここでは名前をそのまま
 *   出し直すだけにして、これまでの取り込み文を壊さない。
 */

export {
  EMPTY_VOCABULARY,
  kindLabel,
  type VocabCategory,
  type VocabKind,
  type VocabTag,
} from "@/features/vocab/types";

import type { Vocabulary } from "@/features/vocab/types";

/** get_art_first_vocabulary の戻り値（持ち込みの投稿フォームが読む形） */
export type ArtFirstVocabulary = Vocabulary;
