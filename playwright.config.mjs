import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.mjs",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 8_000
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  outputDir: "test-results/e2e",
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  }
});
