import type { PlaceholderCard } from "@/features/feed/types";

/** 実作品の比率のばらつきを示す、低彩度で非操作の場所取り。 */
export const PLACEHOLDER_CARDS: PlaceholderCard[] = [
  { id: "placeholder-square-1", width: 1, height: 1 },
  { id: "placeholder-portrait-1", width: 3, height: 4 },
  { id: "placeholder-landscape-1", width: 4, height: 3 },
  { id: "placeholder-four-five-1", width: 4, height: 5 },
  { id: "placeholder-portrait-2", width: 2, height: 3 },
  { id: "placeholder-square-2", width: 1, height: 1 },
  { id: "placeholder-landscape-2", width: 16, height: 10 },
  { id: "placeholder-four-five-2", width: 4, height: 5 },
];
