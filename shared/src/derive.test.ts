import { describe, expect, it } from "vitest";
import {
  deriveLabels,
  isAckExcluded,
  isCodeExcludedReply,
  isReviewBand,
  isSelfContained,
  selfContainedProbability,
} from "./derive";
import type { Comment } from "./thread";
import type { Result } from "./run";

const comment = (authorKind: Comment["authorKind"]): Comment => ({
  id: "1",
  role: "reply",
  createdAt: "2026-01-01T00:00:00Z",
  author: authorKind === "unknown" ? null : "someone-dummy",
  authorKind,
  isPrAuthor: null,
  body: "Dummy",
  url: "https://example.test/x",
});

const result = (questionId: string, probability: number | null): Result => ({
  targetId: "1001",
  questionId,
  questionType: "noul",
  questionDefHash: "a".repeat(64),
  stateHash: "b".repeat(64),
  variant: "parent-only",
  raw: null,
  probability,
  confidence: null,
  latencyMs: 1,
  usage: null,
  cost: null,
  error: probability === null ? { kind: "fatal", message: "dummy", attempts: 1 } : null,
});

describe("isCodeExcludedReply", () => {
  it("botの返信は除外する", () => {
    expect(isCodeExcludedReply(comment("bot"))).toBe(true);
  });
  it("unknownの返信は除外する", () => {
    expect(isCodeExcludedReply(comment("unknown"))).toBe(true);
  });
  it("humanの返信は除外しない", () => {
    expect(isCodeExcludedReply(comment("human"))).toBe(false);
  });
});

describe("isAckExcluded", () => {
  it("閾値ちょうどは除外する(以上)", () => {
    expect(isAckExcluded(0.8, 0.8)).toBe(true);
  });
  it("閾値を超えたら除外する", () => {
    expect(isAckExcluded(0.81, 0.8)).toBe(true);
  });
  it("閾値未満は除外しない", () => {
    expect(isAckExcluded(0.79, 0.8)).toBe(false);
  });
});

describe("isReviewBand", () => {
  it("帯の内側(閾値そのもの)", () => {
    expect(isReviewBand(0.5, 0.5, 0.1)).toBe(true);
  });
  it("帯の内側(下側・上側)", () => {
    expect(isReviewBand(0.45, 0.5, 0.1)).toBe(true);
    expect(isReviewBand(0.55, 0.5, 0.1)).toBe(true);
  });
  it("帯の外側", () => {
    expect(isReviewBand(0.39, 0.5, 0.1)).toBe(false);
    expect(isReviewBand(0.61, 0.5, 0.1)).toBe(false);
  });
  it("境界(threshold±width)は帯に含める。浮動小数点誤差があっても含める", () => {
    expect(isReviewBand(0.4, 0.5, 0.1)).toBe(true);
    expect(isReviewBand(0.6, 0.5, 0.1)).toBe(true);
    expect(isReviewBand(0.7, 0.8, 0.1)).toBe(true);
  });
});

describe("deriveLabels", () => {
  it("閾値以上のラベルを、観点と言い方に分けて返す(定義順)", () => {
    const results = [
      result("tests", 0.7),
      result("design-api", 0.9),
      result("bug-edge-case", 0.1),
      result("explains-reason", 0.6),
      result("question", 0.2),
    ];
    expect(deriveLabels(results, 0.5)).toEqual({
      aspects: ["design-api", "tests"],
      styles: ["explains-reason"],
    });
  });
  it("どれも届かなければ「その他」(観点・言い方それぞれ)", () => {
    const results = [result("design-api", 0.4), result("question", 0.3)];
    expect(deriveLabels(results, 0.5)).toEqual({ aspects: ["other"], styles: ["other"] });
  });
  it("閾値ちょうどはラベルに含める", () => {
    expect(deriveLabels([result("types", 0.5)], 0.5)).toEqual({
      aspects: ["types"],
      styles: ["other"],
    });
  });
  it("エラー(確率null)の質問は、ラベルにも判断材料にもしない", () => {
    expect(deriveLabels([result("performance", null), result("tests", 0.8)], 0.5)).toEqual({
      aspects: ["tests"],
      styles: ["other"],
    });
  });
  it("is_ackなど、観点・言い方以外の質問は無視する", () => {
    expect(deriveLabels([result("is_ack", 0.99)], 0.5)).toEqual({
      aspects: ["other"],
      styles: ["other"],
    });
  });
});

describe("selfContainedProbability", () => {
  it("self-containedの質問は「知識が要る確率」を返す向きなので、1から引いて「知識が無くてもわかる確率」にする", () => {
    expect(selfContainedProbability(0.9)).toBeCloseTo(0.1, 10);
    expect(selfContainedProbability(0.2)).toBeCloseTo(0.8, 10);
    expect(selfContainedProbability(0)).toBe(1);
    expect(selfContainedProbability(1)).toBe(0);
  });
});

describe("isSelfContained", () => {
  it("反転した確率(知識が無くてもわかる確率)が閾値以上なら true", () => {
    // 生の確率(知識が要る確率)0.1 → 反転後 0.9 → 閾値0.5以上
    expect(isSelfContained(0.1, 0.5)).toBe(true);
    // 生の確率0.9 → 反転後0.1 → 閾値0.5未満
    expect(isSelfContained(0.9, 0.5)).toBe(false);
  });
  it("閾値ちょうどは含める", () => {
    expect(isSelfContained(0.5, 0.5)).toBe(true);
  });
});
