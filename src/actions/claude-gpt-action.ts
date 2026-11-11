import { action, type DialRotateEvent } from "@elgato/streamdeck";
import { BaseQuotaAction } from "./base-quota-action.js";
import { AntigravityQuotaSnapshot, PluginSettings, MetricDisplayData } from "../types.js";

@action({ UUID: "com.mjwitz.gemini-tracker.claude-gpt" })
export class ClaudeGptAction extends BaseQuotaAction {
  protected getMetricData(snapshot: AntigravityQuotaSnapshot, settings: PluginSettings): MetricDisplayData {
    if (snapshot.source === "offline") {
      return {
        title: "CLAUDE/GPT",
        subTitle: "OFFLINE",
        percentage: 0,
        countdown: "OFFLINE",
        color: "#94a3b8",
        status: "offline"
      };
    }

    const mode = settings.claudeWindow || "auto";
    const bucket5h = snapshot.claude5h;
    const bucketWeekly = snapshot.claudeWeekly;

    let targetBucket = bucket5h;
    let label = "CLAUDE 5H";

    if (mode === "weekly") {
      targetBucket = bucketWeekly || bucket5h;
      label = "CLAUDE WK";
    } else if (mode === "five-hour") {
      targetBucket = bucket5h || bucketWeekly;
      label = "CLAUDE 5H";
    } else {
      // Auto: show the bucket with lower remaining percentage to warn user
      if (bucket5h && bucketWeekly) {
        if (bucketWeekly.percentage < bucket5h.percentage) {
          targetBucket = bucketWeekly;
          label = "CLAUDE WK";
        } else {
          targetBucket = bucket5h;
          label = "CLAUDE 5H";
        }
      } else {
        targetBucket = bucket5h || bucketWeekly;
        label = targetBucket?.window === "WEEKLY" ? "CLAUDE WK" : "CLAUDE 5H";
      }
    }

    return this.createMetricFromBucket(
      targetBucket,
      label,
      targetBucket?.window === "WEEKLY" ? "Weekly Limit" : "5-Hour Limit",
      settings,
      "#f97316" // Orange / Claude Coral
    );
  }

  override async onDialRotate(ev: DialRotateEvent<PluginSettings>): Promise<void> {
    const settings = (await ev.action.getSettings()) || {};
    const current = settings.claudeWindow || "auto";
    let next: PluginSettings["claudeWindow"] = "auto";
    if (current === "auto") next = "five-hour";
    else if (current === "five-hour") next = "weekly";
    else next = "auto";

    await ev.action.setSettings({ ...settings, claudeWindow: next });
    await this.updateActionDisplay(ev.action, false);
  }
}
