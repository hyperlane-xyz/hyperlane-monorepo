import { DeployEnvironment } from '../config/deploy-environment.js';

export interface TollkeeperReleaseConfig {
  releaseName: string;
  namespace: string;
}

const RELEASES: Partial<Record<DeployEnvironment, TollkeeperReleaseConfig[]>> =
  {
    mainnet3: [{ releaseName: 'tollkeeper-prod', namespace: 'tollkeeper' }],
  };

export function getTollkeeperReleaseConfigs(
  environment: DeployEnvironment,
): TollkeeperReleaseConfig[] {
  return RELEASES[environment] ?? [];
}

export function getTollkeeperDeploymentNames(releaseName: string): string[] {
  return [releaseName, `${releaseName}-signer`];
}
