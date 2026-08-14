export function dateDistanceDays(left: string, right: string): number {
  const a = Date.parse(`${left}T00:00:00Z`);
  const b = Date.parse(`${right}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(a - b) / 86_400_000);
}

export function inPeriod(date: string, start: string, end: string): boolean {
  return date >= start && date <= end;
}
