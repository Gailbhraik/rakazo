import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function revealHoverRail(
  row: import("@playwright/test").Locator,
): Promise<import("@playwright/test").Locator> {
  await row.hover();
  const rail = row.getByTestId("message-hover-rail");
  await expect(rail).toBeVisible();
  // Full-page shots can drop :hover; pin the rail so geometry stays visible.
  await rail.evaluate((el) => {
    const node = el as HTMLElement;
    node.style.opacity = "1";
    node.style.pointerEvents = "auto";
  });
  return rail;
}

async function clearHoverRail(rail: import("@playwright/test").Locator) {
  await rail.evaluate((el) => el.removeAttribute("style"));
}

test("message hover shows beside-bubble actions; reply links to parent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const transcript = page.getByTestId("transcript");

  // Bot welcome (left bubble): icons sit to the right, vertically centered.
  const botRow = transcript.locator(`[data-message-id]`).first();
  await expect(botRow).toBeVisible();
  const botRail = await revealHoverRail(botRow);
  const botToolbar = botRow.getByTestId("message-hover-actions");
  await expect(botToolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "More" })).toBeVisible();
  // Measure against the bubble frame (rail offset parent), not an inner markdown
  // div — padding inside the rounded bubble made the old locator look >8px away.
  const botFrame = botRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await botRail.boundingBox();
      const frameBox = await botFrame.boundingBox();
      if (!railBox || !frameBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const frameMid = frameBox.y + frameBox.height / 2;
      return {
        beside: railBox.x >= frameBox.x + frameBox.width - 2,
        flush: railBox.x - (frameBox.x + frameBox.width) < 8,
        centered: Math.abs(railMid - frameMid) <= 12,
        notBelow: railBox.y + railBox.height <= frameBox.y + frameBox.height + 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });
  await captureScreenshot(page, testInfo, "message-bot-actions-desktop");
  await clearHoverRail(botRail);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(parentText);
  await composer.press("Enter");

  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  const rail = await revealHoverRail(parentRow);
  const toolbar = parentRow.getByTestId("message-hover-actions");
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "More" })).toBeVisible();
  const thumbsUp = toolbar.getByRole("button", { name: "Add thumbs-up" });
  await expect(thumbsUp).toBeVisible();
  // Default smile matches reply/more: muted gray, not yellow.
  await expect
    .poll(async () => thumbsUp.evaluate((el) => getComputedStyle(el).color))
    .not.toMatch(/255,\s*2(0[0-9]|1[0-9]|2[0-9]|3[0-5])/); // not yellow-ish rgb

  // User bubble (right): icons sit to the left, vertically centered — not under the bubble.
  const frame = parentRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const frameBox = await frame.boundingBox();
      if (!railBox || !frameBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const frameMid = frameBox.y + frameBox.height / 2;
      return {
        beside: railBox.x + railBox.width <= frameBox.x + 2,
        flush: frameBox.x - (railBox.x + railBox.width) < 8,
        centered: Math.abs(railMid - frameMid) <= 12,
        notBelow: railBox.y >= frameBox.y - 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });

  // Long user bubble: rail stays ~6px beside the bubble edge, not the full row width.
  const longText = `hover-long-${stamp}-${"x".repeat(220)}`;
  await composer.fill(longText);
  await composer.press("Enter");
  const longRow = transcript
    .locator(`[data-message-id]`)
    .filter({ hasText: longText.slice(0, 40) })
    .first();
  await expect(longRow).toBeVisible({ timeout: 20_000 });
  const longRail = await revealHoverRail(longRow);
  const longFrame = longRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await longRail.boundingBox();
      const frameBox = await longFrame.boundingBox();
      if (!railBox || !frameBox) return null;
      return Math.abs(frameBox.x - (railBox.x + railBox.width));
    })
    .toBeLessThan(8);
  await clearHoverRail(longRail);

  // No transcript timestamp under the bubble (Grok Bot). Time lives in More.
  await expect(parentRow.getByTestId("message-hover-time")).toHaveCount(0);
  await revealHoverRail(parentRow);
  await toolbar.getByRole("button", { name: "More" }).click();
  const moreTime = parentRow.getByTestId("message-hover-time");
  await expect(moreTime).toBeVisible();
  await expect(moreTime).toHaveText(/\d/);
  // Escape closes More and restores focus to the trigger so the rail stays up.
  await page.keyboard.press("Escape");
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();

  const railBox = await rail.boundingBox();
  const frameBox = await frame.boundingBox();
  if (!railBox || !frameBox) throw new Error("missing hover toolbar geometry");
  const pad = 16;
  const top = Math.min(railBox.y, frameBox.y);
  const clip = {
    x: Math.max(0, Math.min(railBox.x, frameBox.x) - pad),
    y: Math.max(0, top - pad),
    width:
      Math.max(railBox.x + railBox.width, frameBox.x + frameBox.width) -
      Math.min(railBox.x, frameBox.x) +
      pad * 2,
    height: Math.max(railBox.y + railBox.height, frameBox.y + frameBox.height) - top + pad * 2,
  };
  const hoverPath = testInfo.outputPath("message-hover-toolbar.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip,
    path: hoverPath,
  });
  await testInfo.attach("message-hover-toolbar", { contentType: "image/png", path: hoverPath });

  await thumbsUp.click();
  const reactionChip = parentRow
    .getByRole("button", { name: "Remove thumbs-up" })
    .filter({ hasText: "👍" });
  await expect(reactionChip).toBeVisible();
  await captureScreenshot(page, testInfo, "message-thumbs-up");

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "More" }).click();
  await toolbar.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "Reply" }).click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(/Replying to/);

  await composer.fill(replyText);
  await composer.press("Enter");
  await expect(replyChip).toHaveCount(0);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(parentText);
  await captureScreenshot(page, testInfo, "message-reply-thread");

  await parentPreview.click();
  await expect(parentRow).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await botRow.scrollIntoViewIfNeeded();
  const botRailMobile = await revealHoverRail(botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-mobile");
  await clearHoverRail(botRailMobile);
  await parentRow.scrollIntoViewIfNeeded();
  const userRailMobile = await revealHoverRail(parentRow);
  await captureScreenshot(page, testInfo, "message-user-actions-mobile");
  await clearHoverRail(userRailMobile);
});

test("reply preview jumps to parent outside the loaded page", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `hover-page-${stamp}@rakazo.test`, "password12", "Hover Page");
  await completeOnboarding(page);

  const parentText = `page-parent-${stamp}`;
  const replyText = `page-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill(parentText);
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });
  const parentId = await parentRow.getAttribute("data-message-id");
  expect(parentId).toBeTruthy();

  await parentRow.hover();
  await parentRow.getByRole("button", { name: "Reply" }).click();
  await composer.fill(replyText);
  await composer.press("Enter");

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  await expect(replyRow.getByTestId("reply-parent-preview")).toContainText(parentText);

  // Simulate a paginated snapshot where the parent is older than the loaded page.
  // Bootstrap and threads/get both hydrate the transcript on reload.
  const stripParent = (body: {
    json?: {
      messages?: Array<{ id: string }>;
      olderCursor?: number | null;
      thread?: { messages?: Array<{ id: string }>; olderCursor?: number | null };
    };
  }) => {
    if (body.json?.messages) {
      body.json.messages = body.json.messages.filter((message) => message.id !== parentId);
      body.json.olderCursor = body.json.olderCursor ?? 1;
    }
    if (body.json?.thread?.messages) {
      body.json.thread.messages = body.json.thread.messages.filter(
        (message) => message.id !== parentId,
      );
      body.json.thread.olderCursor = body.json.thread.olderCursor ?? 1;
    }
  };

  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Parameters<typeof stripParent>[0];
    stripParent(body);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Parameters<typeof stripParent>[0];
    stripParent(body);
    await route.fulfill({
      status: response.status(),
      headers: response.headers(),
      body: JSON.stringify(body),
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toHaveCount(0);
  const offlinePreview = page
    .locator(`[data-message-id]`)
    .filter({ hasText: replyText })
    .getByTestId("reply-parent-preview");
  await expect(offlinePreview).toBeVisible();
  await expect(offlinePreview).toHaveText("Earlier message");

  await page.unroute("**/rpc/bootstrap");
  await page.unroute("**/rpc/threads/get");
  await offlinePreview.click();
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`[data-message-id="${parentId}"]`)).toContainText(parentText);
});
