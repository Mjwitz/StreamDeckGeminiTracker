import streamDeck from "@elgato/streamdeck";

import { GeminiWeeklyAction } from "./actions/weekly-action.js";
import { GeminiFiveHourAction } from "./actions/five-hour-action.js";
import { ClaudeGptAction } from "./actions/claude-gpt-action.js";
import { GeminiArgonAction } from "./actions/gemini-argon-action.js";
import { MultiMetricCycleAction } from "./actions/cycle-action.js";

// Enable info logging for diagnostics
streamDeck.logger.setLevel("info");
streamDeck.logger.info("Initializing Antigravity AI Tracker Stream Deck Plugin...");

// Register all actions requested by user:
// 1. Weekly Limit
// 2. 5-Hour Limit
// 3. Claude and GPT usage
// 4. Gemini 4 Argon Limit
// 5. Multi-Metric Cycle / Overview
streamDeck.actions.registerAction(new GeminiWeeklyAction());
streamDeck.actions.registerAction(new GeminiFiveHourAction());
streamDeck.actions.registerAction(new ClaudeGptAction());
streamDeck.actions.registerAction(new GeminiArgonAction());
streamDeck.actions.registerAction(new MultiMetricCycleAction());

// Connect to the Stream Deck software
streamDeck.connect().then(() => {
  streamDeck.logger.info("Antigravity AI Tracker successfully connected to Stream Deck!");
}).catch((err) => {
  streamDeck.logger.error("Error connecting to Stream Deck:", err);
});
