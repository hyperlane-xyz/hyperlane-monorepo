import { DeployEnvironment } from '../src/config/environment.js';

/**
 * Centralized Docker image configuration for all infra services.
 */

export const DockerImageRepos = {
  AGENT: 'gcr.io/abacus-labs-dev/hyperlane-agent',
  MONOREPO: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
  WARP_MONITOR: 'gcr.io/abacus-labs-dev/hyperlane-warp-monitor',
  REBALANCER: 'gcr.io/abacus-labs-dev/hyperlane-rebalancer',
} as const;

interface AgentDockerTags {
  relayer: string;
  relayerRC: string;
  validator: string;
  validatorRC: string;
  scraper: string;
}

interface ServiceDockerTags extends AgentDockerTags {
  keyFunder: string;
  kathy: string;
  checkWarpDeploy?: string; // Optional - not all envs have this
  warpMonitor: string;
  rebalancer: string;
}

export const mainnetDockerTags: ServiceDockerTags = {
  relayer: 'fa93b6c-20251224-132143',
  relayerRC: 'fa93b6c-20251224-132143',
  validator: 'fa93b6c-20251224-132143',
  validatorRC: 'cd94774-20251217-100437',
  scraper: 'fa93b6c-20251224-132143',
  keyFunder: 'ff24bc3-20260104-175430',
  kathy: '8da6852-20251215-172511',
  checkWarpDeploy: '8da6852-20251215-172511',
  warpMonitor: 'eda7b03-20251230-135200',
  rebalancer: 'be84fc0-20251229-194426',
};

export const testnetDockerTags: ServiceDockerTags = {
  relayer: 'cd94774-20251217-100437',
  relayerRC: 'cd94774-20251217-100437',
  validator: 'cd94774-20251217-100437',
  validatorRC: 'cd94774-20251217-100437',
  scraper: 'f50feaa-20251219-084739',
  keyFunder: '8da6852-20251215-172511',
  kathy: '8da6852-20251215-172511',
  // checkWarpDeploy not used on testnet
  warpMonitor: 'eda7b03-20251230-135200',
  rebalancer: 'be84fc0-20251229-194426',
};

/**
 * Get Docker tags for a given deployment environment.
 * @throws Error if environment is not supported (e.g., 'test')
 */
export function getDockerTagsForEnv(env: DeployEnvironment): ServiceDockerTags {
  switch (env) {
    case 'mainnet3':
      return mainnetDockerTags;
    case 'testnet4':
      return testnetDockerTags;
    default:
      throw new Error(`No docker tags configured for environment: ${env}`);
  }
}
