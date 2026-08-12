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
import type { RebalancerFleetDefinition } from '../../config/environments/mainnet3/rebalancer/fleets.js';
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

interface RebalancerConfigDetails {
  content: string;
  chains: string[];
  inventorySignerProtocols: string[];
}

interface RebalancerConfigFile {
  name: string;
  content: string;
}

export function getRebalancerConfigPath(
  environment: DeployEnvironment,
  warpRouteId: string,
): string {
  return path.join(
    'config/environments',
    environment,
    'rebalancer',
    `${warpRouteId}-config.yaml`,
  );
}

export function getRebalancerFleetConfigFileName(warpRouteId: string): string {
  return `${warpRouteId.toLowerCase().replaceAll('/', '-')}-config.yaml`;
}

function readRebalancerConfig(
  warpRouteId: string,
  rebalancerConfigFile: string,
): RebalancerConfigDetails {
  const warpCoreConfig = getWarpCoreConfig(warpRouteId);

  const config: RebalancerConfigFileInput = readYaml(rebalancerConfigFile);
  const validationResult = RebalancerConfigSchema.safeParse(config);
  if (!validationResult.success) {
    throw new Error(fromZodError(validationResult.error).message);
  }

  const chainNames = getStrategyChainNames(validationResult.data.strategy);
  if (chainNames.length === 0) {
    throw new Error('No chains configured');
  }

  return {
    content: fs.readFileSync(rebalancerConfigFile, 'utf8'),
    chains: [...new Set(warpCoreConfig.tokens.map((token) => token.chainName))],
    inventorySignerProtocols: Object.keys(
      validationResult.data.inventorySigners ?? {},
    ),
  };
}

async function checkAndHandleExistingMonitor(
  warpRouteId: string,
  namespace: string,
): Promise<void> {
  const monitorReleaseName = getHelmReleaseName(
    warpRouteId,
    WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
  );

  if (
    !(await HelmManager.doesHelmReleaseExist(monitorReleaseName, namespace))
  ) {
    return;
  }

  const shouldReplace = await confirm({
    message: `A warp route monitor exists for ${warpRouteId}. The rebalancer includes monitoring functionality. Would you like to replace the monitor with the rebalancer?`,
  });

  if (!shouldReplace) {
    throw new Error(
      `Deployment aborted: User chose not to replace existing monitor for ${warpRouteId}.`,
    );
  }

  rootLogger.info(`Uninstalling existing warp monitor: ${monitorReleaseName}`);
  await removeHelmRelease(monitorReleaseName, namespace);
  rootLogger.info(
    `Successfully uninstalled warp monitor: ${monitorReleaseName}`,
  );
}

export class RebalancerHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-rebalancer';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  private rebalancerConfigContent: string = '';
  private rebalancerChains: string[] = [];
  private inventorySignerProtocols: string[] = [];

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
    await checkAndHandleExistingMonitor(this.warpRouteId, this.namespace);

    const rebalancerConfigFile = path.join(getInfraPath(), localConfigPath);
    const configDetails = readRebalancerConfig(
      this.warpRouteId,
      rebalancerConfigFile,
    );

    this.rebalancerChains = configDetails.chains;
    this.rebalancerConfigContent = configDetails.content;
    this.inventorySignerProtocols = configDetails.inventorySignerProtocols;
  }

  get namespace() {
    return this.environment;
  }

  async helmValues() {
    const registryUri = `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;

    return {
      image: {
        repository: DockerImageRepos.NODE_SERVICES,
        tag: mainnetDockerTags.rebalancer,
      },
      serviceName: NODE_SERVICE_NAMES.REBALANCER,
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
        inventorySignerProtocols: this.inventorySignerProtocols,
      },
    };
  }

  get helmReleaseName() {
    return getHelmReleaseName(
      this.warpRouteId,
      RebalancerHelmManager.helmReleasePrefix,
    );
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
    const matchedFleetReleases = new Set<string>();

    for (const {
      warpRouteId,
      helmReleaseName,
      isFleet,
    } of deployedRebalancers) {
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

      if (isFleet && matchedFleetReleases.has(helmReleaseName)) {
        continue;
      }

      const minimalManagerId = isFleet
        ? helmReleaseName.slice(
            `${RebalancerHelmManager.helmReleasePrefix}-`.length,
          )
        : warpRouteId;

      // Create a minimal manager for RPC rotation (only needs helmReleaseName and namespace)
      helmManagers.push(
        new RebalancerHelmManager(
          minimalManagerId,
          environment,
          '', // registryCommit not needed for refresh
          '', // rebalancerConfigFile not needed for refresh
          '', // rebalanceStrategy not needed for refresh
          false, // withMetrics not needed for refresh
        ),
      );

      if (isFleet) {
        matchedFleetReleases.add(helmReleaseName);
      }
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

export class RebalancerFleetHelmManager extends HelmManager {
  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  private readonly releaseName: string;
  private rebalancerConfigFiles: RebalancerConfigFile[] = [];
  private rebalancerChains: string[] = [];
  private inventorySignerProtocols: string[] = [];

  constructor(
    readonly fleet: RebalancerFleetDefinition,
    readonly environment: DeployEnvironment,
    readonly registryCommit: string,
    readonly withMetrics: boolean,
  ) {
    super();

    this.releaseName = getHelmReleaseName(
      fleet.name,
      RebalancerHelmManager.helmReleasePrefix,
    );
    const untruncatedReleaseName = `${RebalancerHelmManager.helmReleasePrefix}-${fleet.name.toLowerCase().replaceAll('/', '-')}`;
    if (this.releaseName !== untruncatedReleaseName) {
      throw new Error(
        `Rebalancer fleet Helm release name exceeds the 52-character limit: ${untruncatedReleaseName}`,
      );
    }
  }

  async runPreflightChecks(): Promise<void> {
    const configFiles: RebalancerConfigFile[] = [];
    const chains = new Set<string>();
    const inventorySignerProtocols = new Set<string>();

    for (const warpRouteId of this.fleet.warpRouteIds) {
      const configFile = path.join(
        getInfraPath(),
        getRebalancerConfigPath(this.environment, warpRouteId),
      );
      const configDetails = readRebalancerConfig(warpRouteId, configFile);

      configFiles.push({
        name: getRebalancerFleetConfigFileName(warpRouteId),
        content: configDetails.content,
      });
      configDetails.chains.forEach((chain) => chains.add(chain));
      configDetails.inventorySignerProtocols.forEach((protocol) =>
        inventorySignerProtocols.add(protocol),
      );
    }

    // Collect all existing warp monitors first and confirm ONCE before
    // uninstalling any, so declining can never leave earlier members with
    // their monitor removed but no fleet installed.
    const existingMonitors: { warpRouteId: string; releaseName: string }[] = [];
    for (const warpRouteId of this.fleet.warpRouteIds) {
      const releaseName = getHelmReleaseName(
        warpRouteId,
        WARP_ROUTE_MONITOR_HELM_RELEASE_PREFIX,
      );
      if (await HelmManager.doesHelmReleaseExist(releaseName, this.namespace)) {
        existingMonitors.push({ warpRouteId, releaseName });
      }
    }

    if (existingMonitors.length > 0) {
      const monitorIds = existingMonitors
        .map(({ warpRouteId }) => warpRouteId)
        .join(', ');
      const shouldReplace = await confirm({
        message: `Warp route monitors exist for fleet members: ${monitorIds}. The rebalancer includes monitoring functionality. Replace ALL of them with the fleet rebalancer?`,
      });
      if (!shouldReplace) {
        throw new Error(
          `Deployment aborted: User chose not to replace existing monitors for fleet ${this.fleet.name}.`,
        );
      }

      for (const { releaseName } of existingMonitors) {
        rootLogger.info(`Uninstalling existing warp monitor: ${releaseName}`);
        await removeHelmRelease(releaseName, this.namespace);
        rootLogger.info(
          `Successfully uninstalled warp monitor: ${releaseName}`,
        );
      }
    }

    this.rebalancerConfigFiles = configFiles;
    this.rebalancerChains = [...chains];
    this.inventorySignerProtocols = [...inventorySignerProtocols];
  }

  get namespace() {
    return this.environment;
  }

  get helmReleaseName() {
    return this.releaseName;
  }

  async helmValues() {
    const registryUri = `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;

    return {
      image: {
        repository: DockerImageRepos.NODE_SERVICES,
        tag: mainnetDockerTags.rebalancer,
      },
      serviceName: NODE_SERVICE_NAMES.REBALANCER,
      withMetrics: this.withMetrics,
      fullnameOverride: this.helmReleaseName,
      hyperlane: {
        runEnv: this.environment,
        registryUri,
        rebalancerConfigFiles: this.rebalancerConfigFiles,
        warpRouteIds: this.fleet.warpRouteIds,
        withMetrics: this.withMetrics,
        chains: this.rebalancerChains,
        inventorySignerProtocols: this.inventorySignerProtocols,
      },
    };
  }

  static getDeployedRegistryCommit(
    fleetName: string,
    environment: DeployEnvironment,
  ): Promise<string | undefined> {
    return getDeployedRegistryCommit(
      fleetName,
      environment,
      RebalancerHelmManager.helmReleasePrefix,
    );
  }
}

export interface RebalancerPodInfo {
  helmReleaseName: string;
  warpRouteId: string;
  isFleet: boolean;
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

    let warpRouteIds: string[] = [];
    let isFleet = false;

    for (const container of pod.spec?.containers || []) {
      const warpRouteIdsEnv = (container.env || []).find(
        (env: { name: string; value?: string }) =>
          env.name === 'WARP_ROUTE_IDS',
      );
      if (warpRouteIdsEnv?.value) {
        warpRouteIds = warpRouteIdsEnv.value
          .split(',')
          .map((warpRouteId: string) => warpRouteId.trim())
          .filter(Boolean);
        isFleet = true;
        break;
      }

      // Check WARP_ROUTE_ID env var
      const warpRouteIdEnv = (container.env || []).find(
        (e: { name: string; value?: string }) => e.name === 'WARP_ROUTE_ID',
      );
      if (warpRouteIdEnv?.value) {
        warpRouteIds = [warpRouteIdEnv.value];
        break;
      }

      // Check --warpRouteId in command or args
      const allArgs: string[] = [
        ...(container.command || []),
        ...(container.args || []),
      ];
      const warpRouteIdArgIndex = allArgs.indexOf('--warpRouteId');
      if (warpRouteIdArgIndex !== -1 && allArgs[warpRouteIdArgIndex + 1]) {
        warpRouteIds = [allArgs[warpRouteIdArgIndex + 1]];
        break;
      }
    }

    // Fallback: parse warpRouteId from configmap (for existing deployments without env var)
    if (warpRouteIds.length === 0) {
      try {
        const configMapName = `${helmReleaseName}-config`;
        const cm = await execCmdAndParseJson(
          `kubectl get configmap ${configMapName} -n ${namespace} -o json`,
        );
        const configYaml = cm.data?.['rebalancer-config.yaml'];
        if (configYaml) {
          const match = configYaml.match(/^warpRouteId:\s*(.+)$/m);
          const warpRouteId = match?.[1]?.trim();
          if (warpRouteId) {
            warpRouteIds = [warpRouteId];
          }
        }
      } catch (error) {
        rootLogger.debug(`Failed to read configmap for ${helmReleaseName}`, {
          error,
        });
      }
    }

    if (warpRouteIds.length > 0) {
      for (const warpRouteId of warpRouteIds) {
        rebalancerPods.push({ helmReleaseName, warpRouteId, isFleet });
      }
    } else {
      rootLogger.warn(
        `Could not extract warp route ID from rebalancer pod with helm release: ${helmReleaseName}. Skipping.`,
      );
    }
  }

  return rebalancerPods;
}
