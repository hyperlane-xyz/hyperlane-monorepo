/**
 * Session manager for mapping Slack threads to Claude Code sessions.
 * This enables conversation continuity within a Slack thread.
 */

// Map: Slack thread_ts → Claude session_id
const sessions = new Map<string, string>();

/**
 * Get the Claude session ID for a Slack thread.
 * @param threadTs - The Slack thread timestamp
 * @returns The Claude session ID, or undefined if no session exists
 */
export function getSession(threadTs: string): string | undefined {
  return sessions.get(threadTs);
}

/**
 * Store a Claude session ID for a Slack thread.
 * @param threadTs - The Slack thread timestamp
 * @param sessionId - The Claude session ID
 */
export function setSession(threadTs: string, sessionId: string): void {
  sessions.set(threadTs, sessionId);
}

/**
 * Check if a session exists for a thread.
 * @param threadTs - The Slack thread timestamp
 */
export function hasSession(threadTs: string): boolean {
  return sessions.has(threadTs);
}

/**
 * Remove a session (e.g., on error or explicit reset).
 * @param threadTs - The Slack thread timestamp
 */
export function clearSession(threadTs: string): void {
  sessions.delete(threadTs);
}

/**
 * Get all active sessions (for debugging/monitoring).
 */
export function getAllSessions(): Map<string, string> {
  return new Map(sessions);
}
