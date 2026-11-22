import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AntigravityQuotaSnapshot, QuotaBucket, PluginSettings } from "../types.js";

const execFileAsync = promisify(execFile);

const RPC_PREFIX = "/exa.language_server_pb.LanguageServerService/";
const SUMMARY_METHOD = "RetrieveUserQuotaSummary";
const STATUS_METHOD = "GetUserStatus";

/** Minimal logger interface (compatible with streamDeck.logger and console). */
export interface QuotaLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  debug?(...args: unknown[]): void;
}

export interface DetectedProcess {
  pid: number;
  name: string;
  commandLine: string;
  csrfToken: string;
  extensionCsrfToken: string;
  argPorts: number[];
  usesStdinBridgeToken: boolean;
}

interface LocalProbeTarget {
  host: string;
  port: number;
  tokens: string[];
}

interface HttpResult {
  status: number;
  body: string;
}

type Slot = "gemini5h" | "geminiWeekly" | "claude5h" | "claudeWeekly" | "geminiArgonWeekly";

// Strip ANSI escape codes from CLI output
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

export class QuotaService {
  private static instance: QuotaService;
  private cachedSnapshot: AntigravityQuotaSnapshot | null = null;
  private inFlightPromise: Promise<AntigravityQuotaSnapshot> | null = null;
  private lastFetchTime = 0;
  private cacheTtlMs = 30000; // 30-second minimum cache across multiple keys
  private logger: QuotaLogger | null = null;
  private lastGoodTarget: { scheme: "https" | "http"; host: string; port: number; token: string; method: string } | null = null;
  private resolvedAgyBin: string | null = null;
  private cliBackoffUntil = 0;

  /** Human-readable trace of the most recent fetch (tokens redacted). */
  public lastDiagnostics: string[] = [];
  /** Raw JSON or text body of the last successful CLI/local/cloud response. */
  public lastRawResponse: unknown = null;

  public static getInstance(): QuotaService {
    if (!QuotaService.instance) {
      QuotaService.instance = new QuotaService();
    }
    return QuotaService.instance;
  }

  public setLogger(logger: QuotaLogger | null): void {
    this.logger = logger;
  }

  private diag(message: string): void {
    this.lastDiagnostics.push(message);
    try {
      this.logger?.info(`[quota] ${message}`);
    } catch {
      // ignore logger failures
    }
  }

  private static redact(token: string): string {
    if (!token) return "(none)";
    return token.length <= 4 ? "****" : `${token.slice(0, 4)}…`;
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

    if (forceRefresh) {
      this.cliBackoffUntil = 0;
    }

    this.lastDiagnostics = [];
    this.inFlightPromise = this.fetchInternal(settings, forceRefresh)
      .then((snapshot) => {
        // Don't let a transient offline result wipe out recent good data
        if (snapshot.source === "offline" && this.cachedSnapshot && this.cachedSnapshot.source !== "offline"
          && Date.now() - this.cachedSnapshot.lastUpdated < 5 * 60 * 1000) {
          this.inFlightPromise = null;
          return this.cachedSnapshot;
        }
        this.cachedSnapshot = snapshot;
        this.lastFetchTime = Date.now();
        this.inFlightPromise = null;
        return snapshot;
      })
      .catch((err) => {
        this.inFlightPromise = null;
        this.diag(`Unexpected error: ${String(err?.message || err)}`);
        const fallback = this.cachedSnapshot || this.createOfflineSnapshot(String(err?.message || err));
        return fallback;
      });

    return this.inFlightPromise;
  }

  private async fetchInternal(settings: PluginSettings, forceRefresh: boolean): Promise<AntigravityQuotaSnapshot> {
    const dataSource = settings.dataSource || "auto";

    if (dataSource === "demo") {
      return this.createDemoSnapshot();
    }

    if (dataSource === "cli") {
      const cliResult = await this.fetchFromAgyCli(settings.agyPath, forceRefresh);
      if (cliResult) return cliResult;
      return this.createOfflineSnapshot("Antigravity CLI (agy) failed or not installed");
    }

    if (dataSource === "cloud" && settings.authToken) {
      const cloudResult = await this.fetchFromCloudCode(settings.authToken.trim());
      if (cloudResult) return cloudResult;
    }

    // If user explicitly provided a manual port, probe local server first
    if (settings.manualPort) {
      try {
        const localResult = await this.probeLocalLanguageServer(settings.manualPort);
        if (localResult) return localResult;
      } catch (err: any) {
        this.diag(`Local probe failed: ${String(err?.message || err)}`);
      }
    }

    // Primary method (Antigravity 2.34+): official `agy -p /usage` CLI
    // Antigravity v2.34.0 removed --csrf_token from language_server args and
    // moved to one-time stdin/renderer bootstrap tokens, closing local RPC probing.
    let cliErrorHint = "";
    try {
      const cliResult = await this.fetchFromAgyCli(settings.agyPath, forceRefresh);
      if (cliResult) return cliResult;
    } catch (err: any) {
      cliErrorHint = String(err?.message || err);
      this.diag(`agy CLI failed: ${cliErrorHint}`);
    }

    // Legacy fallback: probe local language server (works on Antigravity < 2.34)
    if (!settings.manualPort) {
      try {
        const localResult = await this.probeLocalLanguageServer();
        if (localResult) return localResult;
      } catch (err: any) {
        this.diag(`Local probe failed: ${String(err?.message || err)}`);
      }
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
    if (settings.authToken && dataSource !== "cloud") {
      const cloudResult = await this.fetchFromCloudCode(settings.authToken.trim());
      if (cloudResult) return cloudResult;
    }

    const msg = cliErrorHint || "Install & sign in to agy CLI (Antigravity 2.34+ closed local RPC)";
    return this.createOfflineSnapshot(msg);
  }

  /**
   * Resolves the official Antigravity CLI (`agy`) binary path across Windows, macOS, and Linux.
   * Stream Deck runs plugins in a GUI daemon environment with a minimal PATH, so we check
   * standard install locations before falling back to PATH lookup.
   */
  public resolveAgyBinary(customPath?: string): string[] {
    const candidates: string[] = [];
    const add = (p: string) => {
      if (p && !candidates.includes(p)) candidates.push(p);
    };

    if (customPath && customPath.trim()) {
      add(customPath.trim().replace(/^"(.*)"$/, "$1"));
    }
    if (this.resolvedAgyBin) {
      add(this.resolvedAgyBin);
    }

    const home = os.homedir();
    if (process.platform === "win32") {
      const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
      const programFiles = process.env.ProgramFiles || "C:\\Program Files";
      const fileCandidates = [
        path.join(localAppData, "agy", "bin", "agy.exe"),
        path.join(localAppData, "Antigravity", "agy.exe"),
        path.join(localAppData, "Antigravity", "bin", "agy.exe"),
        path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
        path.join(localAppData, "Programs", "Antigravity", "resources", "app", "bin", "agy.cmd"),
        path.join(home, ".local", "bin", "agy.exe"),
        path.join(home, ".gemini", "antigravity", "bin", "agy.exe"),
        path.join(programFiles, "agy", "agy.exe"),
        path.join(programFiles, "Antigravity", "bin", "agy.exe")
      ];
      for (const p of fileCandidates) {
        if (fs.existsSync(p)) add(p);
      }
      add("agy.exe");
      add("agy");
    } else {
      const fileCandidates = [
        path.join(home, ".local", "bin", "agy"),
        path.join(home, ".gemini", "antigravity", "bin", "agy"),
        "/opt/homebrew/bin/agy",
        "/usr/local/bin/agy"
      ];
      for (const p of fileCandidates) {
        if (fs.existsSync(p)) add(p);
      }
      add("agy");
    }

    return candidates;
  }

  /**
   * Queries quota via the official Antigravity CLI: `agy -p "/usage" --print-timeout 45s`.
   * Works with Antigravity 2.34+ and even when the desktop app is closed.
   */
  public async fetchFromAgyCli(customPath?: string, forceRefresh = false): Promise<AntigravityQuotaSnapshot | null> {
    if (!forceRefresh && Date.now() < this.cliBackoffUntil) {
      const secsLeft = Math.ceil((this.cliBackoffUntil - Date.now()) / 1000);
      this.diag(`Skipping agy CLI due to recent auth/timeout backoff (${secsLeft}s remaining; press key to retry)`);
      return null;
    }

    const candidates = this.resolveAgyBinary(customPath);
    this.diag(`Trying agy CLI candidates: ${candidates.join(", ")}`);

    for (const bin of candidates) {
      try {
        const isWinBatch = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
        const cmd = isWinBatch ? (process.env.ComSpec || "cmd.exe") : bin;
        const args = isWinBatch
          ? ["/d", "/s", "/c", bin, "-p", "/usage", "--print-timeout", "45s"]
          : ["-p", "/usage", "--print-timeout", "45s"];

        const start = Date.now();
        const { stdout, stderr } = await execFileAsync(cmd, args, {
          timeout: 50000,
          maxBuffer: 2 * 1024 * 1024,
          cwd: os.homedir(),
          windowsHide: true
        });
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        this.diag(`  agy (${bin}) completed in ${elapsed}s (${stdout.length} bytes stdout)`);

        const parsed = this.parseAgyUsageOutput(stdout);
        if (parsed) {
          this.resolvedAgyBin = bin;
          this.cliBackoffUntil = 0;
          this.lastRawResponse = stdout;
          this.diag(`  ✔ Parsed quota from agy CLI`);
          return parsed;
        }

        const snippet = (stderr || stdout || "").trim().split(/\r?\n/)[0]?.slice(0, 160) || "(empty output)";
        this.diag(`  agy returned unparseable output: ${snippet}`);
        // Back off for 5 minutes if agy ran but returned an auth/error message
        this.cliBackoffUntil = Date.now() + 5 * 60 * 1000;
        return null;
      } catch (err: any) {
        const code = err?.code;
        if (code === "ENOENT") {
          this.diag(`  ${bin}: not found`);
          continue;
        }
        const stderrLine = String(err?.stderr || err?.message || err).trim().split(/\r?\n/)[0]?.slice(0, 160);
        this.diag(`  agy (${bin}) failed (${code || "err"}): ${stderrLine}`);
        // Back off to avoid repeatedly spawning agy or triggering browser sign-in popups
        this.cliBackoffUntil = Date.now() + 5 * 60 * 1000;
        return null;
      }
    }

    this.diag("agy CLI binary not found on this machine");
    return null;
  }

  /**
   * Parses stdout from `agy -p "/usage"`.
   * Expected TSV format (one bucket per line):
   *   Gemini Models\tWeekly Limit Remaining\t80%\t2026-11-24T23:28:29Z
   *   Gemini Models\tFive Hour Limit Remaining\t81%\t2026-11-21T09:18:33Z
   *   Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-11-28T05:16:42Z
   *   Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-11-21T10:16:42Z
   *   Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t100%\t2026-11-28T05:16:42Z
   */
  public parseAgyUsageOutput(rawOutput: string): AntigravityQuotaSnapshot | null {
    if (!rawOutput || typeof rawOutput !== "string") return null;

    const cleaned = rawOutput.replace(ANSI_RE, "").trim();
    if (!cleaned) return null;

    // Handle JSON envelope if `--output-format json` was ever used
    if (cleaned.startsWith("{")) {
      try {
        const json = JSON.parse(cleaned);
        if (typeof json.response === "string") {
          return this.parseAgyUsageOutput(json.response);
        }
        const parsedJson = this.parseQuotaResponse(json, "cli");
        if (parsedJson) return parsedJson;
      } catch {
        // fall through to line parser
      }
    }

    const snapshot: AntigravityQuotaSnapshot = {
      lastUpdated: Date.now(),
      source: "cli"
    };
    let found = 0;

    const assign = (slot: Slot, b: QuotaBucket) => {
      const existing = snapshot[slot];
      if (!existing || b.percentage < existing.percentage) snapshot[slot] = b;
    };

    for (const rawLine of cleaned.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;

      // Primary format: tab-separated columns
      let cols = line.split("\t").map((c) => c.trim()).filter((c) => c.length > 0);
      // Fallback: 2+ spaces separated columns
      if (cols.length < 3) {
        cols = line.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
      }
      if (cols.length < 3) continue;

      const [group, label, pctText, resetText] = cols;
      const pctMatch = /(-?\d+(?:\.\d+)?)\s*%/.exec(pctText || "");
      if (!pctMatch) continue;

      const pctVal = Math.max(0, Math.min(100, Number(pctMatch[1])));
      const fraction = pctVal / 100;
      const resetTime = resetText && !Number.isNaN(Date.parse(resetText)) ? resetText : null;

      const g = group.toLowerCase();
      const l = label.toLowerCase();

      let window: QuotaBucket["window"] | null = null;
      if (/week|wtu|7d|seven/.test(l)) {
        window = "WEEKLY";
      } else if (/five\s*hour|5\s*hour|5-hour|5h|session|rolling/.test(l)) {
        window = "FIVE_HOURS";
      }

      // Check Argon before generic Gemini so "Gemini 4 Argon" doesn't collide
      if (g.includes("argon") || l.includes("argon")) {
        const b: QuotaBucket = {
          bucketId: "gemini-argon-wtu-weekly",
          displayName: label || group,
          remainingFraction: fraction,
          percentage: Math.round(pctVal),
          resetTime,
          window: "WEEKLY"
        };
        assign("geminiArgonWeekly", b);
        found++;
      } else if (g.includes("claude") || g.includes("gpt") || g.includes("anthropic") || g.includes("openai") || g.includes("3p")) {
        if (!window) continue;
        const b: QuotaBucket = {
          bucketId: window === "FIVE_HOURS" ? "3p-5h" : "3p-weekly",
          displayName: label || group,
          remainingFraction: fraction,
          percentage: Math.round(pctVal),
          resetTime,
          window
        };
        assign(window === "FIVE_HOURS" ? "claude5h" : "claudeWeekly", b);
        found++;
      } else if (g.includes("gemini")) {
        if (!window) continue;
        const b: QuotaBucket = {
          bucketId: window === "FIVE_HOURS" ? "gemini-5h" : "gemini-weekly",
          displayName: label || group,
          remainingFraction: fraction,
          percentage: Math.round(pctVal),
          resetTime,
          window
        };
        assign(window === "FIVE_HOURS" ? "gemini5h" : "geminiWeekly", b);
        found++;
      }
    }

    return found > 0 ? snapshot : null;
  }

  /**
   * Probes local Antigravity Language Server (legacy method for Antigravity < 2.34)
   */
  private async probeLocalLanguageServer(manualPort?: string | number): Promise<AntigravityQuotaSnapshot | null> {
    // Fast path: reuse the last endpoint that worked
    if (this.lastGoodTarget) {
      const t = this.lastGoodTarget;
      const snap = await this.tryEndpoint(t.scheme, t.host, t.port, t.token, t.method);
      if (snap) return snap;
      this.diag("Previously working endpoint no longer responds; rediscovering");
      this.lastGoodTarget = null;
    }

    const processes = await this.detectLocalProcesses();
    this.diag(`Found ${processes.length} candidate Antigravity process(es)`);
    let sawHardened234 = false;
    for (const p of processes) {
      if (p.usesStdinBridgeToken && !p.csrfToken && !p.extensionCsrfToken) {
        sawHardened234 = true;
      }
      this.diag(`  pid=${p.pid} name=${p.name} csrf=${QuotaService.redact(p.csrfToken)} extCsrf=${QuotaService.redact(p.extensionCsrfToken)} stdinToken=${p.usesStdinBridgeToken} argPorts=[${p.argPorts.join(",")}]`);
    }

    if (sawHardened234 && !manualPort) {
      this.diag("Detected Antigravity v2.34+ (--read_host_bridge_token_from_stdin with no --csrf_token). Local RPC is locked down; use the official 'agy' CLI instead.");
    }

    const allTokens = Array.from(new Set(
      processes.flatMap((p) => [p.csrfToken, p.extensionCsrfToken]).filter(Boolean)
    ));

    const targets: LocalProbeTarget[] = [];
    const seen = new Set<string>();
    const addTarget = (host: string, port: number, tokens: string[]) => {
      if (!port || port <= 0 || port > 65535) return;
      const key = `${host}:${port}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push({ host, port, tokens: Array.from(new Set([...tokens, ""])) });
    };

    if (manualPort) {
      const p = parseInt(String(manualPort), 10);
      if (!isNaN(p)) addTarget("127.0.0.1", p, allTokens);
    }

    // Only probe processes that actually have a token (or if manualPort was given)
    const tokenedProcs = processes.filter((p) => p.csrfToken || p.extensionCsrfToken);
    if (tokenedProcs.length > 0) {
      const listening = await this.listListeningPorts(tokenedProcs.map((p) => p.pid));
      for (const p of tokenedProcs) {
        const tokens = [p.csrfToken, p.extensionCsrfToken].filter(Boolean);
        for (const l of listening.filter((x) => x.pid === p.pid)) {
          addTarget(l.host, l.port, tokens);
        }
        for (const port of p.argPorts) {
          addTarget("127.0.0.1", port, tokens);
        }
      }
    }

    this.diag(`Probing ${targets.length} local port(s): ${targets.map((t) => `${t.host}:${t.port}`).join(", ") || "(none)"}`);
    if (targets.length === 0) return null;

    for (const method of [SUMMARY_METHOD, STATUS_METHOD]) {
      for (const target of targets) {
        const snap = await this.probeTarget(target, method);
        if (snap) return snap;
      }
    }

    return null;
  }

  private async probeTarget(target: LocalProbeTarget, method: string): Promise<AntigravityQuotaSnapshot | null> {
    for (const scheme of ["https", "http"] as const) {
      for (const token of target.tokens) {
        let result: HttpResult;
        try {
          result = await this.httpPost(scheme, target.host, target.port, RPC_PREFIX + method, "{}", this.localHeaders(token));
        } catch (err: any) {
          this.diag(`  ${scheme}://${target.host}:${target.port} ${method} -> ${err?.code || err?.message || err}`);
          break; // transport failure: other tokens won't help on this scheme
        }
        this.diag(`  ${scheme}://${target.host}:${target.port} ${method} token=${QuotaService.redact(token)} -> HTTP ${result.status} (${result.body.length} bytes)`);
        if (result.status === 401 || result.status === 403) continue; // try next token
        if (result.status !== 200) break;

        const snap = this.parseBody(result.body, "local");
        if (snap) {
          this.lastGoodTarget = { scheme, host: target.host, port: target.port, token, method };
          this.diag(`  ✔ Parsed quota from ${scheme}://${target.host}:${target.port}/${method}`);
          return snap;
        }
        this.diag("  Response contained no recognizable quota buckets");
        break;
      }
    }
    return null;
  }

  private async tryEndpoint(scheme: "https" | "http", host: string, port: number, token: string, method: string): Promise<AntigravityQuotaSnapshot | null> {
    try {
      const r = await this.httpPost(scheme, host, port, RPC_PREFIX + method, "{}", this.localHeaders(token));
      if (r.status !== 200) return null;
      return this.parseBody(r.body, "local");
    } catch {
      return null;
    }
  }

  private localHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1"
    };
    if (token) headers["X-Codeium-Csrf-Token"] = token;
    return headers;
  }

  private parseBody(body: string, source: "cli" | "local" | "cloud"): AntigravityQuotaSnapshot | null {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      return null;
    }
    const snap = this.parseQuotaResponse(json, source);
    if (snap) this.lastRawResponse = json;
    return snap;
  }

  /**
   * Minimal HTTP(S) POST. Self-signed certificates are accepted because the
   * Antigravity language server only listens on loopback with its own cert.
   */
  private httpPost(
    scheme: "https" | "http",
    host: string,
    port: number,
    urlPath: string,
    body: string,
    headers: Record<string, string>,
    timeoutMs = 2500
  ): Promise<HttpResult> {
    return new Promise((resolve, reject) => {
      const isLoopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
      const options: https.RequestOptions = {
        host,
        port,
        path: urlPath,
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        timeout: timeoutMs,
        agent: false
      };
      if (scheme === "https" && isLoopback) {
        options.rejectUnauthorized = false;
      }
      const lib = scheme === "https" ? https : http;
      const req = lib.request(options, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 2 * 1024 * 1024) {
            req.destroy(new Error("Response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf-8") }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
      req.on("error", reject);
      req.end(body);
    });
  }

  /**
   * Finds running Antigravity language server processes and their CSRF tokens.
   */
  public async detectLocalProcesses(): Promise<DetectedProcess[]> {
    const raw: { pid: number; name: string; commandLine: string }[] = [];

    try {
      if (process.platform === "win32") {
        const script =
          "Get-CimInstance Win32_Process | " +
          "Where-Object { $_.Name -match 'language_server|^agy' -or ($_.CommandLine -match 'csrf_token|read_host_bridge_token_from_stdin' -and $_.CommandLine -match 'antigravity') } | " +
          "Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
        const { stdout } = await execFileAsync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
          { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 }
        );
        const text = stdout.trim();
        if (text) {
          const parsed = JSON.parse(text);
          const list = Array.isArray(parsed) ? parsed : [parsed];
          for (const p of list) {
            raw.push({ pid: Number(p.ProcessId), name: String(p.Name || ""), commandLine: String(p.CommandLine || "") });
          }
        }
      } else {
        const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
        for (const line of stdout.split(/\r?\n/)) {
          const m = line.trim().match(/^(\d+)\s+(.*)$/);
          if (!m) continue;
          const args = m[2];
          const exe = args.split(/\s+/)[0] || "";
          const base = path.basename(exe);
          if (/language_server/i.test(base) || /^agy\b/i.test(base) || (/(csrf_token|read_host_bridge_token_from_stdin)/.test(args) && /antigravity/i.test(args))) {
            raw.push({ pid: Number(m[1]), name: base, commandLine: args });
          }
        }
      }
    } catch (err: any) {
      this.diag(`Process listing failed: ${String(err?.message || err)}`);
      return [];
    }

    const result: DetectedProcess[] = [];
    for (const r of raw) {
      if (!r.commandLine) {
        this.diag(`  pid=${r.pid} (${r.name}) command line unavailable (permission?)`);
      }
      const get = (flag: string): string => {
        const m = r.commandLine.match(new RegExp(`--?${flag}(?:=|\\s+)"?([^\\s"]+)`));
        return m ? m[1] : "";
      };
      const argPorts: number[] = [];
      const portRe = /--?[a-z_]*port(?:=|\s+)(\d{2,5})\b/gi;
      let pm: RegExpExecArray | null;
      while ((pm = portRe.exec(r.commandLine)) !== null) {
        argPorts.push(parseInt(pm[1], 10));
      }
      result.push({
        pid: r.pid,
        name: r.name,
        commandLine: r.commandLine,
        csrfToken: get("csrf_token"),
        extensionCsrfToken: get("extension_server_csrf_token"),
        argPorts,
        usesStdinBridgeToken: /--?read_host_bridge_token_from_stdin\b/.test(r.commandLine)
      });
    }
    return result;
  }

  /**
   * Lists TCP ports in LISTEN state owned by the given PIDs.
   */
  public async listListeningPorts(pids: number[]): Promise<{ pid: number; host: string; port: number }[]> {
    const pidSet = new Set(pids);
    const out: { pid: number; host: string; port: number }[] = [];
    const push = (pid: number, addr: string, port: number) => {
      if (!pidSet.has(pid) || !port) return;
      const host = addr.includes("::1") || addr === "[::1]" ? "::1" : "127.0.0.1";
      if (!out.some((o) => o.pid === pid && o.port === port)) out.push({ pid, host, port });
    };

    try {
      if (process.platform === "win32") {
        const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 });
        // Also include IPv6 listeners
        let v6 = "";
        try {
          v6 = (await execFileAsync("netstat", ["-ano", "-p", "TCPv6"], { windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 })).stdout;
        } catch {
          // ignore
        }
        for (const line of (stdout + "\n" + v6).split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          // Proto  Local Address  Foreign Address  State  PID
          if (parts.length < 5 || !/^TCP/i.test(parts[0])) continue;
          if (!/LISTEN/i.test(parts[3])) continue;
          const local = parts[1];
          const idx = local.lastIndexOf(":");
          push(parseInt(parts[4], 10), local.slice(0, idx), parseInt(local.slice(idx + 1), 10));
        }
      } else {
        try {
          const { stdout } = await execFileAsync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")], { timeout: 5000 });
          for (const line of stdout.split(/\r?\n/).slice(1)) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 9) continue;
            const name = parts[8];
            const idx = name.lastIndexOf(":");
            push(parseInt(parts[1], 10), name.slice(0, idx), parseInt(name.slice(idx + 1), 10));
          }
        } catch {
          const { stdout } = await execFileAsync("ss", ["-ltnpH"], { timeout: 5000 });
          for (const line of stdout.split(/\r?\n/)) {
            const pidMatch = line.match(/pid=(\d+)/);
            const parts = line.trim().split(/\s+/);
            if (!pidMatch || parts.length < 4) continue;
            const local = parts[3];
            const idx = local.lastIndexOf(":");
            push(parseInt(pidMatch[1], 10), local.slice(0, idx), parseInt(local.slice(idx + 1), 10));
          }
        }
      }
    } catch (err: any) {
      this.diag(`Port listing failed: ${String(err?.message || err)}`);
    }

    this.diag(`Listening ports: ${out.map((o) => `${o.pid}:${o.port}`).join(", ") || "(none found)"}`);
    return out;
  }

  /**
   * Calls Google Cloud Code PA endpoint using OAuth access token.
   * Merges responses across hosts so partial responses (e.g. Claude-only from daily)
   * still pick up Gemini pools from production.
   */
  private async fetchFromCloudCode(token: string): Promise<AntigravityQuotaSnapshot | null> {
    const hosts = [
      "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
      "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary"
    ];

    let merged: AntigravityQuotaSnapshot | null = null;

    for (const url of hosts) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json",
            "User-Agent": "antigravity/hub/2.34.0"
          },
          body: JSON.stringify({}),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        this.diag(`Cloud ${new URL(url).host} -> HTTP ${resp.status}`);
        if (!resp.ok) continue;

        const snap = this.parseBody(await resp.text(), "cloud");
        if (snap) {
          if (!merged) {
            merged = snap;
          } else {
            merged.gemini5h ??= snap.gemini5h;
            merged.geminiWeekly ??= snap.geminiWeekly;
            merged.claude5h ??= snap.claude5h;
            merged.claudeWeekly ??= snap.claudeWeekly;
            merged.geminiArgonWeekly ??= snap.geminiArgonWeekly;
            merged.accountEmail ??= snap.accountEmail;
            merged.planName ??= snap.planName;
          }
          if (merged.gemini5h && merged.geminiWeekly) return merged;
        }
      } catch (err: any) {
        this.diag(`Cloud ${url} failed: ${String(err?.message || err)}`);
      }
    }
    return merged;
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
        const expiry = Number(data.expiry_date || data.expires_at || 0);
        if (expiry && expiry < Date.now()) {
          this.diag(`Token in ${p} is expired; skipping`);
          continue;
        }
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
   * Parses the JSON payload from RetrieveUserQuotaSummary or GetUserStatus.
   * Walks the whole tree so it tolerates wrappers (`response`, `userQuota`,
   * `userStatus`, ...) and both bucket-style and per-model `quotaInfo` layouts.
   * Returns null when no quota information is present.
   */
  public parseQuotaResponse(data: any, source: "cli" | "local" | "cloud"): AntigravityQuotaSnapshot | null {
    if (!data || typeof data !== "object") return null;

    const snapshot: AntigravityQuotaSnapshot = {
      lastUpdated: Date.now(),
      source
    };
    let found = 0;

    const labelOf = (o: any): string => {
      const parts: string[] = [];
      for (const k of ["displayName", "label", "name", "model", "modelName", "bucketId", "id", "title"]) {
        if (typeof o?.[k] === "string" && o[k]) parts.push(o[k]);
      }
      return parts.join(" ");
    };

    const assign = (slot: Slot, b: QuotaBucket) => {
      const existing = snapshot[slot];
      if (!existing || b.percentage < existing.percentage) snapshot[slot] = b;
    };

    const handle = (q: any, owner: any, ctx: string[], isModelEntry: boolean) => {
      const bucketId = String(q.bucketId || owner.bucketId || q.id || "");
      const description = String(q.description || q.message || owner.description || "");
      let fraction: number;
      if (typeof q.remainingFraction === "number") {
        fraction = q.remainingFraction;
      } else if (typeof q.remainingFraction === "string" && !isNaN(parseFloat(q.remainingFraction))) {
        fraction = parseFloat(q.remainingFraction);
      } else {
        // proto3 JSON omits zero values; infer from description when possible
        fraction = /reached|used all|exhausted|out of|no .*remaining/i.test(description) ? 0 : 1;
      }
      fraction = Math.max(0, Math.min(1, fraction));

      const ownLabel = labelOf(owner) + (owner !== q ? " " + labelOf(q) : "");
      const modelText = [bucketId, ownLabel, ...ctx].join(" ").toLowerCase();
      const windowText = [String(q.window || owner.window || ""), bucketId, ownLabel, ...ctx].join(" ").toLowerCase();

      let window: QuotaBucket["window"];
      if (/week|wtu|7d|seven/.test(windowText)) window = "WEEKLY";
      else if (/5h|five|5-hour|5 hour|hour|session|rolling/.test(windowText)) window = "FIVE_HOURS";
      else window = isModelEntry ? "FIVE_HOURS" : "FIVE_HOURS";

      const b: QuotaBucket = {
        bucketId,
        displayName: String(q.displayName || owner.displayName || owner.label || ctx[ctx.length - 1] || bucketId),
        remainingFraction: fraction,
        percentage: Math.round(fraction * 100),
        resetTime: q.resetTime || q.nextResetTime || owner.resetTime || null,
        window
      };

      if (/argon/.test(modelText)) {
        b.window = "WEEKLY";
        assign("geminiArgonWeekly", b);
      } else if (/claude|gpt|anthropic|openai|sonnet|opus|\b3p\b|3p-|third.?party|oss/.test(modelText)) {
        assign(window === "WEEKLY" ? "claudeWeekly" : "claude5h", b);
      } else {
        assign(window === "WEEKLY" ? "geminiWeekly" : "gemini5h", b);
      }
      found++;
    };

    const walk = (node: any, ctx: string[], depth: number) => {
      if (depth > 12 || node === null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, ctx, depth + 1);
        return;
      }

      // Account metadata
      if (!snapshot.accountEmail && typeof node.email === "string") snapshot.accountEmail = node.email;
      if (!snapshot.planName) {
        const plan = node.planName || node.tierName || node.userTier?.name || node.planInfo?.planName;
        if (typeof plan === "string" && plan) snapshot.planName = plan;
      }

      const isBucket = node.remainingFraction !== undefined
        || (typeof node.bucketId === "string" && (node.resetTime !== undefined || node.window !== undefined));
      if (isBucket) {
        handle(node, node, ctx, false);
        return;
      }

      const label = labelOf(node);
      const nextCtx = label ? [...ctx, label] : ctx;

      if (node.quotaInfo && typeof node.quotaInfo === "object") {
        handle(node.quotaInfo, node, ctx, true);
      }

      for (const [k, v] of Object.entries(node)) {
        if (k === "quotaInfo") continue;
        if (v && typeof v === "object") walk(v, nextCtx, depth + 1);
      }
    };

    walk(data, [], 0);
    return found > 0 ? snapshot : null;
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
