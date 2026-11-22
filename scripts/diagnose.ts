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

  console.log("1. Checking official Antigravity CLI (agy) candidates...");
  const agyCandidates = service.resolveAgyBinary();
  for (const c of agyCandidates) {
    const exists = path.isAbsolute(c) ? fs.existsSync(c) : "PATH";
    console.log(`   • ${c} (${exists === true ? "found" : exists === "PATH" ? "PATH lookup" : "missing"})`);
  }
  console.log();

  console.log("2. Scanning for running Antigravity processes...");
  const procs = await service.detectLocalProcesses();
  if (procs.length === 0) {
    console.log("   • No running language_server processes found (not required if agy CLI is installed).");
  } else {
    for (const p of procs) {
      console.log(`   ✔ PID ${p.pid}: ${p.name}`);
      if (p.usesStdinBridgeToken && !p.csrfToken) {
        console.log("     ℹ Antigravity v2.34+ detected (--read_host_bridge_token_from_stdin). Local RPC is locked down; agy CLI will be used.");
      } else {
        console.log(`     CSRF token: ${p.csrfToken ? `${p.csrfToken.slice(0, 4)}…` : "(none)"}`);
      }
    }
  }
  console.log();

  console.log("3. Fetching quota (Auto: agy CLI -> Local RPC -> Cloud)...");
  const snapshot = await service.getQuota({ dataSource: "auto" }, true);
  console.log();

  console.log("4. Result Snapshot:");
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
    const outPath = path.resolve(process.cwd(), "diagnose-output.txt");
    const serialized = typeof service.lastRawResponse === "string"
      ? service.lastRawResponse
      : JSON.stringify(service.lastRawResponse, null, 2);
    fs.writeFileSync(outPath, serialized, "utf-8");
    console.log();
    console.log(`   ✔ Raw response written to: ${outPath}`);
  }

  console.log();
  if (snapshot.source === "offline") {
    console.log("❌ Quota detection unsuccessful.");
    console.log("Tips:");
    console.log("1. Antigravity v2.34.0+ removed local RPC tokens; make sure the official 'agy' CLI is installed and signed in.");
    console.log("2. Test manually in your terminal:  agy -p \"/usage\" --print-timeout 45s");
    console.log("3. If 'agy' is installed in a custom path, set 'agy CLI Path' in the Stream Deck Property Inspector.");
    process.exitCode = 1;
  } else {
    console.log(`✅ Quota successfully detected via ${snapshot.source}!`);
  }
}

main().catch((err) => {
  console.error("Diagnostic script crashed:", err);
  process.exitCode = 1;
});
