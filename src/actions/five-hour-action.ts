import { action } from "@elgato/streamdeck";
import { BaseQuotaAction } from "./base-quota-action.js";
import { AntigravityQuotaSnapshot, PluginSettings, MetricDisplayData } from "../types.js";

@action({ UUID: "com.mjwitz.gemini-tracker.five-hour" })
export class GeminiFiveHourAction extends BaseQuotaAction {
  protected getMetricData(snapshot: AntigravityQuotaSnapshot, settings: PluginSettings): MetricDisplayData {
    if (snapshot.source === "offline") {
      return {
        title: "GEMINI 5H",
        subTitle: "OFFLINE",
        percentage: 0,
        countdown: "OFFLINE",
        color: "#94a3b8",
        status: "offline"
      };
    }

    return this.createMetricFromBucket(
      snapshot.gemini5h,
      "GEMINI 5H",
      "5-Hour Window",
      settings,
      "#10b981" // Emerald / Green
    );
  }
}
