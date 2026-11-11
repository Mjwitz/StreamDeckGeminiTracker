import { exec } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AntigravityQuotaSnapshot, QuotaBucket, PluginSettings } from "../types.js";

const execAsync = promisify(exec);

interface LocalProbeTarget {
  port: number;
  csrfToken: string;
}

export class QuotaService {
  private static instance: QuotaService;
  private cachedSnapshot: AntigravityQuotaSnapshot | null = null;
  private inFlightPromise: Promise<AntigravityQuotaSnapshot> | null = null;
  private lastFetchTime = 0;
  private cacheTtlMs = 15000; // 15-second minimum cache across multiple keys

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  /**
   * Fetches latest quota snapshot with deduping and caching.
   */
  public async getQuota(settings: PluginSettings, forceRefresh = false): Promise<AntigravityQuotaSnapshot> {
    const now = Date.now();
    if (!forceRefresh && this.cachedSnapshot && (now - this.lastFetchTime) < this.cacheTtlMs) {
      return this.cachedSnapshot;
    }

    if (this.inFlightPromise) {
      return this.inFlightPromise;
    }

    this.inFlightPromise = this.fetchInternal(settings)
      .then((snapshot) => {
        this.cachedSnapshot = snapshot;
        this.lastFetchTime = Date.now();
        this.inFlightPromise = null;
        return snapshot;
      })
      .catch((err) => {
        this.inFlightPromise = null;
        const fallback = this.cachedSnapshot || this.createOfflineSnapshot(String(err?.message || err));
        return fallback;
      });

    return this.inFlightPromise;
  }

  private async fetchInternal(settings: PluginSettings): Promise<AntigravityQuotaSnapshot> {
    const dataSource = settings.dataSource || "auto";

    if (dataSource === "demo") {
      return this.createDemoSnapshot();
    }

    if (dataSource === "cloud" && settings.authToken) {
      const cloudResult = await this.fetchFromCloudCode(settings.authToken.trim());
      if (cloudResult) return cloudResult;
    }

    // Auto mode: probe local language server first
    try {
      const localResult = await this.probeLocalLanguageServer(settings.manualPort);
      if (localResult) return localResult;
    } catch {
      // Fall through to file-based credentials or offline
    }

    // Try finding cached credentials from ~/.gemini
    try {
      const tokenFromFile = await this.readLocalAuthToken();
      if (tokenFromFile) {
        const cloudResult = await this.fetchFromCloudCode(tokenFromFile);
        if (cloudResult) return cloudResult;
      }
    } catch {
      // Fall through
    }

    // If manual auth token is provided
    if (settings.authToken) {
      const cloudResult = await this.fetchFromCloudCode(settings.authToken.trim());
      if (cloudResult) return cloudResult;
    }

    return this.createOfflineSnapshot("Antigravity Language Server not detected");
  }

  /**
   * Probes local Antigravity Language Server
   */
  private async probeLocalLanguageServer(manualPort?: string | number): Promise<AntigravityQuotaSnapshot | null> {
    const targets: LocalProbeTarget[] = [];

    if (manualPort) {
      const p = parseInt(String(manualPort), 10);
      if (!isNaN(p)) {
        targets.push({ port: p, csrfToken: "" });
      }
    }

    // Discover process parameters
    try {
      const detected = await this.detectLocalProcesses();
      for (const d of detected) {
        targets.push(d);
      }
    } catch {
      // continue
    }

    for (const target of targets) {
      // Try RetrieveUserQuotaSummary
      const snapshot = await this.queryLocalEndpoint(target.port, target.csrfToken);
      if (snapshot) {
        return snapshot;
      }
    }

    return null;
  }

  private async detectLocalProcesses(): Promise<LocalProbeTarget[]> {
    const isWin = process.platform === "win32";
    const targets: LocalProbeTarget[] = [];

    let cmdOutput = "";
    try {
      if (isWin) {
        // Windows: query powershell for commandline of language_server or agy
        const { stdout } = await execAsync(
          `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*language_server*' -or $_.Name -like '*agy*' } | Select-Object -ExpandProperty CommandLine"`,
          { timeout: 4000 }
        );
        cmdOutput = stdout;
      } else {
        // Linux / macOS
        const { stdout } = await execAsync(`ps -eo pid,args | grep -E "language_server|agy" | grep -v grep`, {
          timeout: 4000
        });
        cmdOutput = stdout;
      }
    } catch {
      return targets;
    }

    const lines = cmdOutput.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;

      // Extract CSRF token
      let csrfToken = "";
      const csrfMatch = line.match(/(?:--csrf_token|-csrf_token)[=\s]+([a-zA-Z0-9_-]+)/);
      if (csrfMatch) {
        csrfToken = csrfMatch[1];
      }

      // Extract extension server port
      let port = 0;
      const portMatch = line.match(/(?:--extension_server_port|-extension_server_port)[=\s]+(\d+)/);
      if (portMatch) {
        port = parseInt(portMatch[1], 10);
      }

      if (port > 0) {
        targets.push({ port, csrfToken });
        // Many language server instances expose Connect RPC on port, port + 1, or port - 1
        targets.push({ port: port + 1, csrfToken });
        targets.push({ port: port - 1, csrfToken });
      }
    }

    return targets;
  }

  private async queryLocalEndpoint(port: number, csrfToken: string): Promise<AntigravityQuotaSnapshot | null> {
    const endpoints = [
      `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary`,
      `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/GetUserStatus`
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 2000);

        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1"
        };
        if (csrfToken) {
          headers["X-Codeium-Csrf-Token"] = csrfToken;
        }

        const resp = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify({}),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) continue;

        const json = await resp.json();
        const parsed = this.parseQuotaResponse(json, "local");
        if (parsed) return parsed;
      } catch {
        // try next endpoint
      }
    }

    return null;
  }

  /**
   * Calls Google Cloud Code PA endpoint using OAuth access token
   */
  private async fetchFromCloudCode(token: string): Promise<AntigravityQuotaSnapshot | null> {
    const hosts = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
    ];

    for (const url of hosts) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/hub/2.24.0"
          },
          body: JSON.stringify({}),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!resp.ok) continue;

        const json = await resp.json();
        const parsed = this.parseQuotaResponse(json, "cloud");
        if (parsed) return parsed;
      } catch {
        // next host
      }
    }
    return null;
  }

  /**
   * Reads auth token from local ~/.gemini/ configuration files if available
   */
  private async readLocalAuthToken(): Promise<string | null> {
    const homeDir = os.homedir();
    const candidatePaths = [
      path.join(homeDir, ".gemini", "antigravity-cli", "auth.json"),
      path.join(homeDir, ".gemini", "oauth_creds.json"),
      path.join(homeDir, ".config", "gemini", "oauth_creds.json")
    ];

    for (const p of candidatePaths) {
      try {
        if (!fs.existsSync(p)) continue;
        const raw = fs.readFileSync(p, "utf-8");
        const data = JSON.parse(raw);
        if (data.access_token) return data.access_token;
        if (data.token) return data.token;
        if (data.credentials?.access_token) return data.credentials.access_token;
      } catch {
        // continue
      }
    }
    return null;
  }

  /**
   * Parses the JSON payload from RetrieveUserQuotaSummary or GetUserStatus
   */
  public parseQuotaResponse(data: any, source: "local" | "cloud"): AntigravityQuotaSnapshot | null {
    if (!data) return null;

    const snapshot: AntigravityQuotaSnapshot = {
      lastUpdated: Date.now(),
      source
    };

    // Case 1: RetrieveUserQuotaSummary format
    // Payload may be directly root or wrapped in `userQuota` or `response`
    const quotaData = data.userQuota || data.response || data;
    const groups = quotaData.groups || [];

    for (const group of groups) {
      const groupName = (group.displayName || group.name || "").toLowerCase();
      const buckets = group.buckets || [];

      for (const bucket of buckets) {
        const bucketId = (bucket.bucketId || bucket.id || "").toLowerCase();
        const fraction = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : 1.0;
        const pct = Math.round(fraction * 100);
        const resetTime = bucket.resetTime || bucket.nextResetTime || null;
        const windowType = (bucket.window || "").toUpperCase();

        const b: QuotaBucket = {
          bucketId: bucket.bucketId || "",
          displayName: bucket.displayName || group.displayName || "",
          remainingFraction: fraction,
          percentage: pct,
          resetTime,
          window: windowType.includes("FIVE") || bucketId.includes("5h") ? "FIVE_HOURS" : "WEEKLY"
        };

        // Classify bucket
        if (groupName.includes("argon") || bucketId.includes("argon")) {
          snapshot.geminiArgonWeekly = b;
        } else if (groupName.includes("claude") || groupName.includes("gpt") || bucketId.includes("3p")) {
          if (b.window === "FIVE_HOURS") {
            snapshot.claude5h = b;
          } else {
            snapshot.claudeWeekly = b;
          }
        } else {
          // Gemini models
          if (b.window === "FIVE_HOURS") {
            snapshot.gemini5h = b;
          } else {
            snapshot.geminiWeekly = b;
          }
        }
      }
    }

    // Case 2: GetUserStatus fallback
    if (!snapshot.gemini5h && !snapshot.geminiWeekly && data.userStatus) {
      const configs = data.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
      for (const cfg of configs) {
        const model = (cfg.model || "").toLowerCase();
        const quotaInfo = cfg.quotaInfo;
        if (!quotaInfo) continue;

        const fraction = typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : 1.0;
        const b: QuotaBucket = {
          bucketId: model,
          displayName: cfg.displayName || model,
          remainingFraction: fraction,
          percentage: Math.round(fraction * 100),
          resetTime: quotaInfo.resetTime || null,
          window: "FIVE_HOURS"
        };

        if (model.includes("argon")) {
          snapshot.geminiArgonWeekly = b;
        } else if (model.includes("claude") || model.includes("gpt")) {
          snapshot.claude5h = b;
        } else if (model.includes("gemini")) {
          snapshot.gemini5h = b;
        }
      }
    }

    return snapshot;
  }

  public createDemoSnapshot(): AntigravityQuotaSnapshot {
    const now = new Date();

    // 5-hour reset in 2 hours 15 mins
    const reset5h = new Date(now.getTime() + (2 * 60 + 15) * 60 * 1000).toISOString();
    // Weekly reset in 4 days 8 hours
    const resetWeekly = new Date(now.getTime() + (4 * 24 + 8) * 60 * 60 * 1000).toISOString();

    return {
      gemini5h: {
        bucketId: "gemini-5h",
        displayName: "Gemini 5-Hour Session",
        remainingFraction: 0.88,
        percentage: 88,
        resetTime: reset5h,
        window: "FIVE_HOURS"
      },
      geminiWeekly: {
        bucketId: "gemini-weekly",
        displayName: "Gemini Weekly Limit",
        remainingFraction: 0.65,
        percentage: 65,
        resetTime: resetWeekly,
        window: "WEEKLY"
      },
      claude5h: {
        bucketId: "3p-5h",
        displayName: "Claude & GPT 5-Hour",
        remainingFraction: 0.74,
        percentage: 74,
        resetTime: reset5h,
        window: "FIVE_HOURS"
      },
      claudeWeekly: {
        bucketId: "3p-weekly",
        displayName: "Claude & GPT Weekly",
        remainingFraction: 0.42,
        percentage: 42,
        resetTime: resetWeekly,
        window: "WEEKLY"
      },
      geminiArgonWeekly: {
        bucketId: "gemini-argon-wtu-weekly",
        displayName: "Gemini 4 Argon Weekly",
        remainingFraction: 0.92,
        percentage: 92,
        resetTime: resetWeekly,
        window: "WEEKLY"
      },
      accountEmail: "demo-user@antigravity.ai",
      planName: "Google AI Pro / Ultra",
      lastUpdated: Date.now(),
      source: "demo"
    };
  }

  public createOfflineSnapshot(message: string): AntigravityQuotaSnapshot {
    return {
      lastUpdated: Date.now(),
      source: "offline",
      errorMessage: message
    };
  }
}
