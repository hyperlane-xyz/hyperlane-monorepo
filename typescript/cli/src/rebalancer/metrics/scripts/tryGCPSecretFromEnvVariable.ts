import { logDebug } from '../../../logger.js';

// If the environment variable GCP_SECRET_OVERRIDES_ENABLED is `true`,
// this will attempt to find an environment variable of the form:
//  `GCP_SECRET_OVERRIDE_${gcpSecretName.replaceAll('-', '_').toUpperCase()}`
// If found, it's returned, otherwise, undefined is returned.
export function tryGCPSecretFromEnvVariable(gcpSecretName: string) {
  const overridingEnabled =
    process.env.GCP_SECRET_OVERRIDES_ENABLED &&
    process.env.GCP_SECRET_OVERRIDES_ENABLED.length > 0;

  if (!overridingEnabled) {
    logDebug('GCP secret overrides disabled');
    return undefined;
  }

  logDebug('GCP secret overrides enabled');
  const overrideEnvVarName = `GCP_SECRET_OVERRIDE_${gcpSecretName
    .replaceAll('-', '_')
    .toUpperCase()}`;

  return process.env[overrideEnvVarName];
}
