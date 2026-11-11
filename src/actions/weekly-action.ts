import { action } from "@elgato/streamdeck";
import { BaseQuotaAction } from "./base-quota-action.js";
import { AntigravityQuotaSnapshot, PluginSettings, MetricDisplayData } from "../types.js";

@action({ UUID: "com.mjwitz.gemini-tracker.weekly" })
export class GeminiWeeklyAction extends BaseQuotaAction {
  protected getMetricData(snapshot: AntigravityQuotaSnapshot, settings: PluginSettings): MetricDisplayData {
    if (snapshot.source === "offline") {
      return {
        title: "GEMINI WK",
        subTitle: "OFFLINE",
        percentage: 0,
        countdown: "OFFLINE",
        color: "#94a3b8",
        status: "offline"
      };
    }

    return this.createMetricFromBucket(
      snapshot.geminiWeekly,
      "GEMINI WK",
      "Weekly Limit",
      settings,
      "#38bdf8" // Cyan / Gemini blue
    );
  }
}
