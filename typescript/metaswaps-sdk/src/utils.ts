export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomUUID(): string {
  // crypto.randomUUID available in Node 19+ and all modern browsers.
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 v4 UUID from Math.random (non-cryptographic but fine for IDs).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
