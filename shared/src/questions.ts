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

export const QUESTION_IDS = [...ASPECT_IDS, ...STYLE_IDS, IS_ACK_ID] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** どの質問にも届かなかったときの「その他」。 */
export const OTHER_LABEL = "other" as const;
export type OtherLabel = typeof OTHER_LABEL;
