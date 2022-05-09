import { environments, YoConfig } from '../environments';

export async function getEnvironmentConfig(
  environment: keyof typeof environments,
): Promise<YoConfig> {
  return environments[environment];
}
