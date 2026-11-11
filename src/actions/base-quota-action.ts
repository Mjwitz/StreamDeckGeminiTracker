import {
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
  type KeyDownEvent,
  type DialDownEvent,
  type DidReceiveSettingsEvent,
  type Action
} from "@elgato/streamdeck";
import { QuotaService } from "../services/quota-service.js";
import { generateKeyImage } from "../services/image-generator.js";
import { formatResetCountdown } from "../services/time-utils.js";
import {
  PluginSettings,
  AntigravityQuotaSnapshot,
  MetricDisplayData,
  QuotaBucket
} from "../types.js";

export abstract class BaseQuotaAction extends SingletonAction<PluginSettings> {
  protected quotaService = QuotaService.getInstance();
  private timers = new Map<string, NodeJS.Timeout>();

  /**
   * Subclasses define which metric to extract from the snapshot.
   */
  protected abstract getMetricData(
    snapshot: AntigravityQuotaSnapshot,
    settings: PluginSettings
  ): MetricDisplayData;

  override async onWillAppear(ev: WillAppearEvent<PluginSettings>): Promise<void> {
    await this.updateActionDisplay(ev.action);
    this.startPolling(ev.action);
  }

  override onWillDisappear(ev: WillDisappearEvent<PluginSettings>): void {
    this.stopPolling(ev.action.id);
  }

  override async onKeyDown(ev: KeyDownEvent<PluginSettings>): Promise<void> {
    // Immediate force refresh
    await this.updateActionDisplay(ev.action, true);
    if (ev.action.isKey()) {
      await ev.action.showOk();
    }
  }

  override async onDialDown(ev: DialDownEvent<PluginSettings>): Promise<void> {
    await this.updateActionDisplay(ev.action, true);
  }

  override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<PluginSettings>): Promise<void> {
    await this.updateActionDisplay(ev.action);
    this.startPolling(ev.action);
  }

  protected async updateActionDisplay(action: Action<PluginSettings>, forceRefresh = false): Promise<void> {
    try {
      const settings = (await action.getSettings()) || {};
      const snapshot = await this.quotaService.getQuota(settings, forceRefresh);
      const metric = this.getMetricData(snapshot, settings);

      const style = settings.displayStyle || "radial";
      const showCountdown = settings.showCountdown !== "false" && settings.showCountdown !== false;

      // Update Keypad / Dial canvas image
      const imageUri = generateKeyImage(metric, style, showCountdown);
      if (action.isKey() || action.isDial()) {
        await action.setImage(imageUri);
      }

      // If encoder / dial (Stream Deck +)
      if (action.isDial()) {
        await action.setFeedback({
          title: metric.title,
          value: metric.status === "offline" ? "--" : `${Math.round(metric.percentage)}%`,
          indicator: metric.status === "offline" ? 0 : Math.round(metric.percentage)
        });
      }
    } catch {
      // Ignore transient errors
    }
  }

  private startPolling(action: Action<PluginSettings>): void {
    this.stopPolling(action.id);

    action.getSettings().then((settings) => {
      const intervalSecs = parseInt(String(settings?.refreshInterval || "60"), 10) || 60;
      const ms = Math.max(10, intervalSecs) * 1000;

      const timer = setInterval(() => {
        this.updateActionDisplay(action, false);
      }, ms);

      this.timers.set(action.id, timer);
    });
  }

  private stopPolling(actionId: string): void {
    const existing = this.timers.get(actionId);
    if (existing) {
      clearInterval(existing);
      this.timers.delete(actionId);
    }
  }

  /**
   * Utility to compute status and color from percentage and thresholds
   */
  protected resolveStatus(
    percentage: number,
    settings: PluginSettings,
    defaultColor = "#38bdf8"
  ): { color: string; status: "ok" | "warning" | "critical" } {
    const warning = typeof settings.warningThreshold === "number" ? settings.warningThreshold : 50;
    const critical = typeof settings.criticalThreshold === "number" ? settings.criticalThreshold : 20;

    if (percentage <= critical) {
      return { color: "#ef4444", status: "critical" }; // Red
    }
    if (percentage <= warning) {
      return { color: "#f59e0b", status: "warning" }; // Amber
    }
    return { color: defaultColor, status: "ok" };
  }

  protected createMetricFromBucket(
    bucket: QuotaBucket | undefined,
    title: string,
    subTitle: string,
    settings: PluginSettings,
    defaultColor = "#38bdf8"
  ): MetricDisplayData {
    if (!bucket) {
      return {
        title,
        subTitle,
        percentage: 0,
        countdown: "WAITING",
        color: "#94a3b8",
        status: "offline"
      };
    }

    const { color, status } = this.resolveStatus(bucket.percentage, settings, defaultColor);
    const countdown = formatResetCountdown(bucket.resetTime, bucket.remainingFraction);

    return {
      title,
      subTitle,
      percentage: bucket.percentage,
      countdown,
      color,
      status,
      rawResetTime: bucket.resetTime
    };
  }
}
