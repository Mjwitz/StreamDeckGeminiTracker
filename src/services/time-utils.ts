/**
 * Formats an ISO reset time or timestamp into a human-friendly countdown badge:
 * e.g. "3h 24m", "48m", "5d 12h", "< 1m", or "FULL"
 */
export function formatResetCountdown(resetTime: string | null | undefined, remainingFraction?: number): string {
  if (remainingFraction !== undefined && remainingFraction >= 0.999) {
    return "100%";
  }

  if (!resetTime) {
    return "ACTIVE";
  }

  const targetDate = new Date(resetTime).getTime();
  if (isNaN(targetDate)) {
    return "ACTIVE";
  }

  const now = Date.now();
  const diffMs = targetDate - now;

  if (diffMs <= 0) {
    return "READY";
  }

  const diffMins = Math.round(diffMs / (60 * 1000));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays > 0) {
    const remHours = diffHours % 24;
    return `${diffDays}d ${remHours}h`;
  }

  if (diffHours > 0) {
    const remMins = diffMins % 60;
    return `${diffHours}h ${remMins}m`;
  }

  if (diffMins > 0) {
    return `${diffMins}m`;
  }

  return "< 1m";
}
