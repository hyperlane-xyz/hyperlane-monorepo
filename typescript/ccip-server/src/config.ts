import dotenvFlow from 'dotenv-flow';

dotenvFlow.config();

export function getEnabledModules(): string[] {
  const raw = process.env.ENABLED_MODULES;
  if (!raw) {
    throw new Error('ENABLED_MODULES environment variable is not set');
  }
  return raw
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}
