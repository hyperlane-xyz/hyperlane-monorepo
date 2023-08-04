// Should be used instead of referencing process directly in case we don't
// run in node.js
export function safelyAccessEnvVar(name: string) {
  try {
    return process.env[name];
  } catch (error) {
    return undefined;
  }
}
