// Should be used instead of referencing process directly in case we don't
// run in node.js
export function safelyAccessEnvVar(name: string, toLowerCase = false) {
  try {
    return toLowerCase ? process.env[name]?.toLowerCase() : process.env[name];
  } catch (error) {
    return undefined;
  }
}
