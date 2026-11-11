import { MetricDisplayData, DisplayStyle } from "../types.js";

/**
 * Generates an SVG Data URI string for rendering directly on Stream Deck keys.
 */
export function generateKeyImage(
  data: MetricDisplayData,
  style: DisplayStyle = "radial",
  showCountdown: boolean = true
): string {
  const width = 144;
  const height = 144;
  const { title, subTitle, percentage, countdown, color, status } = data;

  // Choose background based on status
  const isOffline = status === "offline";
  const displayPct = isOffline ? "--" : `${Math.round(percentage)}%`;
  const pctValue = Math.min(100, Math.max(0, percentage));

  let contentSvg = "";

  if (style === "radial") {
    // 300-degree radial ring gauge
    const cx = 72;
    const cy = 66;
    const r = 44;
    const strokeWidth = 8;
    const circumference = 2 * Math.PI * r; // ~276.46
    const arcPercent = 0.8; // 80% circle (approx 288 degrees)
    const arcLength = circumference * arcPercent;
    const filledLength = isOffline ? 0 : (pctValue / 100) * arcLength;
    const emptyLength = circumference - filledLength;

    contentSvg = `
      <!-- Gauge Background Track -->
      <circle
        cx="${cx}" cy="${cy}" r="${r}"
        fill="none"
        stroke="#1e293b"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
        stroke-dasharray="${arcLength} ${circumference}"
        transform="rotate(126, ${cx}, ${cy})"
      />
      <!-- Gauge Active Progress -->
      <circle
        cx="${cx}" cy="${cy}" r="${r}"
        fill="none"
        stroke="${color}"
        stroke-width="${strokeWidth}"
        stroke-linecap="round"
        stroke-dasharray="${filledLength} ${circumference}"
        transform="rotate(126, ${cx}, ${cy})"
        filter="url(#glow)"
      />
      <!-- Percentage Center Display -->
      <text
        x="${cx}" y="${cy + 6}"
        fill="#f8fafc"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="28"
        font-weight="800"
        text-anchor="middle"
        letter-spacing="-1px"
      >${displayPct}</text>
    `;
  } else if (style === "bar") {
    // Linear horizontal progress bar style
    const barWidth = 112;
    const barHeight = 12;
    const barX = 16;
    const barY = 72;
    const fillW = isOffline ? 0 : (pctValue / 100) * barWidth;

    contentSvg = `
      <!-- Center Percentage -->
      <text
        x="72" y="60"
        fill="#f8fafc"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="34"
        font-weight="800"
        text-anchor="middle"
        letter-spacing="-1px"
      >${displayPct}</text>

      <!-- Bar Track -->
      <rect
        x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}"
        rx="${barHeight / 2}" fill="#1e293b"
      />
      <!-- Bar Fill -->
      <rect
        x="${barX}" y="${barY}" width="${fillW}" height="${barHeight}"
        rx="${barHeight / 2}" fill="${color}"
        filter="url(#glow)"
      />
    `;
  } else {
    // Compact style with large bold numbers and badge
    contentSvg = `
      <text
        x="72" y="70"
        fill="#f8fafc"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="36"
        font-weight="900"
        text-anchor="middle"
        letter-spacing="-1px"
      >${displayPct}</text>
    `;
  }

  // Header Title & Subtitle
  const headerSvg = `
    <!-- Top Model Label -->
    <text
      x="72" y="24"
      fill="${color}"
      font-family="system-ui, -apple-system, sans-serif"
      font-size="13"
      font-weight="800"
      text-anchor="middle"
      letter-spacing="1.2px"
    >${escapeXml(title)}</text>
  `;

  // Bottom Pill (Countdown or Status)
  let bottomBadgeText = isOffline ? "OFFLINE" : countdown;
  if (!showCountdown && !isOffline) {
    bottomBadgeText = subTitle;
  }

  const bottomBadgeSvg = `
    <!-- Bottom Badge -->
    <g transform="translate(16, 112)">
      <rect
        x="0" y="0" width="112" height="22"
        rx="11"
        fill="#1e293b"
        fill-opacity="0.85"
        stroke="${color}"
        stroke-opacity="0.35"
        stroke-width="1"
      />
      <text
        x="56" y="15"
        fill="${isOffline ? "#94a3b8" : "#e2e8f0"}"
        font-family="system-ui, -apple-system, sans-serif"
        font-size="11"
        font-weight="600"
        text-anchor="middle"
      >${escapeXml(bottomBadgeText)}</text>
    </g>
  `;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0b0f19" />
      <stop offset="100%" stop-color="#141c2e" />
    </linearGradient>
    <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="0" stdDeviation="3" flood-color="${color}" flood-opacity="0.45"/>
    </filter>
  </defs>

  <!-- Background Card -->
  <rect width="${width}" height="${height}" rx="22" fill="url(#bgGrad)" />
  <rect width="${width}" height="${height}" rx="22" fill="none" stroke="#334155" stroke-opacity="0.4" stroke-width="2" />

  <!-- Elements -->
  ${headerSvg}
  ${contentSvg}
  ${bottomBadgeSvg}
</svg>`;

  const base64 = Buffer.from(svg).toString("base64");
  return `data:image/svg+xml;base64,${base64}`;
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
