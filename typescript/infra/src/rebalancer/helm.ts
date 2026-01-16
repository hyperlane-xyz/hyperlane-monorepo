import { confirm } from '@inquirer/prompts';
import fs from 'fs';
import path from 'path';
import { fromZodError } from 'zod-validation-error';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
} from '@hyperlane-xyz/rebalancer';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { isObjEmpty, rootLogger } from '@hyperlane-xyz/utils';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../config/environment.js';
import { WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX } from '../utils/consts.js';
import {
  HelmManager,
  getHelmReleaseName,
  removeHelmRelease,
} from '../utils/helm.js';
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
    await this.checkAndHandleExistingMonitor();

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
        tag: mainnetDockerTags.rebalancer,
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

  private async checkAndHandleExistingMonitor(): Promise<void> {
    const monitorReleaseName = getHelmReleaseName(
      this.warpRouteId,
      WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
    );

    if (
      await HelmManager.doesHelmReleaseExist(monitorReleaseName, this.namespace)
    ) {
      const shouldReplace = await confirm({
        message: `A warp route monitor exists for ${this.warpRouteId}. The rebalancer includes monitoring functionality. Would you like to replace the monitor with the rebalancer?`,
      });

      if (!shouldReplace) {
        throw new Error(
          `Deployment aborted: User chose not to replace existing monitor for ${this.warpRouteId}.`,
        );
      }

      rootLogger.info(
        `Uninstalling existing warp monitor: ${monitorReleaseName}`,
      );
      await removeHelmRelease(monitorReleaseName, this.namespace);
      rootLogger.info(
        `Successfully uninstalled warp monitor: ${monitorReleaseName}`,
      );
    }
  }

  // TODO: allow for a rebalancer to be uninstalled
}
