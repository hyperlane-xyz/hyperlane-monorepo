import { confirm } from '@inquirer/prompts';
import fs from 'fs';
import path from 'path';
import { fromZodError } from 'zod-validation-error';

import {
  type RebalancerConfigFileInput,
  RebalancerConfigSchema,
  getStrategyChainNames,
} from '@hyperlane-xyz/rebalancer';
import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { rootLogger } from '@hyperlane-xyz/utils';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../config/environment.js';
import { WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX } from '../utils/consts.js';
import {
  HelmManager,
  getDeployedRegistryCommit,
  getHelmReleaseName,
  removeHelmRelease,
} from '../utils/helm.js';
import { execCmdAndParseJson, getInfraPath } from '../utils/utils.js';

export class RebalancerHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-rebalancer';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  private rebalancerConfigContent: string = '';
  private rebalancerChains: string[] = [];

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

    const chainNames = getStrategyChainNames(validationResult.data.strategy);
    if (chainNames.length === 0) {
      throw new Error('No chains configured');
    }

    // Store chains for helm values (used for private RPC secrets)
    // Warp core config includes all strategy chains
    this.rebalancerChains = [
      ...new Set(warpCoreConfig.tokens.map((t) => t.chainName)),
    ];

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
      warpRouteId: this.warpRouteId,
      withMetrics: this.withMetrics,
      fullnameOverride: this.helmReleaseName,
      hyperlane: {
        runEnv: this.environment,
        registryUri,
        rebalancerConfig: this.rebalancerConfigContent,
        withMetrics: this.withMetrics,
        // Used for fetching private RPC secrets
        chains: this.rebalancerChains,
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

  /**
   * Get all deployed rebalancers that include the given chain.
   * Used by RPC rotation to refresh rebalancer pods when RPCs change.
   */
  static async getManagersForChain(
    environment: DeployEnvironment,
    chain: string,
  ): Promise<RebalancerHelmManager[]> {
    const deployedRebalancers = await getDeployedRebalancerWarpRouteIds(
      environment,
      RebalancerHelmManager.helmReleasePrefix,
    );

    const helmManagers: RebalancerHelmManager[] = [];

    for (const { warpRouteId } of deployedRebalancers) {
      let warpCoreConfig;
      try {
        warpCoreConfig = getWarpCoreConfig(warpRouteId);
      } catch (e) {
        continue;
      }

      const warpChains = warpCoreConfig.tokens.map((t) => t.chainName);
      if (!warpChains.includes(chain)) {
        continue;
      }

      // Create a minimal manager for RPC rotation (only needs helmReleaseName and namespace)
      helmManagers.push(
        new RebalancerHelmManager(
          warpRouteId,
          environment,
          '', // registryCommit not needed for refresh
          '', // rebalancerConfigFile not needed for refresh
          '', // rebalanceStrategy not needed for refresh
          false, // withMetrics not needed for refresh
        ),
      );
    }

    return helmManagers;
  }

  // TODO: allow for a rebalancer to be uninstalled

  static getDeployedRegistryCommit(
    warpRouteId: string,
    environment: DeployEnvironment,
  ): Promise<string | undefined> {
    return getDeployedRegistryCommit(
      warpRouteId,
      environment,
      RebalancerHelmManager.helmReleasePrefix,
    );
  }
}

export interface RebalancerPodInfo {
  helmReleaseName: string;
  warpRouteId: string;
}

/**
 * Get deployed rebalancer warp route IDs by inspecting k8s pods.
 */
export async function getDeployedRebalancerWarpRouteIds(
  namespace: string,
  helmReleasePrefix: string,
): Promise<RebalancerPodInfo[]> {
  const podsResult = await execCmdAndParseJson(
    `kubectl get pods -n ${namespace} -o json`,
  );

  const rebalancerPods: RebalancerPodInfo[] = [];

  for (const pod of podsResult.items || []) {
    const helmReleaseName =
      pod.metadata?.labels?.['app.kubernetes.io/instance'];

    if (!helmReleaseName?.startsWith(helmReleasePrefix)) {
      continue;
    }

    let warpRouteId: string | undefined;

    for (const container of pod.spec?.containers || []) {
      // Check WARP_ROUTE_ID env var
      const warpRouteIdEnv = (container.env || []).find(
        (e: { name: string; value?: string }) => e.name === 'WARP_ROUTE_ID',
      );
      if (warpRouteIdEnv?.value) {
        warpRouteId = warpRouteIdEnv.value;
        break;
      }

      // Check --warpRouteId in command or args
      const allArgs: string[] = [
        ...(container.command || []),
        ...(container.args || []),
      ];
      const warpRouteIdArgIndex = allArgs.indexOf('--warpRouteId');
      if (warpRouteIdArgIndex !== -1 && allArgs[warpRouteIdArgIndex + 1]) {
        warpRouteId = allArgs[warpRouteIdArgIndex + 1];
        break;
      }
    }

    // Fallback: parse warpRouteId from configmap (for existing deployments without env var)
    if (!warpRouteId) {
      try {
        const configMapName = `${helmReleaseName}-config`;
        const cm = await execCmdAndParseJson(
          `kubectl get configmap ${configMapName} -n ${namespace} -o json`,
        );
        const configYaml = cm.data?.['rebalancer-config.yaml'];
        if (configYaml) {
          const match = configYaml.match(/^warpRouteId:\s*(.+)$/m);
          warpRouteId = match?.[1]?.trim();
        }
      } catch (e) {
        rootLogger.debug(
          `Failed to read configmap for ${helmReleaseName}: ${e}`,
        );
      }
    }

    if (warpRouteId) {
      rebalancerPods.push({ helmReleaseName, warpRouteId });
    } else {
      rootLogger.warn(
        `Could not extract warp route ID from rebalancer pod with helm release: ${helmReleaseName}. Skipping.`,
      );
    }
  }

  return rebalancerPods;
}
