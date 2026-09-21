import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireLock, Ledger, LockHeldError } from "./ledger";

const FIXED = new Date("2026-09-22T00:00:00.000Z");
const at = FIXED.toISOString();

let dir: string;
let ledgerPath: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ledger-"));
  ledgerPath = join(dir, "ledger.jsonl");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const open = (limit: number) => Ledger.open(ledgerPath, { limit, now: () => FIXED });

async function lines(): Promise<unknown[]> {
  return (await readFile(ledgerPath, "utf8"))
    .split("\n")
    .filter((l) => l !== "")
    .map((l): unknown => JSON.parse(l));
}

describe("予約", () => {
  it("reserved → sent → settled を、追記のみで記録し、確定費用で数える", async () => {
    const ledger = await open(1);
    expect(await ledger.reserve("r1", 0.4, "run1")).toEqual({ ok: true });
    await ledger.markSent("r1");
    await ledger.settle("r1", 0.1);
    expect(ledger.totals()).toEqual({ limit: 1, spent: 0.1, held: 0 });
    expect(await lines()).toEqual([
      { schemaVersion: 1, at, event: "reserved", requestId: "r1", runId: "run1", amount: 0.4 },
      { schemaVersion: 1, at, event: "sent", requestId: "r1" },
      { schemaVersion: 1, at, event: "settled", requestId: "r1", cost: 0.1 },
    ]);
  });

  it("確定費用 + 予約額 が上限を超えるなら、拒否し、台帳に書かない", async () => {
    const ledger = await open(1);
    await ledger.reserve("r1", 0.7, "run1");
    await ledger.markSent("r1");
    await ledger.settle("r1", 0.7);
    expect(await ledger.reserve("r2", 0.4, "run1")).toEqual({
      ok: false,
      reason: "予算上限を超えるため予約できません(確定 0.7 + 予約中 0 + 今回 0.4 > 上限 1)",
    });
    expect((await lines()).length).toBe(3);
  });

  it("上限ちょうどは通す(浮動小数点の誤差で落とさない)", async () => {
    const ledger = await open(0.3);
    expect(await ledger.reserve("a", 0.1, "run1")).toEqual({ ok: true });
    expect(await ledger.reserve("b", 0.2, "run1")).toEqual({ ok: true });
    expect(await ledger.reserve("c", 0.001, "run1")).toEqual({
      ok: false,
      reason: "予算上限を超えるため予約できません(確定 0 + 予約中 0.30000000000000004 + 今回 0.001 > 上限 0.3)",
    });
  });

  it("並列(Promise.all)でも、確定費用 + 予約額 が上限を超えない", async () => {
    const ledger = await open(1);
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ledger.reserve(`r${i}`, 0.3, "run1")),
    );
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false, false, false, false, false, false, false]);
    expect(ledger.totals()).toEqual({ limit: 1, spent: 0, held: 0.8999999999999999 });
    expect((await lines()).length).toBe(3);
  });

  it("並列の予約・送信・確定が混ざっても、途中で上限を超えず、最後の確定費用が正しい", async () => {
    const ledger = await open(1);
    const outcomes = await Promise.all(
      Array.from({ length: 6 }, async (_, i) => {
        const id = `r${i}`;
        const r = await ledger.reserve(id, 0.4, "run1");
        if (!r.ok) return "halted";
        await ledger.markSent(id);
        await new Promise((res) => setTimeout(res, 1));
        await ledger.settle(id, 0.1);
        return "settled";
      }),
    );
    // 予約が解放されるタイミングで、後続が通る場合もあるが、確定費用は上限を超えない
    const settled = outcomes.filter((o) => o === "settled").length;
    const t = ledger.totals();
    expect(t.held).toBe(0);
    expect(t.spent).toBeCloseTo(settled * 0.1, 10);
    expect(t.spent <= 1).toBe(true);
    expect(settled >= 2).toBe(true);
  });

  it("同じrequestIdを、確定後に再予約できない。不正な額は拒否する", async () => {
    const ledger = await open(1);
    await ledger.reserve("r1", 0.1, "run1");
    await expect(ledger.reserve("r1", 0.1, "run1")).rejects.toThrow("requestId r1 は既に reserved です(再予約できません)");
    await expect(ledger.reserve("r2", Number.NaN, "run1")).rejects.toThrow("予約額は有限で非負の数値にしてください: NaN");
    await expect(ledger.reserve("r3", -1, "run1")).rejects.toThrow("予約額は有限で非負の数値にしてください: -1");
  });

  it("失敗(fail)は、課金なら費用を確定し、予約を解放する。再予約できる", async () => {
    const ledger = await open(1);
    await ledger.reserve("r1", 0.5, "run1");
    await ledger.markSent("r1");
    await ledger.fail("r1", "400 bad request", 0.02);
    expect(ledger.totals()).toEqual({ limit: 1, spent: 0.02, held: 0 });
    expect(await ledger.reserve("r1", 0.1, "run2")).toEqual({ ok: true });
  });

  it("再オープンで、台帳から状態を復元する", async () => {
    const first = await open(1);
    await first.reserve("r1", 0.4, "run1");
    await first.markSent("r1");
    await first.settle("r1", 0.3);
    await first.reserve("r2", 0.4, "run1");
    const second = await open(1);
    expect(second.totals()).toEqual({ limit: 1, spent: 0.3, held: 0.4 });
  });

  it("壊れた台帳の行は、行番号つきで止める", async () => {
    await writeFile(ledgerPath, `${JSON.stringify(reservedLine("x"))}\n{oops\n`);
    await expect(open(1)).rejects.toThrow(`${ledgerPath}:2: 台帳の行がJSONとして読めません`);
    await writeFile(ledgerPath, `{"schemaVersion":1,"event":"unknown"}\n`);
    await expect(open(1)).rejects.toThrow(`${ledgerPath}:1: 台帳の行の形式が不正です`);
  });

  it("上限が不正なら拒否する", async () => {
    await expect(open(Number.NaN)).rejects.toThrow("上限は有限で非負の数値にしてください: NaN");
  });
});

function reservedLine(id: string, amount = 0.1) {
  return { schemaVersion: 1, at, event: "reserved", requestId: id, runId: "run1", amount };
}
const ev = (event: string, id: string, extra: Record<string, unknown> = {}) => ({ schemaVersion: 1, at, event, requestId: id, ...extra });
const jsonl = (...entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");

describe("overrun(実費が予約額を超えた)", () => {
  it("settle で実費が予約額を超えたら、overrun を台帳に記録し、以降の予約を拒否する", async () => {
    const ledger = await open(10);
    await ledger.reserve("r1", 1, "run1");
    await ledger.reserve("r2", 1, "run1");
    await ledger.markSent("r1");
    await ledger.markSent("r2");
    expect(await ledger.settle("r1", 2)).toEqual({ overrun: true });
    expect(ledger.overrunSeen()).toBe(true);
    expect(await lines()).toContainEqual(ev("overrun", "r1", { reserved: 1, cost: 2 }));
    const r3 = await ledger.reserve("r3", 0.1, "run1");
    expect(r3.ok).toBe(false);
    // 実行中の分は、待って確定できる
    expect(await ledger.settle("r2", 1)).toEqual({ overrun: false });
    expect(ledger.totals()).toEqual({ limit: 10, spent: 3, held: 0 });
  });

  it("予約額ちょうどは overrun ではない", async () => {
    const ledger = await open(10);
    await ledger.reserve("r1", 0.3, "run1");
    await ledger.markSent("r1");
    expect(await ledger.settle("r1", 0.1 + 0.2)).toEqual({ overrun: false });
    expect(ledger.overrunSeen()).toBe(false);
  });

  it("overrun を記録した台帳を開き直しても予約を拒否し、明示的な解除を記録した後だけ予約できる", async () => {
    const first = await open(2);
    await first.reserve("r1", 0.1, "run1");
    await first.markSent("r1");
    await first.settle("r1", 0.2);
    const second = await open(2);
    expect(second.overrunSeen()).toBe(true);
    await expect(second.reserve("r2", 0.1, "run2")).resolves.toEqual({
      ok: false,
      reason: "実費が予約額を超えた(overrun)ため、新しい送信を止めています",
    });
    await second.acknowledgeOverrun();
    expect(second.overrunSeen()).toBe(false);
    await expect(second.reserve("r2", 0.1, "run2")).resolves.toEqual({ ok: true });
    expect((await lines()).map((entry) => (entry as { event: string }).event)).toContain("overrun_acknowledged");
  });
});

describe("台帳の最終行の回復", () => {
  it("最終行だけが途中で切れている(クラッシュの痕跡)なら、警告を出し、バックアップを取って、切り詰めて回復する", async () => {
    const good = jsonl(reservedLine("r1"), ev("sent", "r1"));
    await writeFile(ledgerPath, `${good}{"schemaVersion":1,"at":"2026-09-2`);
    const warnings: string[] = [];
    const ledger = await Ledger.open(ledgerPath, { limit: 1, now: () => FIXED, warn: (m) => warnings.push(m) });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("最終行");
    expect(ledger.unresolved().map((u) => u.requestId)).toEqual(["r1"]);
    expect(await readFile(ledgerPath, "utf8")).toBe(good);
    const backups = (await readdir(dir)).filter((n) => n.startsWith("ledger.jsonl.bak-"));
    expect(backups.length).toBe(1);
    expect(await readFile(join(dir, backups[0]!), "utf8")).toBe(`${good}{"schemaVersion":1,"at":"2026-09-2`);
    // 回復後の追記が、壊れた行に連結されない
    await ledger.settle("r1", 0.1);
    expect((await lines()).length).toBe(3);
  });

  it("最終行が完全だが改行だけ無いときは、改行を補って続ける(警告・切り詰めなし)", async () => {
    await writeFile(ledgerPath, `${JSON.stringify(reservedLine("r1"))}`);
    const ledger = await open(1);
    await ledger.markSent("r1");
    expect((await lines()).length).toBe(2);
  });

  it("途中の行の破損は、これまでどおり停止する(最終行が切れていても、その前の破損を隠さない)", async () => {
    await writeFile(ledgerPath, `${JSON.stringify(reservedLine("r1"))}\n{oops\n${JSON.stringify(ev("sent", "r1"))}\n{"trunc`);
    await expect(open(1)).rejects.toThrow(`${ledgerPath}:2: 台帳の行がJSONとして読めません`);
  });

  it("改行で終わっている壊れた最終行は、クラッシュの痕跡とはみなさず、停止する", async () => {
    await writeFile(ledgerPath, `${JSON.stringify(reservedLine("r1"))}\n{oops\n`);
    await expect(open(1)).rejects.toThrow(`${ledgerPath}:2: 台帳の行がJSONとして読めません`);
  });
});

describe("台帳の遷移の検証(読み込み時)", () => {
  const bad: Array<[string, unknown[], number]> = [
    ["settled の重複", [reservedLine("r1"), ev("sent", "r1"), ev("settled", "r1", { cost: 0.1 }), ev("settled", "r1", { cost: 0.1 })], 4],
    ["released の後の sent", [reservedLine("r1"), ev("released", "r1", { reason: "x" }), ev("sent", "r1")], 3],
    ["reserved なしの sent", [ev("sent", "r1")], 1],
    ["sent なしの settled", [reservedLine("r1"), ev("settled", "r1", { cost: 0.1 })], 2],
    ["sent の重複", [reservedLine("r1"), ev("sent", "r1"), ev("sent", "r1")], 3],
    ["settled の後の reserved", [reservedLine("r1"), ev("sent", "r1"), ev("settled", "r1", { cost: 0.1 }), reservedLine("r1")], 4],
    ["reserved の重複", [reservedLine("r1"), reservedLine("r1")], 2],
    ["sent でないものの resolved", [reservedLine("r1"), ev("resolved", "r1", { resolution: "retry", cost: 0.1 })], 2],
    ["skipped の後の sent", [reservedLine("r1"), ev("sent", "r1"), ev("resolved", "r1", { resolution: "skip", cost: 0.1 }), ev("sent", "r1")], 4],
    ["未登録の settled", [ev("settled", "zz", { cost: 0.1 })], 1],
  ];
  it.each(bad)("%s は、行番号つきで停止する", async (_name, entries, line) => {
    await writeFile(ledgerPath, jsonl(...entries));
    await expect(open(10)).rejects.toThrow(new RegExp(`${ledgerPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${line}: 台帳の遷移が不正です`));
  });

  it("許可された遷移(reserved→sent→settled|failed、reserved→released、sent→resolved、failed/released/retry の後の再予約)は通る", async () => {
    await writeFile(
      ledgerPath,
      jsonl(
        reservedLine("a"), ev("sent", "a"), ev("settled", "a", { cost: 0.1 }),
        reservedLine("b"), ev("sent", "b"), ev("failed", "b", { cost: 0, reason: "x" }), reservedLine("b"), ev("released", "b", { reason: "x" }), reservedLine("b"),
        reservedLine("c"), ev("sent", "c"), ev("resolved", "c", { resolution: "retry", cost: 0.1 }), reservedLine("c"),
      ),
    );
    await expect(open(10)).resolves.toBeDefined();
  });
});

describe("skip の永続化", () => {
  it("skip したリクエストは、別の runId でも再予約できない。retry を明示したときだけ、再予約できる", async () => {
    const first = await open(10);
    await first.reserve("k1", 0.4, "run1");
    await first.markSent("k1");
    await first.resolve("k1", "skip");
    const second = await open(10);
    expect(second.statusOf("k1")).toBe("skipped");
    await expect(second.reserve("k1", 0.4, "run2")).rejects.toThrow("requestId k1 は既に skipped です");
    await second.resolve("k1", "retry");
    expect(second.statusOf("k1")).toBe("idle");
    expect(await second.reserve("k1", 0.4, "run2")).toEqual({ ok: true });
    // skip の再 retry は、追加の費用を数えない
    expect(second.totals()).toEqual({ limit: 10, spent: 0.4, held: 0.4 });
  });
});

describe("回復", () => {
  it("sent のまま応答不明のものは、自動で再送せず一覧で返し、予約額は保持したまま", async () => {
    const first = await open(1);
    await first.reserve("r1", 0.4, "run1");
    await first.markSent("r1");
    const second = await open(1);
    expect(await second.recover()).toEqual({
      released: [],
      unresolved: [{ requestId: "r1", runId: "run1", amount: 0.4 }],
    });
    expect(second.totals()).toEqual({ limit: 1, spent: 0, held: 0.4 });
    await expect(second.reserve("r1", 0.4, "run2")).rejects.toThrow("requestId r1 は既に sent です");
  });

  it("reserved だけ(未送信)のものは、予約を解放し、再送できる", async () => {
    const first = await open(1);
    await first.reserve("r1", 0.9, "run1");
    const second = await open(1);
    expect(await second.recover()).toEqual({ released: ["r1"], unresolved: [] });
    expect(second.totals()).toEqual({ limit: 1, spent: 0, held: 0 });
    expect(await second.reserve("r1", 0.9, "run2")).toEqual({ ok: true });
    expect((await lines()).slice(1, 2)).toEqual([
      { schemaVersion: 1, at, event: "released", requestId: "r1", reason: "recovered: reserved but never sent" },
    ]);
  });

  it("--resolve retry: 予約額を使った分として数え、再予約できる", async () => {
    const first = await open(1);
    await first.reserve("r1", 0.4, "run1");
    await first.markSent("r1");
    const second = await open(1);
    await second.resolve("r1", "retry");
    expect(second.totals()).toEqual({ limit: 1, spent: 0.4, held: 0 });
    expect(second.unresolved()).toEqual([]);
    expect(await second.reserve("r1", 0.4, "run2")).toEqual({ ok: true });
  });

  it("--resolve skip: 予約額を使った分として数え、再予約できない", async () => {
    const first = await open(1);
    await first.reserve("r1", 0.4, "run1");
    await first.markSent("r1");
    const second = await open(1);
    await second.resolve("r1", "skip");
    expect(second.totals()).toEqual({ limit: 1, spent: 0.4, held: 0 });
    await expect(second.reserve("r1", 0.4, "run2")).rejects.toThrow("requestId r1 は既に skipped です");
  });

  it("応答不明でないものを resolve すると拒否する", async () => {
    const ledger = await open(1);
    await ledger.reserve("r1", 0.4, "run1");
    await expect(ledger.resolve("r1", "retry")).rejects.toThrow("requestId r1 は応答不明(sent)ではありません");
  });
});

describe("排他ロック(data/.lock)", () => {
  it("ロックを作り、解放すると消える", async () => {
    const release = await acquireLock(dir, { pid: 111, now: () => FIXED, isPidAlive: () => true });
    expect(JSON.parse(await readFile(join(dir, ".lock"), "utf8"))).toEqual({ pid: 111, createdAt: at });
    await release();
    await expect(readFile(join(dir, ".lock"), "utf8")).rejects.toThrow("ENOENT");
  });

  it("pidが生きているロックがあれば、二重起動を拒否し、ロックは消さない", async () => {
    await acquireLock(dir, { pid: 111, now: () => FIXED, isPidAlive: () => true });
    const err = await acquireLock(dir, { pid: 222, isPidAlive: (pid) => pid === 111 }).catch((e) => e);
    expect(err).toBeInstanceOf(LockHeldError);
    expect((err as Error).message).toBe(`${join(dir, ".lock")}: pid 111 が実行中です(二重起動は拒否します)`);
    expect(JSON.parse(await readFile(join(dir, ".lock"), "utf8"))).toEqual({ pid: 111, createdAt: at });
  });

  it("pidが存在しないロックだけ、回収する", async () => {
    await acquireLock(dir, { pid: 111, now: () => FIXED });
    const release = await acquireLock(dir, { pid: 222, now: () => FIXED, isPidAlive: () => false });
    expect(JSON.parse(await readFile(join(dir, ".lock"), "utf8"))).toEqual({ pid: 222, createdAt: at });
    await release();
  });

  it("内容が読めないロックは、回収せず拒否する", async () => {
    await writeFile(join(dir, ".lock"), "garbage");
    await expect(acquireLock(dir, { pid: 222, isPidAlive: () => false })).rejects.toThrow(
      `${join(dir, ".lock")}: ロックの内容が読めないため、回収しません(手動で確認してください)`,
    );
  });

  it("並列に取得しても、1つだけが成功する", async () => {
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5].map((pid) =>
        acquireLock(dir, { pid: 1000 + pid, isPidAlive: () => true }).then(
          () => "acquired",
          () => "refused",
        ),
      ),
    );
    expect(outcomes.filter((o) => o === "acquired").length).toBe(1);
    expect(outcomes.filter((o) => o === "refused").length).toBe(4);
  });
});
