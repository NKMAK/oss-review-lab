import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

const threadsUrl = "/data/threads/threads.jsonl";

async function waitForThreads(page: Page) {
  await expect(page.getByTestId("thread-count")).toHaveText("2件 / 全5件");
}

/** URLの更新で状態を反映する制御コンポーネントを、反映完了まで待って切り替える。 */
async function setChecked(locator: Locator, checked: boolean) {
  await locator.click();
  if (checked) {
    await expect(locator).toBeChecked();
  } else {
    await expect(locator).not.toBeChecked();
  }
}

test("一覧は親コメントと元へのリンクを表示し、観点・言い方・発言者・除外で絞り込める", async ({ page }) => {
  await page.goto("/threads");
  await waitForThreads(page);
  await expect(page.getByTestId("thread-card")).toHaveCount(2);
  await expect(page.getByTestId("thread-card").first().getByTestId("root-body")).toHaveText(
    "Dummy: this API shape and its types look fragile; a test would help.",
  );
  await expect(page.getByTestId("pr-link").first()).toHaveAttribute(
    "href",
    "https://example.test/example-org/example-repo/pull/11",
  );
  await expect(page.getByTestId("root-link").first()).toHaveAttribute(
    "href",
    "https://example.test/example-org/example-repo/pull/11#discussion_r1001",
  );

  await setChecked(page.getByRole("checkbox", { name: "型", exact: true }), true);
  await setChecked(page.getByRole("checkbox", { name: "テスト", exact: true }), true);
  await expect(page.getByTestId("thread-count")).toHaveText("1件 / 全5件");
  await expect(page.getByTestId("thread-card")).toHaveAttribute("data-thread-id", "1001");
  await setChecked(page.getByRole("checkbox", { name: "型", exact: true }), false);
  await setChecked(page.getByRole("checkbox", { name: "テスト", exact: true }), false);
  await expect(page.getByTestId("thread-count")).toHaveText("2件 / 全5件");

  // fixturesでは「修正案を示す」は1001が20%、4001が10%で、閾値50%に届かない。
  await setChecked(page.getByRole("checkbox", { name: "修正案を示す", exact: true }), true);
  await expect(page.getByTestId("thread-count")).toHaveText("0件 / 全5件");
  await setChecked(page.getByRole("checkbox", { name: "修正案を示す", exact: true }), false);
  // 「理由を説明」は1001だけが70%なので、言い方と発言者役割を別々に確認できる。
  await setChecked(page.getByRole("checkbox", { name: "理由を説明", exact: true }), true);
  await expect(page.getByTestId("thread-count")).toHaveText("1件 / 全5件");
  await expect(page.getByTestId("thread-card")).toHaveAttribute("data-thread-id", "1001");
  await setChecked(page.getByRole("radio", { name: "第三者(PR作者以外)", exact: true }), true);
  await expect(page.getByTestId("thread-count")).toHaveText("1件 / 全5件");
  await setChecked(page.getByRole("radio", { name: "PR作者", exact: true }), true);
  await expect(page.getByTestId("thread-empty")).toHaveText("該当なし");

  await setChecked(page.getByRole("checkbox", { name: "除外を含む", exact: true }), true);
  await expect(page.getByTestId("thread-count")).toHaveText("0件 / 全5件");
  await setChecked(page.getByRole("radio", { name: "全員", exact: true }), true);
  await setChecked(page.getByRole("checkbox", { name: "理由を説明", exact: true }), false);
  await expect(page.getByTestId("thread-count")).toHaveText("5件 / 全5件");
  expect(await page.getByTestId("thread-excluded-reason").allTextContents()).toEqual([
    "除外: botが親コメント",
    "除外: 削除済みユーザーが親コメント",
    "除外: 親コメントが取得範囲外",
  ]);
});

test("一覧では除外された返信を既定で隠し、切り替えると表示する", async ({ page }) => {
  await page.goto("/threads");
  await waitForThreads(page);
  await page.getByTestId("thread-card").first().getByTestId("replies-summary").click();
  await expect(page.getByTestId("thread-card").first().getByTestId("reply")).toHaveCount(1);
  await expect(page.getByTestId("reply-badge")).toHaveCount(0);
  await setChecked(page.getByRole("checkbox", { name: "除外を含む", exact: true }), true);
  await expect(page.getByTestId("thread-card").first().getByTestId("reply")).toHaveCount(4);
  // fixturesの1001はack・bot・unknownが各1件。4001は4002=99%、4003=85%だけが
  // 既定のackThreshold 80%以上で除外され、4004=50%は本文を残してバッジを出さない。
  const thread1001 = page.locator('[data-testid="thread-card"][data-thread-id="1001"]');
  const thread4001 = page.locator('[data-testid="thread-card"][data-thread-id="4001"]');
  expect(await thread1001.getByTestId("reply-badge").allTextContents()).toEqual([
    "除外: 同意・完了報告",
    "除外: bot",
    "除外: 削除済みユーザー",
  ]);
  expect(await thread4001.getByTestId("reply-badge").allTextContents()).toEqual([
    "除外: 同意・完了報告",
    "除外: 同意・完了報告",
  ]);
  await thread4001.getByTestId("replies-summary").click();
  await expect(thread4001.locator('[data-reply-id="4004"]').getByTestId("reply-body")).toHaveText("Dummy: thanks!");
});

test("除外確認は確率順・要確認帯・閾値の変更を表示し、親コメントを残す", async ({ page }) => {
  await page.goto("/review/exclusion");
  await expect(page.getByTestId("reply-row")).toHaveCount(8);
  expect(await page.getByTestId("reply-row").evaluateAll((rows) => rows.map((row) => row.getAttribute("data-reply-id")))).toEqual([
    "4002",
    "1002",
    "4003",
    "2002",
    "5002",
    "4004",
    "1003",
    "1005",
  ]);
  await expect(page.getByTestId("summary")).toHaveText("除外される返信: 4件 / 対象 7件(bot・不明ユーザーの返信 1件は、コードで除外済み)");
  await expect(page.getByTestId("reply-row").filter({ has: page.getByTestId("band") })).toHaveCount(2);
  await expect(page.getByTestId("reply-row").nth(3).getByTestId("parent-body")).toHaveText(
    "Dummy: bot generated suggestion.",
  );

  await page.getByRole("slider", { name: "閾値" }).fill("0.5");
  await expect(page.getByTestId("threshold-value")).toHaveText("0.50");
  await expect(page.getByTestId("summary")).toHaveText("除外される返信: 6件 / 対象 7件(bot・不明ユーザーの返信 1件は、コードで除外済み)");
  await page.getByRole("slider", { name: "閾値" }).fill("1");
  await page.goto("/threads?ackThreshold=1&labelThreshold=0.5");
  await waitForThreads(page);
  await expect(page.getByTestId("thread-card").first().getByTestId("root-body")).toHaveText(
    "Dummy: this API shape and its types look fragile; a test would help.",
  );
  await page.goto("/threads?ackThreshold=0&labelThreshold=0.5");
  await waitForThreads(page);
  await expect(page.getByTestId("thread-card").nth(1).getByTestId("root-body")).toHaveText(
    "Dummy: why is this exposed publicly? Consider a private helper.",
  );
});

test("詳細はdiff、時系列、Jev結果を表示し、noulにconfidenceを表示しない", async ({ page }) => {
  await page.goto("/threads/1001");
  const diff = page.getByTestId("diff");
  await expect(diff.getByTestId("diff-line")).toHaveCount(4);
  expect(await diff.getByTestId("diff-line").allTextContents()).toEqual([
    "@@ -1,3 +1,3 @@",
    "-const a = 1;",
    "+const a = 2;",
    " const b = 3;",
  ]);
  expect(await page.getByTestId("timeline-comment").evaluateAll((comments) => comments.map((comment) => comment.getAttribute("data-comment-id")))).toEqual([
    "1001",
    "1002",
    "1003",
    "1004",
    "1005",
  ]);
  await expect(page.getByTestId("timeline-comment").first().getByTestId("jev-results")).toContainText("型 確率 75%");
  await expect(page.getByTestId("thread-detail")).not.toContainText("confidence");
});

test("Jev結果はrunを選べ、partialを集計から外す", async ({ page }) => {
  await page.goto("/jev");
  await expect(page.getByTestId("jev-summary")).toContainText("質問数");
  await expect(page.getByTestId("jev-summary")).toContainText("応答時間(平均)");
  await expect(page.getByTestId("jev-summary")).toContainText("費用(cost の合計)");
  await page.getByRole("combobox").selectOption("run-20260921-partial");
  await expect(page.getByRole("status")).toHaveText("このrun(run-20260921-partial)は途中で止まっている(partial)ため、集計から外しています。");
  await expect(page.getByTestId("jev-summary")).toHaveCount(0);
  await page.getByRole("combobox").selectOption("run-20260921-ack");
  await expect(page.getByTestId("jev-dist-is_ack")).toContainText("確率 8件・エラー 0件");
});

test("データが空の状態を表示する", async ({ page }) => {
  await page.route("**/data/index.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ schemaVersion: 1, sources: [], threads: { file: "threads/threads.jsonl", sha256: "e".repeat(64), count: 0 }, runs: [] }),
    }),
  );
  await page.route(threadsUrl, (route) => route.fulfill({ contentType: "application/x-ndjson", body: "" }));
  for (const path of ["/threads", "/threads/1001", "/review/exclusion", "/jev"]) {
    await page.goto(path);
    await expect(page.getByRole("status")).toHaveText("スレッドが0件です。データを取り込み(import-raw → build-threads)してください。");
  }
});

test("壊れたManifestの読み込み失敗を表示する", async ({ page }) => {
  await page.route("**/data/index.json", (route) => route.fulfill({ contentType: "application/json", body: "{" }));
  for (const path of ["/threads", "/threads/1001", "/review/exclusion", "/jev"]) {
    await page.goto(path);
    await expect(page.getByRole("alert")).toContainText("Manifestが不正です: Manifest(/data/index.json)のJSONが壊れています:");
  }
});

test("本文のscriptは実行せず、生のテキストとして表示する", async ({ page }) => {
  const xss = '<script>window.__xss = 1</script><img src=x onerror="window.__xss = 2">';
  const response = await page.request.get(threadsUrl);
  const body = (await response.text())
    .trimEnd()
    .split("\n")
    .map((line) => {
      const thread = JSON.parse(line) as { threadId: string; comments: { id: string; body: string }[] };
      if (thread.threadId === "1001") {
        const root = thread.comments.find((comment) => comment.id === "1001");
        if (root !== undefined) root.body = xss;
      }
      return JSON.stringify(thread);
    })
    .join("\n");
  await page.route(threadsUrl, (route) => route.fulfill({ contentType: "application/x-ndjson", body }));
  await page.goto("/threads");
  await waitForThreads(page);
  await expect(page.getByTestId("root-body").first()).toHaveText(xss);
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test("除外確認の代表画面は基準画像と一致する", async ({ page }) => {
  await page.goto("/review/exclusion");
  await expect(page.getByTestId("page-exclusion-review")).toHaveScreenshot("exclusion-review.png", {
    animations: "disabled",
  });
});

declare global {
  interface Window {
    __xss?: number;
  }
}
