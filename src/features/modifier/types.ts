/**
 * サブ指令（D193）。
 *
 * 【これは何か】
 *   お題に出た正式な語1つについて、「それをどう表現するか」の
 *   取っかかりを1つだけ添えるもの。
 *
 *     正式なお題: 怯え     → サブ指令: 強がって隠している
 *     正式なお題: 深緑     → サブ指令: 黄を差し色にする
 *
 *   形状アシスト（D191）が「お題ぜんぶをどういう形として描くか」なのに対し、
 *   こちらは**正式な語1つずつ**に付く。役割が違うので別のものとして扱う。
 *   出所: ユーザー指示（2026-09-10）「内部共通化は可能なら検討してよいが、
 *   UI上や意味上まで1つに潰さない。」
 *
 * 【正式なお題ではない】
 *   出所: ユーザー指示（2026-09-10）「正式語数に含めない ／ quizに出さない ／
 *   誤答候補にしない ／ 正解判定に使わない ／ ビタ当てに使わない ／
 *   2択当てに使わない ／ D169に使わない ／ rankingに使わない ／
 *   伝達指標に使わない ／ noveltyに使わない ／ 回答者には見せない ／
 *   作者は無視して投稿できる」。
 *
 *   守り方は画面ではない。**置き場所そのものを分けてある。**
 *   保存先は枠の行（draft_session_slots）と、確定したお題のカード
 *   （prompt_cards）の列1つずつだけ。クイズを作る関数が読むのは
 *   prompt_cards の tag_id と card_slots だけなので、この列は届かない。
 *
 * 【なぜ語彙の表に入れないか】
 *   出所: ユーザー指示（2026-09-10）「modifierをtagsへ入れない。
 *   正式語彙と完全に隔離する。」
 *
 *   tags に入れると、クイズの誤答としてこの語が出る。出題の抽選は
 *   「同じ pool_key の有効なタグ」から誤答を選ぶので、
 *   同じ場所に置いた時点で混ざる道ができる。
 *
 * 【一覧をここに置いてある理由】
 *   出所: ユーザー指示（2026-09-10）「TypeScript側：modifier key /
 *   表示文 / 対応formal tag / 必要ならweight。DB側：実際に選ばれた
 *   modifier keyだけ。」
 *
 *   DB が知る必要があるのは「どれが選ばれたか」だけで、
 *   選べるものの一覧も、どの語にどれが付くかも知らなくてよい。
 *   表を1つも増やさずに済む形として、ここに置いてある。
 *
 * 【網羅していない】
 *   現行の抽選に出る語は333語あるが、下の表が扱うのは24語だけ。
 *   出所: ユーザー指示（2026-09-10）「初期版では333語全部を対象にしない。
 *   morph 8 / emotion 6 / property 4 / color 6、合計24語。
 *   1 formal tagにつき原則3 modifier候補。」
 *
 *   候補の無い語では何も付かない。**数合わせで無理に付けない。**
 *   出所: ユーザー指示（2026-09-10）「意味の薄い汎用modifierを
 *   数合わせで付けない。」
 *
 * 【鍵は変えない。表示文は変えてよい】
 *   保存されるのは鍵だけなので、表示文を直しても、
 *   既に確定したお題のサブ指令はそのまま生き続ける。
 *   逆に鍵を変えると、確定済みのお題から表示文が引けなくなる。
 */

/** 保存される値の形。DB 側の check も同じ */
export const SUB_DIRECTIVE_KEY_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

export type SubDirective = {
  /** 保存される値。表示文は保存しない */
  key: string;
  /** 画面に出る文。ここを直しても、保存済みの値は変わらない */
  label: string;
  /**
   * この指令が付けられる正式な語。**タグの id ではなく表示名**で持つ。
   * id は環境ごとに変わりうるが、表示名は語そのものなので、
   * 手元と本番で同じ表を使える。
   */
  forTagLabels: string[];
  /**
   * 抽選の重み。大きいほど出やすい。
   * 出所: ユーザー指示（2026-09-10）「必要ならweight」。
   */
  weight: number;
};

/**
 * サブ指令の一覧。24語 × 3候補 = 72件。
 *
 * 【並び】
 *   モーフ8語 → 感情6語 → 性質4語 → カラー6語。
 *   正式タグ名は本番の tags 表に実在し、現行モードの抽選に出るものだけ。
 *   旧方式でしか使われない motif / species / genre は1語も入れていない。
 *   出所: ユーザー指示（2026-09-10）「必ず現在DBに存在し、
 *   現行モードの抽選対象になっているtagから選ぶ。」
 *
 * 【1語の3候補は、別々の方向へ枝分かれさせてある】
 *   同じことの言い換えを3つ並べない。視点・構造・時間・対比のように、
 *   描く手が実際に変わる軸で分けてある。
 *   出所: ユーザー指示（2026-09-10）「同じことを言い換えただけの
 *   3候補は禁止。」
 *
 * 【カラーは置き方の指示だけ】
 *   色相・補色・RGB・明度・彩度の計算は1つも使っていない。
 *   差し色・面積差・局所配置・縁取り・背景対比の言葉だけで書いてある。
 *   出所: ユーザー指示（2026-09-10）「色相計算 / 補色計算 / RGB/HSL /
 *   明度数値 / 彩度数値 などは実装しない。」
 *
 * 【重みは全部1】
 *   出所: ユーザー指示（2026-09-10）「候補3つは初期版では等確率。」
 */
export const SUB_DIRECTIVES: SubDirective[] = [
  // ── モーフ 8語 ──
  // 灯台
  { key: "lighthouse_beam_wide", label: "光を横へ大きく伸ばす", forTagLabels: ["灯台"], weight: 1 },
  { key: "lighthouse_reflect", label: "水面に光を反射させる", forTagLabels: ["灯台"], weight: 1 },
  { key: "lighthouse_unlit", label: "灯が消えたまま", forTagLabels: ["灯台"], weight: 1 },
  // 螺旋階段
  { key: "spiral_from_above", label: "真上から見下ろす", forTagLabels: ["螺旋階段"], weight: 1 },
  { key: "spiral_no_core", label: "中心の柱がない", forTagLabels: ["螺旋階段"], weight: 1 },
  { key: "spiral_broken", label: "途中で途切れている", forTagLabels: ["螺旋階段"], weight: 1 },
  // 時計塔
  { key: "tower_no_hands", label: "文字盤の針が無い", forTagLabels: ["時計塔"], weight: 1 },
  { key: "tower_stands_tall", label: "塔を周囲より高く見せる", forTagLabels: ["時計塔"], weight: 1 },
  { key: "tower_gears_shown", label: "内側の歯車が見えている", forTagLabels: ["時計塔"], weight: 1 },
  // 傘
  { key: "umbrella_inverted", label: "骨が折れて裏返っている", forTagLabels: ["傘"], weight: 1 },
  { key: "umbrella_leaning", label: "閉じたまま立てかけてある", forTagLabels: ["傘"], weight: 1 },
  { key: "umbrella_translucent", label: "透けて向こうが見える", forTagLabels: ["傘"], weight: 1 },
  // 鳥籠
  { key: "cage_door_open", label: "扉が開いている", forTagLabels: ["鳥籠"], weight: 1 },
  { key: "cage_through_bars", label: "中身を格子越しに強調する", forTagLabels: ["鳥籠"], weight: 1 },
  { key: "cage_warped_bars", label: "格子を不揃いに歪ませる", forTagLabels: ["鳥籠"], weight: 1 },
  // 蒸気機関車
  { key: "loco_smoke_trail", label: "煙が進行方向へ流れる", forTagLabels: ["蒸気機関車"], weight: 1 },
  { key: "loco_head_on", label: "正面から迫って見る", forTagLabels: ["蒸気機関車"], weight: 1 },
  { key: "loco_heavy_stop", label: "停止した重さを強調する", forTagLabels: ["蒸気機関車"], weight: 1 },
  // 花束
  { key: "bouquet_unwrapped", label: "包装を解いた直後", forTagLabels: ["花束"], weight: 1 },
  { key: "bouquet_one_astray", label: "一輪だけ向きが違う", forTagLabels: ["花束"], weight: 1 },
  { key: "bouquet_hung_down", label: "逆さに吊るしてある", forTagLabels: ["花束"], weight: 1 },
  // 仮面
  { key: "mask_in_hand", label: "外して手に持っている", forTagLabels: ["仮面"], weight: 1 },
  { key: "mask_half_worn", label: "顔に半分だけ掛かる", forTagLabels: ["仮面"], weight: 1 },
  { key: "mask_inside_out", label: "内側を向けて置かれる", forTagLabels: ["仮面"], weight: 1 },

  // ── 状態：感情 6語 ──
  // 恐怖
  { key: "fear_bluffing", label: "強がって隠す", forTagLabels: ["恐怖"], weight: 1 },
  { key: "fear_frozen", label: "身体がすくんでいる", forTagLabels: ["恐怖"], weight: 1 },
  { key: "fear_behind", label: "背後を気にしている", forTagLabels: ["恐怖"], weight: 1 },
  // 羞恥
  { key: "shame_hands_short", label: "顔を隠しきれていない", forTagLabels: ["羞恥"], weight: 1 },
  { key: "shame_alone", label: "誰にも見られていない", forTagLabels: ["羞恥"], weight: 1 },
  { key: "shame_unmoved", label: "相手のほうが動じない", forTagLabels: ["羞恥"], weight: 1 },
  // 嫉妬
  { key: "envy_eyes_aside", label: "視線だけが別を向く", forTagLabels: ["嫉妬"], weight: 1 },
  { key: "envy_stiff_hands", label: "笑顔のまま手が固い", forTagLabels: ["嫉妬"], weight: 1 },
  { key: "envy_unnoticed", label: "相手には気づかれない", forTagLabels: ["嫉妬"], weight: 1 },
  // 孤独
  { key: "alone_in_crowd", label: "周りに人が大勢いる", forTagLabels: ["孤独"], weight: 1 },
  { key: "alone_too_wide", label: "空間のほうが広すぎる", forTagLabels: ["孤独"], weight: 1 },
  { key: "alone_just_left", label: "誰かが去った直後", forTagLabels: ["孤独"], weight: 1 },
  // 歓喜
  { key: "joy_held_in", label: "声を出さずに堪える", forTagLabels: ["歓喜"], weight: 1 },
  { key: "joy_off_ground", label: "身体が地から離れる", forTagLabels: ["歓喜"], weight: 1 },
  { key: "joy_only_one", label: "一人だけ喜んでいる", forTagLabels: ["歓喜"], weight: 1 },
  // 諦念
  { key: "giveup_still_holds", label: "手をまだ離していない", forTagLabels: ["諦念"], weight: 1 },
  { key: "giveup_blank_face", label: "表情が抜け落ちている", forTagLabels: ["諦念"], weight: 1 },
  { key: "giveup_walks_away", label: "背を向けて歩き出す", forTagLabels: ["諦念"], weight: 1 },

  // ── 状態：性質 4語 ──
  // 透明
  { key: "clear_distorted", label: "向こう側が歪んで見える", forTagLabels: ["透明"], weight: 1 },
  { key: "clear_rim_light", label: "縁だけが光を返す", forTagLabels: ["透明"], weight: 1 },
  { key: "clear_smudged", label: "汚れで一部だけ濁る", forTagLabels: ["透明"], weight: 1 },
  // 重い
  { key: "heavy_sinks", label: "支える側が沈んでいる", forTagLabels: ["重い"], weight: 1 },
  { key: "heavy_not_lifted", label: "持ち上がりきらない", forTagLabels: ["重い"], weight: 1 },
  { key: "heavy_leaves_mark", label: "置かれた跡が残る", forTagLabels: ["重い"], weight: 1 },
  // 脆い
  { key: "brittle_chipped", label: "すでに一部が欠けている", forTagLabels: ["脆い"], weight: 1 },
  { key: "brittle_hand_hovers", label: "触れる手が浮いている", forTagLabels: ["脆い"], weight: 1 },
  { key: "brittle_mended", label: "継ぎ目が直してある", forTagLabels: ["脆い"], weight: 1 },
  // 粘着
  { key: "sticky_threads", label: "引き剥がした糸が伸びる", forTagLabels: ["粘着"], weight: 1 },
  { key: "sticky_wont_part", label: "触れたものが離れない", forTagLabels: ["粘着"], weight: 1 },
  { key: "sticky_dusty", label: "埃を巻き込んでいる", forTagLabels: ["粘着"], weight: 1 },

  // ── カラー 6語 ──
  // 赤
  { key: "red_single_point", label: "画面の一点だけに置く", forTagLabels: ["赤"], weight: 1 },
  { key: "red_half_area", label: "面積を半分以上にする", forTagLabels: ["赤"], weight: 1 },
  { key: "red_outline_only", label: "縁取りにだけ使う", forTagLabels: ["赤"], weight: 1 },
  // 白
  { key: "white_beside_dark", label: "暗い面と隣り合わせる", forTagLabels: ["白"], weight: 1 },
  { key: "white_left_unpainted", label: "塗り残しとして扱う", forTagLabels: ["白"], weight: 1 },
  { key: "white_in_shadow", label: "影のほうに色を置く", forTagLabels: ["白"], weight: 1 },
  // 黒
  { key: "black_no_outline", label: "輪郭線として使わない", forTagLabels: ["黒"], weight: 1 },
  { key: "black_large_fill", label: "大きな面で塗り潰す", forTagLabels: ["黒"], weight: 1 },
  { key: "black_gaps_only", label: "隙間だけを黒くする", forTagLabels: ["黒"], weight: 1 },
  // 金
  { key: "gold_trim_only", label: "一部の飾りだけに使う", forTagLabels: ["金"], weight: 1 },
  { key: "gold_split_shine", label: "反射の強い所を分ける", forTagLabels: ["金"], weight: 1 },
  { key: "gold_tarnished", label: "古びてくすませる", forTagLabels: ["金"], weight: 1 },
  // 水色
  { key: "aqua_as_shadow", label: "影の色として使う", forTagLabels: ["水色"], weight: 1 },
  { key: "aqua_far_stronger", label: "遠い所ほど強くする", forTagLabels: ["水色"], weight: 1 },
  { key: "aqua_one_deep_spot", label: "一箇所だけ濃く残す", forTagLabels: ["水色"], weight: 1 },
  // 桃
  { key: "pink_small_accent", label: "差し色として少量置く", forTagLabels: ["桃"], weight: 1 },
  { key: "pink_broad_area", label: "広い面にまとめて使う", forTagLabels: ["桃"], weight: 1 },
  { key: "pink_not_skin", label: "肌ではない所に使う", forTagLabels: ["桃"], weight: 1 },
];

/**
 * その正式な語に付けられる候補。無ければ空の配列。
 *
 * 語は表示名で引く。大文字小文字や前後の空白は落とす。
 */
export function subDirectivesFor(tagLabel: string | null | undefined): SubDirective[] {
  if (!tagLabel) return [];
  const needle = tagLabel.trim();
  if (needle === "") return [];
  return SUB_DIRECTIVES.filter((d) => d.forTagLabels.some((l) => l.trim() === needle));
}

/** 表示文を引く。知らない値なら null（画面には何も出さない） */
export function subDirectiveLabel(key: string | null | undefined): string | null {
  if (!key) return null;
  return SUB_DIRECTIVES.find((d) => d.key === key)?.label ?? null;
}

/** その値が一覧に載っているか */
export function isSubDirectiveKey(key: string): boolean {
  return SUB_DIRECTIVES.some((d) => d.key === key);
}

/**
 * 付け方の決め方。**2段構え。**
 *
 *   1段目  付けるかどうか（70% で付ける、30% で付けない）
 *   2段目  付けるなら、その語の候補から1つ（初期版は等確率）
 *
 * 出所: ユーザー指示（2026-09-10）「まず70%で『付ける』を引き、
 * 付ける場合は3候補から等確率で1つ。30%ではnull。」
 *
 * 【なぜ「付けない」を候補と一緒に抽選しないか】
 *   一緒にすると、候補が2つの語と4つの語で「付かない率」が変わってしまう。
 *   2段に分けると、候補が何個でも付かない率は 30% のまま動かない。
 */
export type SubDirectivePolicy = {
  /** 付ける確率。0 で必ず付けない、1 で必ず付ける */
  attachRate: number;
};

/**
 * いまの付け方。
 * 出所: ユーザー指示（2026-09-10）「対応候補あり → 70%：1候補付与 → 30%：null」。
 */
export const SUB_DIRECTIVE_POLICY: SubDirectivePolicy = { attachRate: 0.7 };

/**
 * その語に付けるサブ指令を1つ決める。付けないときは null。
 *
 * 候補が無ければ、1段目を引くまでもなく null（数合わせで無理に付けない）。
 * 出所: ユーザー指示（2026-09-10）「候補なしの場合はmodifierなし。」
 *
 * 【乱数を外から渡せる理由】
 *   何千回も引いて「だいたい70%だった」で合否を決めない、という指示のため。
 *   決まった値を渡せば、どの枝を通るかが1回で確かめられる。
 *   出所: ユーザー指示（2026-09-10）「大量乱数試験で70%前後になることを
 *   E2Eの合否条件にしない。固定乱数入力等で決定論的に試験する。」
 *
 *   1回目の呼び出しが1段目（付けるか）、2回目が2段目（どれを付けるか）。
 */
export function pickSubDirective(
  tagLabel: string | null | undefined,
  policy: SubDirectivePolicy = SUB_DIRECTIVE_POLICY,
  random: () => number = Math.random,
): string | null {
  const candidates = subDirectivesFor(tagLabel);
  if (candidates.length === 0) return null;

  // 1段目。0 以上 attachRate 未満なら付ける
  if (random() >= policy.attachRate) return null;

  // 2段目。重みに従って1つ選ぶ（初期版はすべて重み1なので等確率）
  const total = candidates.reduce((sum, d) => sum + Math.max(0, d.weight), 0);
  if (total <= 0) return null;

  let point = random() * total;
  for (const d of candidates) {
    point -= Math.max(0, d.weight);
    if (point < 0) return d.key;
  }
  return candidates[candidates.length - 1].key;
}
