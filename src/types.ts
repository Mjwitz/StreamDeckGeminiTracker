import type { JsonObject, JsonValue } from "@elgato/utils";

export interface QuotaBucket {
  bucketId: string;
  displayName: string;
  remainingFraction: number; // 0.0 to 1.0
  percentage: number; // 0 to 100
  resetTime: string | null;
  window: "FIVE_HOURS" | "WEEKLY" | "UNKNOWN";
}

export interface AntigravityQuotaSnapshot {
  gemini5h?: QuotaBucket;
  geminiWeekly?: QuotaBucket;
  claude5h?: QuotaBucket;
  claudeWeekly?: QuotaBucket;
  geminiArgonWeekly?: QuotaBucket;
  accountEmail?: string;
  planName?: string;
  lastUpdated: number;
  source: "local" | "cloud" | "demo" | "offline";
  errorMessage?: string;
}

export interface MetricDisplayData {
  title: string;
  subTitle: string;
  percentage: number;
  countdown: string;
  color: string;
  status: "ok" | "warning" | "critical" | "offline";
  rawResetTime?: string | null;
}

export type DisplayStyle = "radial" | "bar" | "compact";

export interface PluginSettings extends JsonObject {
  displayStyle?: DisplayStyle;
  showCountdown?: string | boolean;
  warningThreshold?: number;
  criticalThreshold?: number;
  dataSource?: "auto" | "cloud" | "demo";
  refreshInterval?: string | number;
  claudeWindow?: "auto" | "five-hour" | "weekly";
  authToken?: string;
  manualPort?: string | number;
  cycleInterval?: number;
  cycleIndex?: number;
  [key: string]: JsonValue | undefined;
}
