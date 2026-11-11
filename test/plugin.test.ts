import test from "node:test";
import assert from "node:assert/strict";
import { formatResetCountdown } from "../src/services/time-utils.js";
import { generateKeyImage } from "../src/services/image-generator.js";
import { QuotaService } from "../src/services/quota-service.js";

test("formatResetCountdown formats hours and minutes", () => {
  const inTwoHours = new Date(Date.now() + (2 * 60 + 30) * 60 * 1000).toISOString();
  const formatted = formatResetCountdown(inTwoHours, 0.75);
  assert.equal(formatted, "2h 30m");
});

test("formatResetCountdown formats days and hours", () => {
  const inThreeDays = new Date(Date.now() + (3 * 24 + 5) * 60 * 60 * 1000).toISOString();
  const formatted = formatResetCountdown(inThreeDays, 0.50);
  assert.equal(formatted, "3d 5h");
});

test("formatResetCountdown returns 100% when full", () => {
  const future = new Date(Date.now() + 100000).toISOString();
  const formatted = formatResetCountdown(future, 1.0);
  assert.equal(formatted, "100%");
});

test("formatResetCountdown returns READY when elapsed", () => {
  const past = new Date(Date.now() - 5000).toISOString();
  const formatted = formatResetCountdown(past, 0.2);
  assert.equal(formatted, "READY");
});

test("generateKeyImage returns valid data URI", () => {
  const img = generateKeyImage(
    {
      title: "GEMINI 5H",
      subTitle: "5-Hour Window",
      percentage: 85,
      countdown: "2h 15m",
      color: "#10b981",
      status: "ok"
    },
    "radial",
    true
  );

  assert.ok(img.startsWith("data:image/svg+xml;base64,"));
  const decoded = Buffer.from(img.replace("data:image/svg+xml;base64,", ""), "base64").toString("utf-8");
  assert.ok(decoded.includes("<svg"));
  assert.ok(decoded.includes("GEMINI 5H"));
  assert.ok(decoded.includes("85%"));
  assert.ok(decoded.includes("2h 15m"));
});

test("QuotaService parseQuotaResponse parses RetrieveUserQuotaSummary structure", () => {
  const samplePayload = {
    userQuota: {
      groups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-5h",
              displayName: "5-Hour Limit",
              remainingFraction: 0.92,
              resetTime: "2026-11-12T02:00:00Z",
              window: "FIVE_HOURS"
            },
            {
              bucketId: "gemini-weekly",
              displayName: "Weekly Limit",
              remainingFraction: 0.70,
              resetTime: "2026-11-18T00:00:00Z",
              window: "WEEKLY"
            }
          ]
        },
        {
          displayName: "Claude and GPT models",
          buckets: [
            {
              bucketId: "3p-5h",
              displayName: "Claude 5-Hour",
              remainingFraction: 0.80,
              resetTime: "2026-11-12T02:00:00Z",
              window: "FIVE_HOURS"
            },
            {
              bucketId: "3p-weekly",
              displayName: "Claude Weekly",
              remainingFraction: 0.55,
              resetTime: "2026-11-18T00:00:00Z",
              window: "WEEKLY"
            }
          ]
        },
        {
          displayName: "Gemini 4 Argon",
          buckets: [
            {
              bucketId: "gemini-argon-wtu-weekly",
              displayName: "Gemini 4 Argon Weekly",
              remainingFraction: 0.95,
              resetTime: "2026-11-18T00:00:00Z",
              window: "WEEKLY"
            }
          ]
        }
      ]
    }
  };

  const service = QuotaService.getInstance();
  const snapshot = service.parseQuotaResponse(samplePayload, "local");

  assert.ok(snapshot);
  assert.equal(snapshot.gemini5h?.percentage, 92);
  assert.equal(snapshot.geminiWeekly?.percentage, 70);
  assert.equal(snapshot.claude5h?.percentage, 80);
  assert.equal(snapshot.claudeWeekly?.percentage, 55);
  assert.equal(snapshot.geminiArgonWeekly?.percentage, 95);
});

test("QuotaService createDemoSnapshot returns all 4 key quotas", () => {
  const service = QuotaService.getInstance();
  const demo = service.createDemoSnapshot();

  assert.ok(demo.gemini5h);
  assert.ok(demo.geminiWeekly);
  assert.ok(demo.claude5h);
  assert.ok(demo.claudeWeekly);
  assert.ok(demo.geminiArgonWeekly);
  assert.equal(demo.source, "demo");
});

test("QuotaService parses Connect RPC response wrapper with missing remainingFraction", () => {
  const payload = {
    response: {
      groups: [
        {
          name: "Gemini Pro / Flash",
          buckets: [
            {
              bucketId: "gemini-5h",
              window: "FIVE_HOURS",
              // remainingFraction omitted because it is 0 in proto3
              description: "You have reached your 5-hour limit",
              resetTime: "2026-11-12T04:00:00Z"
            }
          ]
        },
        {
          name: "Claude Sonnet 3.5",
          buckets: [
            {
              bucketId: "3p-weekly",
              window: "WEEKLY",
              remainingFraction: 0.15,
              resetTime: "2026-11-19T00:00:00Z"
            }
          ]
        }
      ]
    }
  };

  const service = QuotaService.getInstance();
  const snapshot = service.parseQuotaResponse(payload, "local");
  assert.ok(snapshot);
  assert.equal(snapshot.gemini5h?.percentage, 0);
  assert.equal(snapshot.claudeWeekly?.percentage, 15);
});

test("QuotaService parses GetUserStatus clientModelConfigs quotaInfo format", () => {
  const payload = {
    userStatus: {
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            model: "gemini-2.5-pro",
            displayName: "Gemini 2.5 Pro",
            quotaInfo: {
              remainingFraction: 0.85,
              resetTime: "2026-11-12T05:00:00Z"
            }
          },
          {
            model: "claude-3-5-sonnet",
            displayName: "Claude 3.5 Sonnet",
            quotaInfo: {
              remainingFraction: 0.40,
              resetTime: "2026-11-12T05:00:00Z"
            }
          },
          {
            model: "gemini-4-argon",
            displayName: "Gemini 4 Argon",
            quotaInfo: {
              remainingFraction: 0.90,
              resetTime: "2026-11-18T00:00:00Z"
            }
          }
        ]
      }
    }
  };

  const service = QuotaService.getInstance();
  const snapshot = service.parseQuotaResponse(payload, "local");
  assert.ok(snapshot);
  assert.equal(snapshot.gemini5h?.percentage, 85);
  assert.equal(snapshot.claude5h?.percentage, 40);
  assert.equal(snapshot.geminiArgonWeekly?.percentage, 90);
});

test("QuotaService returns null for unrelated payload", () => {
  const service = QuotaService.getInstance();
  assert.equal(service.parseQuotaResponse({}, "local"), null);
  assert.equal(service.parseQuotaResponse({ status: "ok" }, "local"), null);
  assert.equal(service.parseQuotaResponse(null, "local"), null);
});

