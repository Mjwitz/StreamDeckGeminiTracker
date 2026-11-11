import { action, type KeyDownEvent, type DialRotateEvent } from "@elgato/streamdeck";
import { BaseQuotaAction } from "./base-quota-action.js";
import { AntigravityQuotaSnapshot, PluginSettings, MetricDisplayData } from "../types.js";

interface CycleActionSettings extends PluginSettings {
  cycleIndex?: number;
}

@action({ UUID: "com.mjwitz.gemini-tracker.cycle" })
export class MultiMetricCycleAction extends BaseQuotaAction {
  private activeIndices = new Map<string, number>();

  protected getMetricData(snapshot: AntigravityQuotaSnapshot, settings: CycleActionSettings): MetricDisplayData {
    if (snapshot.source === "offline") {
      return {
        title: "ANTIGRAVITY",
        subTitle: "OFFLINE",
        percentage: 0,
        countdown: "OFFLINE",
        color: "#94a3b8",
        status: "offline"
      };
    }

    const availableMetrics: MetricDisplayData[] = [];

    if (snapshot.gemini5h) {
      availableMetrics.push(
        this.createMetricFromBucket(snapshot.gemini5h, "GEMINI 5H", "5h Rolling", settings, "#10b981")
      );
    }
    if (snapshot.geminiWeekly) {
      availableMetrics.push(
        this.createMetricFromBucket(snapshot.geminiWeekly, "GEMINI WK", "Weekly Quota", settings, "#38bdf8")
      );
    }
    if (snapshot.claude5h || snapshot.claudeWeekly) {
      const b = snapshot.claudeWeekly || snapshot.claude5h;
      availableMetrics.push(
        this.createMetricFromBucket(b, "CLAUDE/GPT", "Claude & GPT", settings, "#f97316")
      );
    }
    if (snapshot.geminiArgonWeekly) {
      availableMetrics.push(
        this.createMetricFromBucket(snapshot.geminiArgonWeekly, "ARGON 4", "Reasoning Quota", settings, "#a855f7")
      );
    }

    if (availableMetrics.length === 0) {
      return {
        title: "ANTIGRAVITY",
        subTitle: "NO DATA",
        percentage: 0,
        countdown: "WAITING",
        color: "#94a3b8",
        status: "offline"
      };
    }

    const idx = (settings.cycleIndex || 0) % availableMetrics.length;
    return availableMetrics[idx];
  }

  override async onKeyDown(ev: KeyDownEvent<CycleActionSettings>): Promise<void> {
    const settings = (await ev.action.getSettings()) || {};
    const currentIndex = settings.cycleIndex || 0;
    // Total 4 metric types
    const nextIndex = (currentIndex + 1) % 4;

    await ev.action.setSettings({ ...settings, cycleIndex: nextIndex });
    await this.updateActionDisplay(ev.action, false);
  }

  override async onDialRotate(ev: DialRotateEvent<CycleActionSettings>): Promise<void> {
    const settings = (await ev.action.getSettings()) || {};
    const currentIndex = settings.cycleIndex || 0;
    const delta = ev.payload.ticks > 0 ? 1 : -1;
    const nextIndex = (currentIndex + delta + 4) % 4;

    await ev.action.setSettings({ ...settings, cycleIndex: nextIndex });
    await this.updateActionDisplay(ev.action, false);
  }
}
