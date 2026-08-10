// Default number of pending transfer rows fetched per explorer query. Shared
// across the explorer client, the route runtime, and the service env parsing so
// the default cannot silently drift between call sites.
export const DEFAULT_EXPLORER_QUERY_LIMIT = 200;
