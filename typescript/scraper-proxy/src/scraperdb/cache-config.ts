export const DEFAULT_CACHE_TTL_SECONDS = 60;
export const MAX_CACHE_TTL_SECONDS = 300;

export function clampCacheTtl(ttlSeconds: number): number {
  return Math.min(Math.max(ttlSeconds, 0), MAX_CACHE_TTL_SECONDS);
}

export function cacheControlHeader(ttlSeconds: number): string {
  return `max-age=${clampCacheTtl(ttlSeconds)}, public`;
}
