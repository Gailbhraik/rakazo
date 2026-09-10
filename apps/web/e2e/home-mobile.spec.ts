import { expect, test } from "@playwright/test";

// Fixtures stay in the browser: no real account, credentials or billing calls.
test("mobile home shows credits, navigation and provider failures", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/api/auth/get-session**", (route) =>
    route.fulfill({
      json: {
        user: { id: "test-user", name: "Camille", email: "camille@example.test" },
        session: { id: "test-session", userId: "test-user", expiresAt: "2099-01-01T00:00:00Z" },
      },
    }),
  );
  await page.route("**/rpc/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/models/recent"))
      return route.fulfill({
        json: {
          json: {
            fetchedAt: "2026-09-10T10:00:00Z",
            stale: false,
            models: [
              {
                id: "example/test",
                name: "Nouveau modèle test",
                created: 1789034400,
                description: "Modèle fictif pour vérifier le rendu.",
                context: 1000000,
                maxOutput: 64000,
                inputPrice: 0.3,
                outputPrice: 1.2,
                cachePrice: 0.006,
                modalities: ["text", "image"],
                tools: true,
                reasoning: true,
                variablePricing: false,
              },
            ],
          },
        },
      });
    const data = path.endsWith("/usage/balances")
      ? [
          {
            provider: "openrouter",
            status: "available",
            amounts: [{ currency: "USD", remaining: 12.5, scope: "account" }],
            checkedAt: "2026-09-10T10:00:00Z",
          },
          {
            provider: "deepseek",
            status: "unavailable",
            amounts: [],
            checkedAt: "2026-09-10T10:00:00Z",
          },
        ]
      : [];
    return route.fulfill({ json: { json: data } });
  });
  let weatherCalls = 0;
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 48.8566, longitude: 2.3522 });
  await page.route("https://api.open-meteo.com/**", (route) => {
    weatherCalls++;
    const url = new URL(route.request().url());
    expect(url.searchParams.get("latitude")).toBe("48.86");
    expect(url.searchParams.get("longitude")).toBe("2.35");
    return route.fulfill({
      json: {
        current: {
          temperature_2m: 21,
          apparent_temperature: 20,
          weather_code: 2,
          wind_speed_10m: 12,
          time: "2026-09-10T14:00",
        },
      },
    });
  });
  await page.goto("/app");
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "Crédits API" })).toBeVisible();
  expect(weatherCalls).toBe(0);
  await page.getByRole("button", { name: "Utiliser ma position" }).click();
  await expect(page.getByRole("region", { name: "Météo locale" })).toContainText("21 °C");
  expect(weatherCalls).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("weather-mobile.png"), fullPage: true });
  await expect(page.getByText("Solde du compte fournisseur", { exact: true })).toBeVisible();
  await expect(page.getByText(/Le solde n’est pas accessible/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Modèles favoris/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(page.getByRole("heading", { name: "Nouveautés OpenRouter" })).toHaveCount(0);
  await page.getByRole("link", { name: "Nouveautés OpenRouter" }).click();
  await expect(page).toHaveURL(/\/models\/new$/);
  await expect(page.getByRole("heading", { name: "Nouveautés OpenRouter" })).toBeVisible();
  await page.getByText("Coût estimé et détails", { exact: true }).click();
  await expect(page.getByText(/10 000 tokens en entrée/)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("home-mobile.png"), fullPage: true });
  await testInfo.attach("home-mobile", {
    path: testInfo.outputPath("home-mobile.png"),
    contentType: "image/png",
  });
  await page.getByRole("link", { name: "← Accueil" }).click();
  await expect(page).toHaveURL(/\/home$/);
  await page.getByRole("button", { name: /Modèles favoris/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});
