// Should be used instead of referencing process directly in case we don't
// run in node.js
export function safelyAccessEnvVar(name: string) {
  try {
    return process.env[name];
  } catch (error) {
    return undefined;
  }
}

export function envVarToBoolean(value: any) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  if (typeof value === 'number') return value !== 0;
  return !!value;
}
