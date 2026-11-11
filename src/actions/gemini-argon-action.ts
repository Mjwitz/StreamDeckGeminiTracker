import { action } from "@elgato/streamdeck";
import { BaseQuotaAction } from "./base-quota-action.js";
import { AntigravityQuotaSnapshot, PluginSettings, MetricDisplayData } from "../types.js";

@action({ UUID: "com.mjwitz.gemini-tracker.gemini-argon" })
export class GeminiArgonAction extends BaseQuotaAction {
  protected getMetricData(snapshot: AntigravityQuotaSnapshot, settings: PluginSettings): MetricDisplayData {
    if (snapshot.source === "offline") {
      return {
        title: "ARGON 4",
        subTitle: "OFFLINE",
        percentage: 0,
        countdown: "OFFLINE",
        color: "#94a3b8",
        status: "offline"
      };
    }

    return this.createMetricFromBucket(
      snapshot.geminiArgonWeekly,
      "ARGON 4",
      "Reasoning Limit",
      settings,
      "#a855f7" // Purple / Cosmic Argon
    );
  }
}
