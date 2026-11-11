#!/usr/bin/env node
/**
 * Standalone diagnostic tool for Antigravity AI Tracker Stream Deck Plugin.
 * Run this on the machine where Antigravity is installed:
 *   npm run diagnose
 */
import fs from "node:fs";
import path from "node:path";
import { QuotaService } from "../src/services/quota-service.js";

async function main() {
  console.log("==================================================");
  console.log("  Antigravity AI Stream Deck - Local Diagnostics  ");
  console.log("==================================================");
  console.log(`OS: ${process.platform} (${process.arch}) Node: ${process.version}`);
  console.log();

  const service = QuotaService.getInstance();
  service.setLogger({
    info: (...args) => console.log(...args),
    warn: (...args) => console.warn("WARN:", ...args),
    error: (...args) => console.error("ERR:", ...args)
  });

  console.log("1. Scanning for Antigravity processes...");
  const procs = await service.detectLocalProcesses();
  if (procs.length === 0) {
    console.log("   ⚠ No candidate processes found!");
    console.log("   Make sure the Antigravity desktop app is running and active.");
  } else {
    for (const p of procs) {
      console.log(`   ✔ PID ${p.pid}: ${p.name}`);
      console.log(`     Command line: ${p.commandLine.slice(0, 160)}${p.commandLine.length > 160 ? "…" : ""}`);
      console.log(`     CSRF token: ${p.csrfToken ? `${p.csrfToken.slice(0, 4)}…` : "(none)"}`);
      console.log(`     Extension CSRF token: ${p.extensionCsrfToken ? `${p.extensionCsrfToken.slice(0, 4)}…` : "(none)"}`);
      if (p.argPorts.length) {
        console.log(`     CLI port flags: ${p.argPorts.join(", ")}`);
      }
    }
  }
  console.log();

  if (procs.length > 0) {
    console.log("2. Checking TCP listening ports for detected PIDs...");
    const ports = await service.listListeningPorts(procs.map((p) => p.pid));
    if (ports.length === 0) {
      console.log("   ⚠ No listening TCP ports detected for these PIDs.");
      console.log("   (On Windows, make sure netstat is accessible)");
    } else {
      for (const pt of ports) {
        console.log(`   ✔ PID ${pt.pid} listening on ${pt.host}:${pt.port}`);
      }
    }
    console.log();
  }

  console.log("3. Probing language server endpoint for quota data...");
  const snapshot = await service.getQuota({ dataSource: "auto" }, true);
  console.log();

  console.log("4. Probe Trace:");
  for (const line of service.lastDiagnostics) {
    console.log(`   ${line}`);
  }
  console.log();

  console.log("5. Result Snapshot:");
  console.log(`   Source: ${snapshot.source}`);
  if (snapshot.errorMessage) {
    console.log(`   Error:  ${snapshot.errorMessage}`);
  }
  if (snapshot.gemini5h) {
    console.log(`   • Gemini 5-Hour:      ${snapshot.gemini5h.percentage}% (reset: ${snapshot.gemini5h.resetTime || "n/a"})`);
  }
  if (snapshot.geminiWeekly) {
    console.log(`   • Gemini Weekly:      ${snapshot.geminiWeekly.percentage}% (reset: ${snapshot.geminiWeekly.resetTime || "n/a"})`);
  }
  if (snapshot.claude5h) {
    console.log(`   • Claude/GPT 5-Hour:  ${snapshot.claude5h.percentage}% (reset: ${snapshot.claude5h.resetTime || "n/a"})`);
  }
  if (snapshot.claudeWeekly) {
    console.log(`   • Claude/GPT Weekly:  ${snapshot.claudeWeekly.percentage}% (reset: ${snapshot.claudeWeekly.resetTime || "n/a"})`);
  }
  if (snapshot.geminiArgonWeekly) {
    console.log(`   • Gemini 4 Argon:     ${snapshot.geminiArgonWeekly.percentage}% (reset: ${snapshot.geminiArgonWeekly.resetTime || "n/a"})`);
  }
  if (snapshot.planName) {
    console.log(`   • Plan:               ${snapshot.planName}`);
  }
  if (snapshot.accountEmail) {
    console.log(`   • Account:            ${snapshot.accountEmail}`);
  }

  if (service.lastRawResponse) {
    const outPath = path.resolve(process.cwd(), "diagnose-output.json");
    fs.writeFileSync(outPath, JSON.stringify(service.lastRawResponse, null, 2), "utf-8");
    console.log();
    console.log(`   ✔ Raw response written to: ${outPath}`);
  }

  console.log();
  if (snapshot.source === "offline") {
    console.log("❌ Detection unsuccessful.");
    console.log("Tips:");
    console.log("1. Check if the Antigravity app is fully loaded with a project open.");
    console.log("2. You can test your Stream Deck buttons immediately by setting Data Source to 'Demo' in Property Inspector.");
    console.log("3. Share the output above to diagnose the exact issue.");
    process.exitCode = 1;
  } else {
    console.log("✅ Quota successfully detected!");
  }
}

main().catch((err) => {
  console.error("Diagnostic script crashed:", err);
  process.exitCode = 1;
});
