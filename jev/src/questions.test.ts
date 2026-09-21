import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ASPECT_IDS, IS_ACK_ID, QUESTION_IDS, STYLE_IDS } from "@oss-review-lab/shared";
import {
  buildRequests,
  loadQuestionDefs,
  questionDefHash,
  questionPlanHash,
  type QuestionDef,
} from "./questions";
import { stableStringify } from "./state";

const def = (over: Partial<QuestionDef> = {}): QuestionDef => ({
  id: "types",
  type: "noul",
  target: "root",
  instructions: "Does `comment` talk about types?",
  criteria: { true: "yes", false: "no" },
  ...over,
});

describe("loadQuestionDefs(実際の定義ファイル)", () => {
  const defs = loadQuestionDefs();

  it("IDの集合が、sharedの質問IDの集合と一致する", () => {
    expect(defs.all.map((d) => d.id).sort()).toEqual([...QUESTION_IDS].sort());
    expect(defs.aspects.map((d) => d.id)).toEqual([...ASPECT_IDS]);
    expect(defs.styles.map((d) => d.id)).toEqual([...STYLE_IDS]);
    expect(defs.isAck.id).toBe(IS_ACK_ID);
  });

  it("is_ackは返信が対象、観点・言い方は親が対象で、全てnoul", () => {
    expect(defs.isAck.target).toBe("reply");
    expect(defs.aspects.map((d) => [d.target, d.type])).toEqual(ASPECT_IDS.map(() => ["root", "noul"]));
    expect(defs.styles.map((d) => [d.target, d.type])).toEqual(STYLE_IDS.map(() => ["root", "noul"]));
  });

  it("全ての定義に、空でないinstructionsとtrue/falseのcriteriaがある", () => {
    for (const d of [defs.isAck, ...defs.aspects, ...defs.styles]) {
      expect(d.instructions.length > 0 && d.criteria.true.length > 0 && d.criteria.false.length > 0).toBe(true);
    }
  });

  it("is_ackの定義が、詳細設計の質問文どおり", () => {
    expect(defs.isAck.instructions).toBe(
      "Does `reply` only agree with, acknowledge, or report completion of the request in `thread`, without adding new information or reasoning?",
    );
  });
});

describe("questionDefHash", () => {
  it("定義内容のsha256(キー順に依存しない)", () => {
    const d = def();
    expect(questionDefHash(d)).toBe(createHash("sha256").update(stableStringify(d)).digest("hex"));
    const reordered = { criteria: d.criteria, target: d.target, type: d.type, instructions: d.instructions, id: d.id };
    expect(questionDefHash(reordered as QuestionDef)).toBe(questionDefHash(d));
  });

  it("質問文を1文字変えるとhashが変わる", () => {
    expect(questionDefHash(def({ instructions: "Does `comment` talk about types?!" }))).not.toBe(
      questionDefHash(def()),
    );
  });

  it("criteriaを変えるとhashが変わる", () => {
    expect(questionDefHash(def({ criteria: { true: "yes", false: "no." } }))).not.toBe(questionDefHash(def()));
  });
});

describe("questionPlanHash", () => {
  it("全質問の(id, 定義hash)を並べたもののhash", () => {
    const a = def({ id: "types" });
    const b = def({ id: "tests" });
    const expected = createHash("sha256")
      .update(
        stableStringify([
          { id: "types", hash: questionDefHash(a) },
          { id: "tests", hash: questionDefHash(b) },
        ]),
      )
      .digest("hex");
    expect(questionPlanHash([a, b])).toBe(expected);
  });

  it("質問の順序が違えば別のhash、定義が変われば別のhash", () => {
    const a = def({ id: "types" });
    const b = def({ id: "tests" });
    expect(questionPlanHash([a, b])).not.toBe(questionPlanHash([b, a]));
    expect(questionPlanHash([a, b])).not.toBe(questionPlanHash([a, def({ id: "tests", instructions: "x" })]));
  });
});

describe("buildRequests", () => {
  const state = { comment: { body: "b", path: "p" }, diffHunk: "d", pr: { title: "t" } };
  const defs = [def({ id: "types" }), def({ id: "tests", instructions: "T?", criteria: { true: "t", false: "f" } })];

  it("まとめる: 全質問を1リクエストに入れる(type/instructions/criteriaだけを送る)", () => {
    expect(buildRequests(state, defs, false)).toEqual([
      {
        questionIds: ["types", "tests"],
        state,
        questions: {
          types: { type: "noul", instructions: "Does `comment` talk about types?", criteria: { true: "yes", false: "no" } },
          tests: { type: "noul", instructions: "T?", criteria: { true: "t", false: "f" } },
        },
      },
    ]);
  });

  it("--split: 質問ごとに別リクエストになる", () => {
    expect(buildRequests(state, defs, true)).toEqual([
      {
        questionIds: ["types"],
        state,
        questions: {
          types: { type: "noul", instructions: "Does `comment` talk about types?", criteria: { true: "yes", false: "no" } },
        },
      },
      {
        questionIds: ["tests"],
        state,
        questions: { tests: { type: "noul", instructions: "T?", criteria: { true: "t", false: "f" } } },
      },
    ]);
  });

  it("実際の15問: まとめると1リクエストに15のID、分けると15リクエスト", () => {
    const d = loadQuestionDefs();
    const rootDefs = [...d.aspects, ...d.styles];
    const whole = buildRequests(state, rootDefs, false);
    expect(whole.length).toBe(1);
    expect(whole[0]?.questionIds).toEqual([...ASPECT_IDS, ...STYLE_IDS]);
    expect(Object.keys(whole[0]?.questions ?? {})).toEqual([...ASPECT_IDS, ...STYLE_IDS]);
    const split = buildRequests(state, rootDefs, true);
    expect(split.map((r) => r.questionIds)).toEqual([...ASPECT_IDS, ...STYLE_IDS].map((id) => [id]));
  });
});
