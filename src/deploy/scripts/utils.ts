import { environments, HelloWorldEnvironmentConfig } from '../environments';

export async function getEnvironmentConfig(
  environment: keyof typeof environments,
): Promise<HelloWorldEnvironmentConfig> {
  return environments[environment];
}
