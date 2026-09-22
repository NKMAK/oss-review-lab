/** 観点(aspect)。「その他」は質問を持たず、deriveLabels がコードで導く。 */
export const ASPECT_IDS = [
  "design-api",
  "types",
  "bug-edge-case",
  "compatibility-release",
  "tests",
  "readability-naming",
  "docs-comments",
  "security",
  "performance",
  "deps-build-tooling",
] as const;
export type AspectId = (typeof ASPECT_IDS)[number];

/** 言い方(style)。「その他」は質問を持たず、deriveLabels がコードで導く。 */
export const STYLE_IDS = [
  "suggests-fix",
  "explains-reason",
  "question",
  "shares-context",
  "feature-request",
] as const;
export type StyleId = (typeof STYLE_IDS)[number];

/** 返信の判定(同意・完了報告だけか)。 */
export const IS_ACK_ID = "is_ack" as const;
export type IsAckId = typeof IS_ACK_ID;

/**
 * 理解のしやすさ(understandability)。観点・言い方とは独立した第3のグループ(1コメントにつき常に1つだけ判定)。
 * 将来、軸を増やせるよう配列にしている(今は self-contained の1個だけ)。「その他」は持たない。
 *
 * 注意(確率の向き): self-contained の質問文(jev/questions/understandability/self-contained.json)は、
 * 「true = このOSSの内部知識が要る」という向きで書かれている(そのほうが自然な言い回しになるため)。
 * Web側で「知識が無くてもわかるか」として使うときは、常に `1 - probability` に反転してから使う
 * (shared/src/derive.ts の selfContainedProbability を使う。質問定義そのものは反転しない)。
 */
export const UNDERSTANDABILITY_IDS = ["self-contained"] as const;
export type UnderstandabilityId = (typeof UNDERSTANDABILITY_IDS)[number];

export const QUESTION_IDS = [...ASPECT_IDS, ...STYLE_IDS, ...UNDERSTANDABILITY_IDS, IS_ACK_ID] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** どの質問にも届かなかったときの「その他」。 */
export const OTHER_LABEL = "other" as const;
export type OtherLabel = typeof OTHER_LABEL;
