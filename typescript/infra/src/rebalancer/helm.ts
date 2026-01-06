import fs from 'fs';
import path from 'path';
import { fromZodError } from 'zod-validation-error';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
} from '@hyperlane-xyz/rebalancer';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { isObjEmpty } from '@hyperlane-xyz/utils';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { DockerImageRepos, getDockerTagsForEnv } from '../../config/docker.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../config/environment.js';
import { WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX } from '../utils/consts.js';
import { HelmManager, getHelmReleaseName } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class RebalancerHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-rebalancer';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  private rebalancerConfigContent: string = '';

  constructor(
    readonly warpRouteId: string,
    readonly environment: DeployEnvironment,
    readonly registryCommit: string,
    readonly rebalancerConfigFile: string,
    readonly rebalanceStrategy: string,
    readonly withMetrics: boolean,
  ) {
    super();
  }

  async runPreflightChecks(localConfigPath: string) {
    const monitorReleaseName = getHelmReleaseName(
      this.warpRouteId,
      WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
    );
    if (
      await HelmManager.doesHelmReleaseExist(monitorReleaseName, this.namespace)
    ) {
      throw new Error(
        `Warp route monitor for ${this.warpRouteId} already exists. Only one of rebalancer or monitor is allowed.`,
      );
    }

    const warpCoreConfig = getWarpCoreConfig(this.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp Route ID not found in registry: ${this.warpRouteId}`,
      );
    }

    const rebalancerConfigFile = path.join(getInfraPath(), localConfigPath);

    // Validate the rebalancer config file
    const config: RebalancerConfigFileInput = readYaml(rebalancerConfigFile);
    const validationResult = RebalancerConfigSchema.safeParse(config);
    if (!validationResult.success) {
      throw new Error(fromZodError(validationResult.error).message);
    }

    const { chains } = validationResult.data.strategy;
    if (isObjEmpty(chains)) {
      throw new Error('No chains configured');
    }

    // Store the config file content for helm values
    this.rebalancerConfigContent = fs.readFileSync(
      rebalancerConfigFile,
      'utf8',
    );
  }

  get namespace() {
    return this.environment;
  }

  async helmValues() {
    const registryUri = `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;

    return {
      image: {
        repository: DockerImageRepos.REBALANCER,
        tag: getDockerTagsForEnv(this.environment).rebalancer,
      },
      withMetrics: this.withMetrics,
      fullnameOverride: this.helmReleaseName,
      hyperlane: {
        runEnv: this.environment,
        registryUri,
        rebalancerConfig: this.rebalancerConfigContent,
        withMetrics: this.withMetrics,
      },
    };
  }

  get helmReleaseName() {
    return getHelmReleaseName(
      this.warpRouteId,
      RebalancerHelmManager.helmReleasePrefix,
    );
  }

  // TODO: allow for a rebalancer to be uninstalled
}
