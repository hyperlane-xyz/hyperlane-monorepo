import { confirm } from '@inquirer/prompts';
import { execFileSync } from 'child_process';
import path from 'path';
import { stringify } from 'yaml';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { assert, rootLogger } from '@hyperlane-xyz/utils';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import {
  NODE_SERVICE_NAMES,
  WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
} from '../utils/consts.js';
import {
  HelmManager,
  getDeployedRegistryCommit,
  getHelmReleaseName,
  removeHelmRelease,
} from '../utils/helm.js';
import { execCmdAndParseJson, getInfraPath } from '../utils/utils.js';

import {
  type RebalancerDeploymentConfig,
  readRebalancerConfig,
} from './config.js';

export function buildRebalancerHelmValues(
  { config, deployment, runtimeConfig }: RebalancerDeploymentConfig,
  options: {
    warpRouteId: string;
    environment: DeployEnvironment;
    registryCommit: string;
    withMetrics: boolean;
    monitorOnly: boolean;
    chains: string[];
  },
) {
  assert(
    config.warpRouteId === options.warpRouteId,
    'Rebalancer warp route ID mismatch',
  );
  return {
    image: {
      repository: DockerImageRepos.NODE_SERVICES,
      tag: deployment.imageTag ?? mainnetDockerTags.rebalancer,
      ...(deployment.imageDigest ? { digest: deployment.imageDigest } : {}),
    },
    serviceName: NODE_SERVICE_NAMES.REBALANCER,
    warpRouteId: options.warpRouteId,
    withMetrics: options.withMetrics,
    fullnameOverride: getHelmReleaseName(
      options.warpRouteId,
      RebalancerHelmManager.helmReleasePrefix,
    ),
    hyperlane: {
      runEnv: options.environment,
      registryUri: `${DEFAULT_GITHUB_REGISTRY}/tree/${options.registryCommit}`,
      rebalancerConfig: runtimeConfig,
      withMetrics: options.withMetrics,
      monitorOnly: options.monitorOnly,
      chains: options.chains,
      inventorySignerProtocols: Object.keys(config.inventorySigners ?? {}),
      externalBridgeProviders: Object.keys(config.externalBridges ?? {}),
      ...(deployment.swapsXyzApiKeySecret
        ? { swapsXyzApiKeySecret: deployment.swapsXyzApiKeySecret }
        : {}),
    },
  };
}

export class RebalancerHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-rebalancer';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  private deploymentConfig?: RebalancerDeploymentConfig;
  private rebalancerChains: string[] = [];

  constructor(
    readonly warpRouteId: string,
    readonly environment: DeployEnvironment,
    readonly registryCommit: string,
    readonly rebalancerConfigFile: string,
    readonly rebalanceStrategy: string,
    readonly withMetrics: boolean,
    readonly monitorOnly: boolean = false,
  ) {
    super();
  }

  async runPreflightChecks(localConfigPath: string) {
    this.deploymentConfig = readRebalancerConfig(
      path.join(getInfraPath(), localConfigPath),
    );
    const warpCoreConfig = getWarpCoreConfig(this.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp Route ID not found in registry: ${this.warpRouteId}`,
      );
    }

    // Store chains for helm values (used for private RPC secrets)
    // Warp core config includes all strategy chains
    this.rebalancerChains = [
      ...new Set(warpCoreConfig.tokens.map((t) => t.chainName)),
    ];
  }

  get namespace() {
    return this.environment;
  }

  async helmValues() {
    assert(
      this.deploymentConfig,
      'Run rebalancer preflight before generating Helm values',
    );
    return buildRebalancerHelmValues(this.deploymentConfig, {
      warpRouteId: this.warpRouteId,
      environment: this.environment,
      registryCommit: this.registryCommit,
      withMetrics: this.withMetrics,
      monitorOnly: this.monitorOnly,
      chains: this.rebalancerChains,
    });
  }

  // Local Helm rendering never uses the shared upgrade/diff helper or kubectl.
  async renderManifest(): Promise<string> {
    return execFileSync(
      'helm',
      [
        'template',
        this.helmReleaseName,
        this.helmChartPath,
        '--namespace',
        this.namespace,
        '-f',
        '-',
      ],
      {
        input: stringify(await this.helmValues()),
        encoding: 'utf8',
      },
    );
  }

  async prepareForDeployment(): Promise<void> {
    await this.checkAndHandleExistingMonitor();
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
      } catch {
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
