// Simple per-IP limits, kept in memory.
// Note: on Cloudflare Workers memory is per data centre instance, so treat this as a
// speed bump, not a hard cap. Many technicians on one office network can share one IP,
// so keep the numbers generous (see the deployment notes).
export function createRateLimiter() {
  const hits = new Map(); // ip -> { minute, minuteCount, day, dayCount }

  return function check(ip, { perMinute, perDay }, now = Date.now()) {
    const minute = Math.floor(now / 60000);
    const day = Math.floor(now / 86400000);
    let h = hits.get(ip);
    if (!h || h.day !== day) h = { minute, minuteCount: 0, day, dayCount: 0 };
    if (h.minute !== minute) { h.minute = minute; h.minuteCount = 0; }

    if (perMinute > 0 && h.minuteCount >= perMinute) return { ok: false, retryAfter: 60 - Math.floor((now / 1000) % 60) };
    if (perDay > 0 && h.dayCount >= perDay) return { ok: false, retryAfter: 86400 - Math.floor((now / 1000) % 86400) };

    h.minuteCount++;
    h.dayCount++;
    hits.set(ip, h);

    // Keep memory small: forget yesterday's visitors now and then.
    if (hits.size > 5000) for (const [k, v] of hits) if (v.day !== day) hits.delete(k);
    return { ok: true };
  };
}
