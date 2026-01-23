import { confirm } from '@inquirer/prompts';
import path from 'path';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import {
  ChainMap,
  IToken,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { difference, rootLogger } from '@hyperlane-xyz/utils';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { getRegistry, getWarpCoreConfig } from '../../config/registry.js';
import { getEnvironmentConfig } from '../../scripts/core-utils.js';
import { DeployEnvironment } from '../config/environment.js';
import { REBALANCER_HELM_RELEASE_PREFIX } from '../utils/consts.js';
import {
  HelmManager,
  getHelmReleaseName,
  removeHelmRelease,
} from '../utils/helm.js';
import { execCmdAndParseJson, getInfraPath } from '../utils/utils.js';

// TODO: once we have automated tooling for ATA payer balances and a
// consolidated source of truth, move away from this hardcoded setup.
const ataPayerAlertThreshold: ChainMap<number> = {
  eclipsemainnet: 0.01,
  solanamainnet: 0.2,
  soon: 0.01,
  sonicsvm: 0.1,
};

// Require the ATA payer balance to be at least this factor of the minimum,
// i.e. 15% higher than the alert threshold.
const minAtaPayerBalanceFactor: number = 1.15;

export class WarpRouteMonitorHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-warp-route';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/warp-routes',
  );

  constructor(
    readonly warpRouteId: string,
    readonly runEnv: DeployEnvironment,
    readonly environmentChainNames: string[],
    readonly registryCommit: string,
  ) {
    super();
  }

  private get registryUri(): string {
    // If no commit specified, use the default registry URL without /tree/ suffix
    if (!this.registryCommit) {
      return DEFAULT_GITHUB_REGISTRY;
    }
    // Build registry URI with commit embedded in /tree/{commit} format
    return `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`;
  }

  async runPreflightChecks(multiProtocolProvider: MultiProtocolProvider) {
    const rebalancerReleaseName = getHelmReleaseName(
      this.warpRouteId,
      REBALANCER_HELM_RELEASE_PREFIX,
    );
    if (
      await HelmManager.doesHelmReleaseExist(
        rebalancerReleaseName,
        this.namespace,
      )
    ) {
      throw new Error(
        `Rebalancer for warp route ${this.warpRouteId} already exists. Only one of rebalancer or monitor is allowed.`,
      );
    }

    const warpCoreConfig = getWarpCoreConfig(this.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp Route ID not found in registry: ${this.warpRouteId}`,
      );
    }

    const warpCore = WarpCore.FromConfig(multiProtocolProvider, warpCoreConfig);

    for (const token of warpCore.tokens) {
      // If the token is a SealevelHypCollateral or SealevelHypSynthetic, we need to ensure
      // the ATA payer is sufficiently funded.
      if (
        token.standard === TokenStandard.SealevelHypCollateral ||
        token.standard === TokenStandard.SealevelHypSynthetic
      ) {
        await this.ensureAtaPayerBalanceSufficient(warpCore, token);
      }
    }
  }

  async helmValues() {
    return {
      image: {
        repository: DockerImageRepos.WARP_MONITOR,
        tag: mainnetDockerTags.warpMonitor,
      },
      warpRouteId: this.warpRouteId,
      fullnameOverride: this.helmReleaseName,
      hyperlane: {
        chains: this.environmentChainNames,
        registryUri: this.registryUri,
      },
    };
  }

  get namespace() {
    return this.runEnv;
  }

  get helmReleaseName() {
    return getHelmReleaseName(
      this.warpRouteId,
      WarpRouteMonitorHelmManager.helmReleasePrefix,
    );
  }

  /**
   * Get the registry commit from a deployed warp monitor's helm values.
   * Returns undefined if the release doesn't exist or has no registry commit.
   */
  static async getDeployedRegistryCommit(
    warpRouteId: string,
    namespace: string,
  ): Promise<string | undefined> {
    const helmReleaseName = getHelmReleaseName(
      warpRouteId,
      WarpRouteMonitorHelmManager.helmReleasePrefix,
    );
    try {
      const values = await execCmdAndParseJson(
        `helm get values ${helmReleaseName} --namespace ${namespace} -o json`,
      );

      // Standalone image: registryUri contains /tree/{commit}
      const registryUri = values?.hyperlane?.registryUri;
      if (registryUri) {
        const match = registryUri.match(/\/tree\/(.+)$/);
        if (match?.[1]) return match[1];
      }

      // Legacy monorepo image: REGISTRY_COMMIT in env config
      const registryCommit = values?.hyperlane?.registryCommit;
      if (registryCommit) return registryCommit;
    } catch {
      // Release doesn't exist
    }
    return undefined;
  }

  // Gets all Warp Monitor Helm Releases in the given namespace.
  static async getWarpMonitorHelmReleases(
    namespace: string,
  ): Promise<string[]> {
    const results = await execCmdAndParseJson(
      `helm list --filter '${WarpRouteMonitorHelmManager.helmReleasePrefix}.+' -o json -n ${namespace}`,
    );
    return results.map((r: any) => r.name);
  }

  // This method is used to uninstall any stale Warp Monitors.
  // This can happen if a Warp Route ID is changed or removed.
  // Any warp monitor helm releases found that do not relate to known warp route ids
  // will be prompted for uninstallation.
  static async uninstallUnknownWarpMonitorReleases(namespace: string) {
    const localRegistry = getRegistry();
    const warpRouteIds = Object.keys(localRegistry.getWarpRoutes());
    const allExpectedHelmReleaseNames = warpRouteIds.map((warpRouteId) =>
      getHelmReleaseName(
        warpRouteId,
        WarpRouteMonitorHelmManager.helmReleasePrefix,
      ),
    );
    const helmReleases =
      await WarpRouteMonitorHelmManager.getWarpMonitorHelmReleases(namespace);

    const unknownHelmReleases = difference(
      new Set(helmReleases),
      new Set(allExpectedHelmReleaseNames),
    );
    for (const helmRelease of unknownHelmReleases) {
      rootLogger.warn(
        `Unknown Warp Monitor Helm Release: ${helmRelease} (possibly a release from a stale Warp Route ID).`,
      );
      const uninstall = await confirm({
        message:
          "Would you like to uninstall this Helm Release? Make extra sure it shouldn't exist!",
      });
      if (uninstall) {
        rootLogger.info(`Uninstalling Helm Release: ${helmRelease}`);
        await removeHelmRelease(helmRelease, namespace);
      } else {
        rootLogger.info(`Skipping uninstall of Helm Release: ${helmRelease}`);
      }
    }
  }

  static async getManagersForChain(
    environment: DeployEnvironment,
    chain: string,
  ): Promise<WarpRouteMonitorHelmManager[]> {
    const deployedMonitors = await getDeployedWarpMonitorWarpRouteIds(
      environment,
      WarpRouteMonitorHelmManager.helmReleasePrefix,
    );

    const envConfig = getEnvironmentConfig(environment);
    const helmManagers: WarpRouteMonitorHelmManager[] = [];

    for (const { warpRouteId } of deployedMonitors) {
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

      helmManagers.push(
        new WarpRouteMonitorHelmManager(
          warpRouteId,
          environment,
          envConfig.supportedChainNames,
          '',
        ),
      );
    }

    return helmManagers;
  }

  async ensureAtaPayerBalanceSufficient(warpCore: WarpCore, token: IToken) {
    if (!ataPayerAlertThreshold[token.chainName]) {
      rootLogger.warn(
        `No ATA payer alert threshold set for chain: ${token.chainName}. Skipping balance check.`,
      );
      return;
    }

    const localRegistry = getRegistry();
    const chainAddresses = localRegistry.getChainAddresses(token.chainName);
    warpCore.multiProvider.metadata[token.chainName] = {
      ...warpCore.multiProvider.metadata[token.chainName],
      // Hack to get the Mailbox address into the metadata, which WarpCore requires for Sealevel chains.
      // This should probably be refactored in the SDK at some point.
      // @ts-ignore
      mailbox: chainAddresses.mailbox,
    };

    const adapter = token.getAdapter(
      warpCore.multiProvider,
    ) as SealevelHypTokenAdapter;
    const ataPayer = adapter.deriveAtaPayerAccount();
    const provider = adapter.multiProvider.getSolanaWeb3Provider(
      token.chainName,
    );
    const ataPayerBalanceLamports = await provider.getBalance(ataPayer);
    const ataPayerBalance = ataPayerBalanceLamports / 1e9;

    const desiredBalance =
      ataPayerAlertThreshold[token.chainName] * minAtaPayerBalanceFactor;
    if (ataPayerBalance < desiredBalance) {
      rootLogger.warn(
        `WARNING: ATA payer balance for ${
          token.chainName
        } is below the alert threshold. Desired balance: ${desiredBalance}, current balance: ${ataPayerBalance}. Please fund the ATA payer account: ${ataPayer.toBase58()} on ${
          token.chainName
        }`,
      );
      await confirm({
        message: 'Continue?',
      });
    } else {
      rootLogger.info(
        `ATA payer balance for ${
          token.chainName
        } is sufficient. Current balance: ${ataPayerBalance}, ATA payer: ${ataPayer.toBase58()}`,
      );
    }
  }
}

export interface WarpMonitorPodInfo {
  helmReleaseName: string;
  warpRouteId: string;
}

export async function getDeployedWarpMonitorWarpRouteIds(
  namespace: string,
  helmReleasePrefix: string,
): Promise<WarpMonitorPodInfo[]> {
  const podsResult = await execCmdAndParseJson(
    `kubectl get pods -n ${namespace} -o json`,
  );

  const warpMonitorPods: WarpMonitorPodInfo[] = [];

  for (const pod of podsResult.items || []) {
    const helmReleaseName =
      pod.metadata?.labels?.['app.kubernetes.io/instance'];

    if (!helmReleaseName?.startsWith(helmReleasePrefix)) {
      continue;
    }

    let warpRouteId: string | undefined;

    for (const container of pod.spec?.containers || []) {
      // Standalone image: WARP_ROUTE_ID env var
      const warpRouteIdEnv = (container.env || []).find(
        (e: { name: string; value?: string }) => e.name === 'WARP_ROUTE_ID',
      );
      if (warpRouteIdEnv?.value) {
        warpRouteId = warpRouteIdEnv.value;
        break;
      }

      // Legacy monorepo image: --warpRouteId in command or args
      // Some pods use container.command, others use container.args
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

    if (warpRouteId) {
      warpMonitorPods.push({ helmReleaseName, warpRouteId });
    } else {
      rootLogger.warn(
        `Could not extract warp route ID from pod with helm release: ${helmReleaseName}. Skipping.`,
      );
    }
  }

  return warpMonitorPods;
}
