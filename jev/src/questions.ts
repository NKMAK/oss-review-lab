import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASPECT_IDS, IS_ACK_ID, STYLE_IDS, UNDERSTANDABILITY_IDS } from "@oss-review-lab/shared";
import { z } from "zod";
import { sha256, stableStringify } from "./state";

const QuestionDefSchema = z.object({
  id: z.string(),
  type: z.literal("noul"),
  target: z.enum(["root", "reply"]),
  instructions: z.string().min(1),
  criteria: z.object({ true: z.string().min(1), false: z.string().min(1) }),
});
export type QuestionDef = z.infer<typeof QuestionDefSchema>;

export type QuestionDefs = {
  isAck: QuestionDef;
  aspects: QuestionDef[];
  styles: QuestionDef[];
  understandability: QuestionDef[];
  /** aspects → styles → understandability → isAck の順 */
  all: QuestionDef[];
};

export const DEFAULT_QUESTIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "questions");

function readDef(file: string, expectedId: string): QuestionDef {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`cannot read question definition ${file}: ${(e as Error).message}`);
  }
  const parsed = QuestionDefSchema.safeParse(json);
  if (!parsed.success) throw new Error(`invalid question definition ${file}: ${parsed.error.message}`);
  if (parsed.data.id !== expectedId) {
    throw new Error(`question id mismatch in ${file}: expected ${expectedId}, got ${parsed.data.id}`);
  }
  return parsed.data;
}

/** 質問定義(JSON)を読み込み、検証する。ファイル名はsharedのID(`ASPECT_IDS` など)から決める。 */
export function loadQuestionDefs(dir: string = DEFAULT_QUESTIONS_DIR): QuestionDefs {
  const isAck = readDef(join(dir, "is-ack.json"), IS_ACK_ID);
  const aspects = ASPECT_IDS.map((id) => readDef(join(dir, "aspect", `${id}.json`), id));
  const styles = STYLE_IDS.map((id) => readDef(join(dir, "style", `${id}.json`), id));
  const understandability = UNDERSTANDABILITY_IDS.map((id) => readDef(join(dir, "understandability", `${id}.json`), id));
  return { isAck, aspects, styles, understandability, all: [...aspects, ...styles, ...understandability, isAck] };
}

/** 定義内容(id・type・target・instructions・criteria)のsha256。 */
export function questionDefHash(def: QuestionDef): string {
  return sha256(stableStringify(def));
}

/** 全質問の(id, 定義hash)を並べたもののhash。 */
export function questionPlanHash(defs: readonly QuestionDef[]): string {
  return sha256(stableStringify(defs.map((d) => ({ id: d.id, hash: questionDefHash(d) }))));
}

export type RequestQuestion = { type: "noul"; instructions: string; criteria: { true: string; false: string } };
export type PlannedRequest<S> = {
  questionIds: string[];
  state: S;
  questions: Record<string, RequestQuestion>;
};

/** 1つのstateに対する質問を、1リクエストにまとめる(split=falseなら)か、質問ごとに分ける(split=true)。 */
export function buildRequests<S>(state: S, defs: readonly QuestionDef[], split: boolean): PlannedRequest<S>[] {
  const toQuestion = (d: QuestionDef): RequestQuestion => ({
    type: d.type,
    instructions: d.instructions,
    criteria: d.criteria,
  });
  if (split) {
    return defs.map((d) => ({ questionIds: [d.id], state, questions: { [d.id]: toQuestion(d) } }));
  }
  return [
    {
      questionIds: defs.map((d) => d.id),
      state,
      questions: Object.fromEntries(defs.map((d) => [d.id, toQuestion(d)])),
    },
  ];
}
