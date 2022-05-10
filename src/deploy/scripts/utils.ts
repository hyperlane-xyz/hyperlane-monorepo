import { environments, HelloWorldConfig } from '../environments';

export async function getEnvironmentConfig(
  environment: keyof typeof environments,
): Promise<HelloWorldConfig> {
  return environments[environment];
}
