import { describe, expect, it } from "vitest";
import { callJev, type JevCallInput, type JevFetch, type JevQuestion } from "./jev-client";

const API_KEY = "test-secret-key-0123456789";
const H = "a".repeat(64);
const S = "b".repeat(64);

const q1: JevQuestion = {
  id: "is_ack",
  type: "noul",
  instructions: "Does reply only agree?",
  criteria: { true: "t", false: "f" },
};
const q2: JevQuestion = {
  id: "other_q",
  type: "noul",
  instructions: "Something else?",
  criteria: { true: "t", false: "f" },
};

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
}

function makeFetch(responses: Array<Response | Error>): { fetch: JevFetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetch: JevFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = responses[i++];
    if (r === undefined) throw new Error("unexpected extra fetch call");
    if (r instanceof Error) throw r;
    return r;
  };
  return { fetch, calls };
}

function okBody(answers: Record<string, unknown>, usage: unknown = { input_tokens: 120, output_tokens: 7 }) {
  return { model: "jev-1.13.0", answers, usage };
}

function input(fetch: JevFetch, questions: JevQuestion[] = [q1], extra: Partial<JevCallInput> = {}): JevCallInput {
  return {
    state: { reply: { body: "LGTM" } },
    questions,
    model: "jev-latest",
    apiKey: API_KEY,
    meta: {
      targetId: "t1",
      stateHash: S,
      variant: "reply",
      questionDefHashes: Object.fromEntries(questions.map((q) => [q.id, H])),
    },
    fetch,
    sleep: async () => {},
    random: () => 0.5,
    now: (() => {
      let t = 1000;
      return () => (t += 50);
    })(),
    ...extra,
  };
}

describe("callJev 正常な応答", () => {
  it("noul応答をResultに投影し、リクエストの形も正しい", async () => {
    const { fetch, calls } = makeFetch([
      jsonResponse(200, okBody({ is_ack: { type: "noul", noul: 0.83 } })),
    ]);
    const out = await callJev(input(fetch));
    expect(out).toEqual({
      model: "jev-1.13.0",
      results: [
        {
          targetId: "t1",
          questionId: "is_ack",
          questionType: "noul",
          questionDefHash: H,
          stateHash: S,
          variant: "reply",
          raw: okBody({ is_ack: { type: "noul", noul: 0.83 } }),
          probability: 0.83,
          confidence: null,
          latencyMs: 50,
          usage: { inputTokens: 120, outputTokens: 7 },
          cost: null,
          error: null,
        },
      ],
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      state: { reply: { body: "LGTM" } },
      model: "jev-latest",
      questions: {
        is_ack: { type: "noul", instructions: "Does reply only agree?", criteria: { true: "t", false: "f" } },
      },
    });
  });

  it("choice応答は confidence を投影し、probability は null", async () => {
    const choiceQ: JevQuestion = { id: "c", type: "choice", instructions: "pick", criteria: { a: "x", b: "y" } };
    const { fetch } = makeFetch([
      jsonResponse(200, okBody({ c: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.9 } })),
    ]);
    const out = await callJev(input(fetch, [choiceQ]));
    expect(out.results.map((r) => [r.questionType, r.probability, r.confidence, r.error])).toEqual([
      ["choice", null, 0.9, null],
    ]);
  });
});

describe("callJev 再試行", () => {
  it("429・529を返してから成功: 3回目で成功、待機は指数バックオフ", async () => {
    const delays: number[] = [];
    const { fetch, calls } = makeFetch([
      jsonResponse(429, "rate"),
      jsonResponse(529, "overloaded"),
      jsonResponse(200, okBody({ is_ack: { type: "noul", noul: 0.1 } })),
    ]);
    const out = await callJev(input(fetch, [q1], { sleep: async (ms) => void delays.push(ms) }));
    expect(calls.length).toBe(3);
    expect(delays).toEqual([500, 1000]);
    expect(out.results.map((r) => [r.probability, r.error])).toEqual([[0.1, null]]);
  });

  it("常に429: 4回で停止し retryable、待機は3回。本文は保存しない", async () => {
    const delays: number[] = [];
    const { fetch, calls } = makeFetch([1, 2, 3, 4, 5].map(() => jsonResponse(429, "slow down")));
    const out = await callJev(input(fetch, [q1, q2], { sleep: async (ms) => void delays.push(ms) }));
    expect(calls.length).toBe(4);
    expect(delays).toEqual([500, 1000, 2000]);
    expect(out.model).toBe(null);
    expect(out.results.map((r) => [r.questionId, r.probability, r.usage, r.error, r.raw])).toEqual([
      ["is_ack", null, null, { kind: "retryable", message: "HTTP 429", attempts: 4 }, null],
      ["other_q", null, null, { kind: "retryable", message: "HTTP 429", attempts: 4 }, null],
    ]);
  });
});

describe("callJev 応答不明(二重課金の防止): 再送しない", () => {
  it.each([[500], [502], [503], [504]])("HTTP %i は再送せず(fetch 1回)、unknown", async (status) => {
    const { fetch, calls } = makeFetch([jsonResponse(status, "x"), jsonResponse(200, okBody({ is_ack: { type: "noul", noul: 0.2 } }))]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error).toEqual({ kind: "unknown", message: `HTTP ${status}`, attempts: 1 });
    expect(out.results[0]!.usage).toBe(null);
  });

  it("通信エラーは再送せず(fetch 1回)、unknown", async () => {
    const { fetch, calls } = makeFetch([new TypeError("fetch failed"), jsonResponse(200, okBody({ is_ack: { type: "noul", noul: 0.2 } }))]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error).toEqual({ kind: "unknown", message: "network error", attempts: 1 });
  });

  it("タイムアウトは再送せず(fetch 1回)、unknown", async () => {
    const calls: number[] = [];
    const fetch: JevFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls.push(1);
        init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const out = await callJev(input(fetch, [q1], { timeoutMs: 5 }));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error).toEqual({ kind: "unknown", message: "timeout", attempts: 1 });
  });

  it("429のあとに500なら、そこで止まり unknown(それ以上は送らない)", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(429, "r"), jsonResponse(500, "x"), jsonResponse(200, okBody({ is_ack: { type: "noul", noul: 0.2 } }))]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(2);
    expect(out.results[0]!.error).toEqual({ kind: "unknown", message: "HTTP 500", attempts: 2 });
  });

  it("2xx なのに本文の読み取りが失敗(途中切断)したら、応答不明(再送しない)", async () => {
    const res = new Response(new ReadableStream({ start: (c) => c.error(new Error("reset")) }), { status: 200 });
    const { fetch, calls } = makeFetch([res, jsonResponse(200, okBody({}))]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error!.kind).toBe("unknown");
  });
});

describe("callJev 4xx", () => {
  it("422は再試行せず fatal。状態コードだけを残し、エラー本文(stateのエコーを含み得る)は保存しない", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(422, { detail: "bad state: dummy comment body" })]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error).toEqual({ kind: "fatal", message: "HTTP 422", attempts: 1 });
    expect(out.results[0]!.raw).toBe(null);
    expect(JSON.stringify(out).includes("dummy comment body")).toBe(false);
  });

  it("401も fatal", async () => {
    const { fetch, calls } = makeFetch([jsonResponse(401, "unauthorized")]);
    const out = await callJev(input(fetch));
    expect(calls.length).toBe(1);
    expect(out.results[0]!.error).toEqual({ kind: "fatal", message: "HTTP 401", attempts: 1 });
  });
});

describe("callJev キー保護", () => {
  it("エラー本文・例外メッセージ・応答にキーが(エンコードされても)含まれても、Resultの全体にキーが出ない", async () => {
    const enc = Buffer.from(API_KEY).toString("base64");
    const { fetch } = makeFetch([jsonResponse(401, `bad key ${API_KEY} ${enc}`)]);
    const out = await callJev(input(fetch));
    expect(JSON.stringify(out).includes(API_KEY)).toBe(false);
    expect(JSON.stringify(out).includes(enc)).toBe(false);

    const { fetch: f2 } = makeFetch([new Error(`connect failed ${API_KEY}`)]);
    const out2 = await callJev(input(f2));
    expect(JSON.stringify(out2).includes(API_KEY)).toBe(false);
    expect(out2.results[0]!.error).toEqual({ kind: "unknown", message: "network error", attempts: 1 });
  });

  it("成功応答の answers(選択肢のキー・型)にキーが混ざっても、rawには残らない", async () => {
    const choiceQ: JevQuestion = { id: "c", type: "choice", instructions: "pick", criteria: {} };
    const body = okBody({ c: { type: "choice", choice: `a-${API_KEY}`, probabilities: { [`a-${API_KEY}`]: 1 }, confidence: 0.5 } });
    const { fetch } = makeFetch([jsonResponse(200, body)]);
    const out = await callJev(input(fetch, [choiceQ]));
    expect(JSON.stringify(out).includes(API_KEY)).toBe(false);
  });
});

describe("callJev 保存する応答の許可リスト", () => {
  it("rawには model・usage・answers(型・確率・選択肢)だけを残し、それ以外(エコーされたstateなど)は残さない", async () => {
    const body = {
      ...okBody(
        {
          is_ack: { type: "noul", noul: 0.4, explanation: "dummy comment body", state: { reply: "dummy comment body" } },
          c: { type: "score", score: "high", legend: { high: "dummy comment body" }, probabilities: { high: 0.7 }, confidence: 0.6, note: "x" },
        },
        { input_tokens: 5, output_tokens: 2, extra: "dummy comment body" },
      ),
      echoed_state: { reply: { body: "dummy comment body" } },
    };
    const scoreQ: JevQuestion = { id: "c", type: "score", instructions: "s", criteria: {} };
    const { fetch } = makeFetch([jsonResponse(200, body)]);
    const out = await callJev(input(fetch, [q1, scoreQ]));
    expect(out.results[0]!.raw).toEqual({
      model: "jev-1.13.0",
      usage: { input_tokens: 5, output_tokens: 2 },
      answers: {
        is_ack: { type: "noul", noul: 0.4 },
        c: { type: "score", score: "high", probabilities: { high: 0.7 }, confidence: 0.6 },
      },
    });
    expect(JSON.stringify(out).includes("dummy comment body")).toBe(false);
  });
});

describe("callJev 応答の検証(すべて fatal、raw は残る)", () => {
  const cases: Array<[string, unknown]> = [
    ["質問IDの欠落", okBody({})],
    ["質問IDの余剰", okBody({ is_ack: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 0.5 } })],
    ["別IDに置き換わっている", okBody({ wrong: { type: "noul", noul: 0.5 } })],
    ["型の不一致", okBody({ is_ack: { type: "score", score: "a", legend: {}, probabilities: {}, confidence: 0.5 } })],
    ["確率が範囲外(>1)", okBody({ is_ack: { type: "noul", noul: 1.5 } })],
    ["確率が範囲外(<0)", okBody({ is_ack: { type: "noul", noul: -0.1 } })],
    ["確率が文字列", okBody({ is_ack: { type: "noul", noul: "0.5" } })],
    ["usageが負", okBody({ is_ack: { type: "noul", noul: 0.5 } }, { input_tokens: -1, output_tokens: 1 })],
    ["usageが小数", okBody({ is_ack: { type: "noul", noul: 0.5 } }, { input_tokens: 1.5, output_tokens: 1 })],
    ["usageが無い", { model: "m", answers: { is_ack: { type: "noul", noul: 0.5 } } }],
    ["未知の形", { hello: "world" }],
    ["配列", []],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      const { fetch, calls } = makeFetch([jsonResponse(200, body)]);
      const out = await callJev(input(fetch));
      expect(calls.length).toBe(1);
      expect(out.results.length).toBe(1);
      const r = out.results[0]!;
      expect([r.error!.kind, r.error!.attempts, r.probability, r.confidence, r.usage]).toEqual(["fatal", 1, null, null, null]);
      expect(r.raw).toBe(null); // 契約に合わない応答は、中身を信用できないので保存しない
    });
  }

  it("choiceの確率が範囲外なら fatal", async () => {
    const choiceQ: JevQuestion = { id: "c", type: "choice", instructions: "pick", criteria: {} };
    const body = okBody({ c: { type: "choice", choice: "a", probabilities: { a: 2 }, confidence: 0.5 } });
    const { fetch } = makeFetch([jsonResponse(200, body)]);
    const out = await callJev(input(fetch, [choiceQ]));
    expect(out.results[0]!.error!.kind).toBe("fatal");
  });

  it("JSONでない200応答は fatal。本文は保存しない", async () => {
    const { fetch } = makeFetch([jsonResponse(200, "<html>oops</html>")]);
    const out = await callJev(input(fetch));
    expect(out.results[0]!.error).toEqual({
      kind: "fatal",
      message: "response is not valid JSON",
      attempts: 1,
    });
    expect(out.results[0]!.raw).toBe(null);
  });

  it("fatalな応答でも、応答に含まれる実際のモデル識別子を返す", async () => {
    const { fetch } = makeFetch([jsonResponse(200, okBody({}))]);
    const out = await callJev(input(fetch));
    expect(out.model).toBe("jev-1.13.0");
  });
});

describe("callJev 入力", () => {
  it("質問IDが重複していたら例外(fetchは呼ばない)", async () => {
    const { fetch, calls } = makeFetch([]);
    await expect(callJev(input(fetch, [q1, q1]))).rejects.toThrow("duplicate question id: is_ack");
    expect(calls.length).toBe(0);
  });
});
