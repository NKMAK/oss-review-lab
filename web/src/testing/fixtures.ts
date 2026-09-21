import manifestText from "../../../shared/fixtures/data/index.json?raw";
import runAckText from "../../../shared/fixtures/data/runs/run-20260921-ack.json?raw";
import runAspectsText from "../../../shared/fixtures/data/runs/run-20260921-aspects.json?raw";
import runPartialText from "../../../shared/fixtures/data/runs/run-20260921-partial.json?raw";
import runWithRepliesText from "../../../shared/fixtures/data/runs/run-20260921-with-replies.json?raw";
import threadsText from "../../../shared/fixtures/data/threads/threads.jsonl?raw";

/** テスト用: fixtures の全ファイルを、`/data/...` のURLで引けるようにした表(fetch のスタブが返す)。 */
export const FIXTURE_FILES: Record<string, string> = {
  "/data/index.json": manifestText,
  "/data/threads/threads.jsonl": threadsText,
  "/data/runs/run-20260921-ack.json": runAckText,
  "/data/runs/run-20260921-aspects.json": runAspectsText,
  "/data/runs/run-20260921-with-replies.json": runWithRepliesText,
  "/data/runs/run-20260921-partial.json": runPartialText,
};
