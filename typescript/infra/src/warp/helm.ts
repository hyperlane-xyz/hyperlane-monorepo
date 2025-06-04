import { confirm } from '@inquirer/prompts';
import path from 'path';

import {
  ChainMap,
  IToken,
  MultiProtocolProvider,
  SealevelHypTokenAdapter,
  TokenStandard,
  WarpCore,
} from '@hyperlane-xyz/sdk';
import { difference, rootLogger } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { getRegistry, getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { HelmManager, removeHelmRelease } from '../../src/utils/helm.js';
import { execCmdAndParseJson, getInfraPath } from '../../src/utils/utils.js';

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
  static helmReleasePrefix: string = 'hyperlane-warp-route-';

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

  async runPreflightChecks(multiProtocolProvider: MultiProtocolProvider) {
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
        repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
        tag: '2b5270f-20250602-183149',
      },
      warpRouteId: this.warpRouteId,
      fullnameOverride: this.helmReleaseName,
      environment: this.runEnv,
      hyperlane: {
        chains: this.environmentChainNames,
        registryCommit: this.registryCommit,
        registryFallbackEnabled: true,
      },
    };
  }

  get namespace() {
    return this.runEnv;
  }

  get helmReleaseName() {
    return WarpRouteMonitorHelmManager.getHelmReleaseName(this.warpRouteId);
  }

  static getHelmReleaseName(warpRouteId: string): string {
    let name = `${WarpRouteMonitorHelmManager.helmReleasePrefix}${warpRouteId
      .toLowerCase()
      .replaceAll('/', '-')}`;

    // 52 because the max label length is 63, and there is an auto appended 11 char
    // suffix, e.g. `controller-revision-hash=hyperlane-warp-route-tia-mantapacific-neutron-566dc75599`
    const maxChars = 52;

    // Max out length, and it can't end with a dash.
    if (name.length > maxChars) {
      name = name.slice(0, maxChars);
      name = name.replace(/-+$/, '');
    }
    return name;
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
    const allExpectedHelmReleaseNames = Object.values(WarpRouteIds).map(
      WarpRouteMonitorHelmManager.getHelmReleaseName,
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

  async ensureAtaPayerBalanceSufficient(warpCore: WarpCore, token: IToken) {
    if (!ataPayerAlertThreshold[token.chainName]) {
      rootLogger.warn(
        `No ATA payer alert threshold set for chain: ${token.chainName}. Skipping balance check.`,
      );
      return;
    }

    const registry = getRegistry();
    const chainAddresses = registry.getChainAddresses(token.chainName);
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
