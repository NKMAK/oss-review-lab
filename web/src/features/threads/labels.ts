import type { ExcludedReason } from "@oss-review-lab/shared";
import type { ExcludedReplyReason } from "./view";

/** 質問ID(観点・言い方・is_ack・other)の表示名。 */
export const LABEL_NAMES: Record<string, string> = {
  "design-api": "設計・API",
  types: "型",
  "bug-edge-case": "バグ・境界条件",
  "compatibility-release": "互換性・リリース",
  tests: "テスト",
  "readability-naming": "可読性・命名",
  "docs-comments": "ドキュメント・コメント",
  security: "セキュリティ",
  performance: "パフォーマンス",
  "deps-build-tooling": "依存・ビルド",
  "suggests-fix": "修正案を示す",
  "explains-reason": "理由を説明",
  question: "質問",
  "shares-context": "文脈の共有",
  "feature-request": "機能要望",
  is_ack: "同意・完了報告",
  other: "その他",
};

export function labelName(id: string): string {
  return LABEL_NAMES[id] ?? id;
}

/** 確率(0〜1)を「確率 xx%」にする。noulの結果には「confidence」の語を使わない。 */
export function formatProbability(p: number): string {
  return `確率 ${Math.round(p * 100)}%`;
}

export const THREAD_EXCLUDED_LABELS: Record<ExcludedReason, string> = {
  "bot-root": "除外: botが親コメント",
  "unknown-root": "除外: 削除済みユーザーが親コメント",
  "parent-missing": "除外: 親コメントが取得範囲外",
};

export const REPLY_EXCLUDED_LABELS: Record<ExcludedReplyReason, string> = {
  ack: "除外: 同意・完了報告",
  bot: "除外: bot",
  unknown: "除外: 削除済みユーザー",
};

export const ROLE_LABELS = [
  ["all", "全員"],
  ["pr-author", "PR作者"],
  ["reviewer", "第三者(PR作者以外)"],
] as const;

export function authorName(author: string | null): string {
  return author ?? "(削除済みユーザー)";
}
