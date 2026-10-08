/** Convert a provider's local reset clock to its next UTC occurrence. */
export function parseRetryAfter(message: string, now = new Date()): string | undefined {
  const match = /\bresets?\s+(?:(?:at|on)\s+)?(\d{1,2}):(\d{2})\s*(am|pm)\s*\(([^)]+)\)/i.exec(message);
  if (!match) return undefined;
  const hour = Number(match[1]) % 12 + (match[3]!.toLowerCase() === 'pm' ? 12 : 0);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return undefined;
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat('en-US', { timeZone: match[4], year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
  catch { return undefined; }
  const parts = (date: Date): Record<string, number> => Object.fromEntries(format.formatToParts(date)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const local = parts(now);
  for (let day = 0; day < 3; day++) {
    const targetDay = new Date(Date.UTC(local.year!, local.month! - 1, local.day! + day, hour, minute));
    let earliest: Date | undefined;
    for (let offset = -14 * 60; offset <= 14 * 60; offset += 15) {
      const candidate = new Date(targetDay.getTime() - offset * 60_000);
      const value = parts(candidate);
      if (candidate > now && value.year === targetDay.getUTCFullYear() && value.month === targetDay.getUTCMonth() + 1 &&
        value.day === targetDay.getUTCDate() && value.hour === hour && value.minute === minute &&
        (!earliest || candidate < earliest)) earliest = candidate;
    }
    if (earliest) return earliest.toISOString();
  }
  return undefined;
}
