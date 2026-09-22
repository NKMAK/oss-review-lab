import { appendFile, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const CostSchema = z.number().min(0);

const EntrySchema = z.discriminatedUnion("event", [
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("reserved"), requestId: z.string(), runId: z.string(), amount: CostSchema }),
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("sent"), requestId: z.string() }),
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("settled"), requestId: z.string(), cost: CostSchema }),
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("failed"), requestId: z.string(), cost: CostSchema, reason: z.string() }),
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("released"), requestId: z.string(), reason: z.string() }),
  z.object({
    schemaVersion: z.literal(1),
    at: z.string(),
    event: z.literal("resolved"),
    requestId: z.string(),
    resolution: z.enum(["retry", "skip"]),
    /** 送信済みで応答不明だったものは、予約額を「使った」ものとして数える(保守的)。skip 済みを retry するときは 0 */
    cost: CostSchema,
  }),
  /** 実費が予約額を超えた、という事実の記録(状態は変えない)。settled の直後に書く */
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("overrun"), requestId: z.string(), reserved: CostSchema, cost: CostSchema }),
  /** overrun による停止を、人が明示的に解除した記録。以降の予約は再び可能になる。 */
  z.object({ schemaVersion: z.literal(1), at: z.string(), event: z.literal("overrun_acknowledged") }),
]);
export type LedgerEntry = z.infer<typeof EntrySchema>;

type RequestState =
  | { status: "reserved"; amount: number; runId: string }
  | { status: "sent"; amount: number; runId: string }
  /** 確定済み(再予約できない) */
  | { status: "settled" }
  /** `--resolve skip` 済み(永続。再予約できない。`--resolve retry` を明示したときだけ、再送できる) */
  | { status: "skipped" }
  /** failed / released / resolved(retry): 再予約できる */
  | { status: "idle" };

export type RequestStatus = RequestState["status"] | "none";

export type ReserveResult = { ok: true } | { ok: false; reason: string };

export type UnknownRequest = { requestId: string; runId: string; amount: number };

export type LedgerTotals = { limit: number; spent: number; held: number };

export type LedgerOptions = {
  /** 上限(ドル)。確定費用 + 予約額 <= 上限 で判定する */
  limit: number;
  /** 外部境界(時刻)の注入 */
  now?: () => Date;
  /** 警告(最終行の回復など) */
  warn?: (message: string) => void;
};

/** 浮動小数点の誤差だけを許す(上限ちょうどの予約を通すため) */
const EPSILON = 1e-12;

/** 許可された遷移だけを許す。不正なら、理由つきの例外(読み込み時と追記前の両方で使う)。 */
function nextState(current: RequestState | undefined, entry: LedgerEntry): RequestState {
  if (entry.event === "overrun_acknowledged") throw new Error("overrun_acknowledged はリクエスト状態を持ちません");
  const name = current?.status ?? "未登録";
  const bad = (): never => {
    throw new Error(`${entry.event}(requestId ${entry.requestId})は、${name} の後には置けません`);
  };
  switch (entry.event) {
    case "reserved":
      if (current === undefined || current.status === "idle") {
        return { status: "reserved", amount: entry.amount, runId: entry.runId };
      }
      return bad();
    case "sent":
      if (current?.status === "reserved") return { status: "sent", amount: current.amount, runId: current.runId };
      return bad();
    case "settled":
      if (current?.status === "sent") return { status: "settled" };
      return bad();
    case "failed":
      if (current?.status === "reserved" || current?.status === "sent") return { status: "idle" };
      return bad();
    case "released":
      if (current?.status === "reserved") return { status: "idle" };
      return bad();
    case "resolved":
      if (current?.status === "sent") return entry.resolution === "skip" ? { status: "skipped" } : { status: "idle" };
      if (current?.status === "skipped" && entry.resolution === "retry") return { status: "idle" };
      return bad();
    case "overrun":
      if (current !== undefined) return current;
      return bad();
  }
}

/**
 * 予約台帳(追記のみのJSONL)。`reserved → sent → settled | failed`、`reserved → released`、`sent → resolved`。
 * 同一プロセス内の並列は、内部の直列化で守る。プロセス間は `acquireLock` で守る(呼び出し側)。
 */
export class Ledger {
  private readonly states = new Map<string, RequestState>();
  private spent = 0;
  private overrun = false;
  private overrunRecorded = false;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly path: string,
    private readonly limit: number,
    private readonly now: () => Date,
  ) {}

  static async open(path: string, options: LedgerOptions): Promise<Ledger> {
    if (!Number.isFinite(options.limit) || options.limit < 0) {
      throw new Error(`上限は有限で非負の数値にしてください: ${String(options.limit)}`);
    }
    const ledger = new Ledger(path, options.limit, options.now ?? (() => new Date()));
    await mkdir(dirname(path), { recursive: true });
    let text = "";
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const terminated = text === "" || text.endsWith("\n");
    const lines = text.split("\n");
    const lastIndex = lines.length - 1;
    let crashedTail = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === "") continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch (e) {
        // 最終行だけが改行なしで途切れている場合は、書き込み中のクラッシュの痕跡として扱う
        if (!terminated && i === lastIndex) {
          crashedTail = true;
          break;
        }
        throw new Error(`${path}:${i + 1}: 台帳の行がJSONとして読めません: ${(e as Error).message}`);
      }
      const parsed = EntrySchema.safeParse(json);
      if (!parsed.success) throw new Error(`${path}:${i + 1}: 台帳の行の形式が不正です: ${parsed.error.message}`);
      try {
        ledger.apply(parsed.data);
      } catch (e) {
        throw new Error(`${path}:${i + 1}: 台帳の遷移が不正です: ${(e as Error).message}`);
      }
    }
    if (crashedTail) {
      const stamp = ledger.at().replace(/[:.]/g, "-");
      const backup = `${path}.bak-${stamp}`;
      await copyFile(path, backup);
      await writeFile(path, text.slice(0, text.lastIndexOf("\n") + 1));
      options.warn?.(
        `${path}: 最終行が途中で切れていました(書き込み中のクラッシュの痕跡)。元のファイルを ${backup} に退避し、その行を切り詰めて回復しました`,
      );
    } else if (!terminated) {
      await appendFile(path, "\n"); // 完全な最終行に改行が無いだけ。次の追記が連結されないようにする
    }
    return ledger;
  }

  private apply(entry: LedgerEntry): void {
    if (entry.event === "overrun") {
      this.overrun = true;
      this.overrunRecorded = true;
      return;
    }
    if (entry.event === "overrun_acknowledged") {
      this.overrun = false;
      return;
    }
    const next = nextState(this.states.get(entry.requestId), entry);
    if (entry.event === "settled" || entry.event === "failed" || entry.event === "resolved") this.spent += entry.cost;
    this.states.set(entry.requestId, next);
  }

  private held(): number {
    let sum = 0;
    for (const s of this.states.values()) {
      if (s.status === "reserved" || s.status === "sent") sum += s.amount;
    }
    return sum;
  }

  totals(): LedgerTotals {
    return { limit: this.limit, spent: this.spent, held: this.held() };
  }

  statusOf(requestId: string): RequestStatus {
    return this.states.get(requestId)?.status ?? "none";
  }

  /** このプロセスで、実費が予約額を超えたことがあるか(あれば、以降の予約を拒否する) */
  overrunSeen(): boolean {
    return this.overrun;
  }

  /** 解除済みを含め、台帳にoverrunの事実が記録されたことがあるか。並列化の判定に使う。 */
  overrunEverSeen(): boolean {
    return this.overrunRecorded;
  }

  /** 操作を1つずつ順に実行する(判定と追記の間に、他の予約が割り込まない)。 */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async append(entry: LedgerEntry): Promise<void> {
    if (entry.event !== "overrun_acknowledged") nextState(this.states.get(entry.requestId), entry); // 書く前に、遷移を検証する
    await appendFile(this.path, `${JSON.stringify(entry)}\n`);
    this.apply(entry);
  }

  private at(): string {
    return this.now().toISOString();
  }

  /** 確定費用 + 予約中の額 + 今回の予約額 <= 上限 のときだけ予約する。超えるなら、台帳に書かず拒否する。 */
  reserve(requestId: string, amount: number, runId: string): Promise<ReserveResult> {
    return this.serialize(async () => {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`予約額は有限で非負の数値にしてください: ${String(amount)}`);
      }
      const current = this.states.get(requestId);
      if (current !== undefined && current.status !== "idle") {
        throw new Error(`requestId ${requestId} は既に ${current.status} です(再予約できません)`);
      }
      if (this.overrun) {
        return { ok: false as const, reason: "実費が予約額を超えた(overrun)ため、新しい送信を止めています" };
      }
      const total = this.spent + this.held() + amount;
      if (total > this.limit + EPSILON) {
        return {
          ok: false as const,
          reason: `予算上限を超えるため予約できません(確定 ${this.spent} + 予約中 ${this.held()} + 今回 ${amount} > 上限 ${this.limit})`,
        };
      }
      await this.append({ schemaVersion: 1, at: this.at(), event: "reserved", requestId, runId, amount });
      return { ok: true as const };
    });
  }

  private requireState(requestId: string, expected: "reserved" | "sent"): void {
    const current = this.states.get(requestId);
    if (current?.status !== expected) {
      throw new Error(`requestId ${requestId} は ${current?.status ?? "未登録"} です(${expected} が必要)`);
    }
  }

  /** 送信の直前に呼ぶ(応答不明の検出のため)。 */
  markSent(requestId: string): Promise<void> {
    return this.serialize(async () => {
      this.requireState(requestId, "reserved");
      await this.append({ schemaVersion: 1, at: this.at(), event: "sent", requestId });
    });
  }

  /**
   * 成功。実費で確定する。実費が予約額を超えていたら、`overrun` を事実として記録し、
   * 以降の新しい予約を拒否する(実行中の分は、待って確定できる)。
   */
  settle(requestId: string, cost: number): Promise<{ overrun: boolean }> {
    return this.serialize(async () => {
      if (!Number.isFinite(cost) || cost < 0) throw new Error(`費用は有限で非負の数値にしてください: ${String(cost)}`);
      this.requireState(requestId, "sent");
      const current = this.states.get(requestId) as { amount: number };
      await this.append({ schemaVersion: 1, at: this.at(), event: "settled", requestId, cost });
      const over = cost > current.amount + EPSILON;
      if (over) {
        await this.append({ schemaVersion: 1, at: this.at(), event: "overrun", requestId, reserved: current.amount, cost });
      }
      return { overrun: over };
    });
  }

  /** `--acknowledge-overrun`。停止の理由を理解した人だけが、次の送信を開始できるようにする。 */
  acknowledgeOverrun(): Promise<boolean> {
    return this.serialize(async () => {
      if (!this.overrun) return false;
      await this.append({ schemaVersion: 1, at: this.at(), event: "overrun_acknowledged" });
      return true;
    });
  }

  /** 失敗(応答を受けて失敗が確定したもの)。課金が無ければ cost は 0。 */
  fail(requestId: string, reason: string, cost = 0): Promise<void> {
    return this.serialize(async () => {
      if (!Number.isFinite(cost) || cost < 0) throw new Error(`費用は有限で非負の数値にしてください: ${String(cost)}`);
      const current = this.states.get(requestId);
      if (current?.status !== "reserved" && current?.status !== "sent") {
        throw new Error(`requestId ${requestId} は ${current?.status ?? "未登録"} です(reserved か sent が必要)`);
      }
      await this.append({ schemaVersion: 1, at: this.at(), event: "failed", requestId, cost, reason });
    });
  }

  /** `sent` のまま応答不明のもの(自動では再送しない)。 */
  unresolved(): UnknownRequest[] {
    const list: UnknownRequest[] = [];
    for (const [requestId, s] of this.states) {
      if (s.status === "sent") list.push({ requestId, runId: s.runId, amount: s.amount });
    }
    return list;
  }

  /**
   * 起動時の回復。`reserved` だけ(未送信)の予約は解放する。
   * `sent` のまま応答不明のものは、そのまま残して一覧で返す(予約額は保持し続ける)。
   */
  recover(): Promise<{ released: string[]; unresolved: UnknownRequest[] }> {
    return this.serialize(async () => {
      const released: string[] = [];
      for (const [requestId, s] of [...this.states]) {
        if (s.status === "reserved") {
          await this.append({ schemaVersion: 1, at: this.at(), event: "released", requestId, reason: "recovered: reserved but never sent" });
          released.push(requestId);
        }
      }
      return { released, unresolved: this.unresolved() };
    });
  }

  /**
   * `--resolve retry|skip`。応答不明(sent)だった分の予約額を「使った」ものとして数える(保守的)。
   * retry は、そのリクエストを再予約できるようにする。skip は、永続的に再送しない(別のrunでも)。
   * skip 済みのものは、retry を明示したときだけ、再送できるようになる(追加の費用は数えない)。
   */
  resolve(requestId: string, resolution: "retry" | "skip"): Promise<void> {
    return this.serialize(async () => {
      const current = this.states.get(requestId);
      if (current?.status === "skipped" && resolution === "retry") {
        await this.append({ schemaVersion: 1, at: this.at(), event: "resolved", requestId, resolution, cost: 0 });
        return;
      }
      if (current?.status !== "sent") {
        throw new Error(`requestId ${requestId} は応答不明(sent)ではありません`);
      }
      await this.append({ schemaVersion: 1, at: this.at(), event: "resolved", requestId, resolution, cost: current.amount });
    });
  }
}

export type LockOptions = {
  /** 外部境界(pidの存在確認)の注入。既定は process.kill(pid, 0) */
  isPidAlive?: (pid: number) => boolean;
  /** 自分のpid(既定は process.pid) */
  pid?: number;
  now?: () => Date;
};

export class LockHeldError extends Error {
  constructor(
    readonly lockPath: string,
    readonly heldByPid: number | null,
  ) {
    super(
      heldByPid === null
        ? `${lockPath}: ロックの内容が読めないため、回収しません(手動で確認してください)`
        : `${lockPath}: pid ${heldByPid} が実行中です(二重起動は拒否します)`,
    );
    this.name = "LockHeldError";
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryCreateSync(lockPath: string, pid: number, now: Date): boolean {
  try {
    writeFileSync(lockPath, JSON.stringify({ pid, createdAt: now.toISOString() }), { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
}

function unlinkIfExistsSync(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/**
 * `data/.lock` を排他的に作る(同期版。import-raw・build-threads も、これで run と直列化する)。
 * 既にあれば、pidが存在しないときだけ回収する。戻り値の関数でロックを解放する。
 */
export function acquireLockSync(dataDir: string, options: LockOptions = {}): () => void {
  const lockPath = join(dataDir, ".lock");
  const pid = options.pid ?? process.pid;
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  const now = options.now ?? (() => new Date());
  mkdirSync(dataDir, { recursive: true });

  const release = (): void => unlinkIfExistsSync(lockPath);

  if (tryCreateSync(lockPath, pid, now())) return release;

  let heldBy: number | null = null;
  try {
    const parsed = z.object({ pid: z.number().int().positive() }).safeParse(JSON.parse(readFileSync(lockPath, "utf8")));
    if (parsed.success) heldBy = parsed.data.pid;
  } catch {
    heldBy = null;
  }
  if (heldBy === null || isPidAlive(heldBy)) throw new LockHeldError(lockPath, heldBy);

  // pidが存在しない: 古いロックを回収して、作り直す(競合したら、勝った側を尊重する)
  unlinkIfExistsSync(lockPath);
  if (tryCreateSync(lockPath, pid, now())) return release;
  throw new LockHeldError(lockPath, null);
}

/** `acquireLockSync` の非同期版(戻り値の解放関数が Promise を返す)。 */
export async function acquireLock(dataDir: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const release = acquireLockSync(dataDir, options);
  return async () => {
    release();
  };
}
