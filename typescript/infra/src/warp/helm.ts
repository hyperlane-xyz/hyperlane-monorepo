import { confirm } from '@inquirer/prompts';
import path from 'path';

import { difference } from '@hyperlane-xyz/utils';

import { WarpRouteIds } from '../../config/environments/mainnet3/warp/warpIds.js';
import { DeployEnvironment } from '../../src/config/environment.js';
import { HelmManager, removeHelmRelease } from '../../src/utils/helm.js';
import { execCmdAndParseJson, getInfraPath } from '../../src/utils/utils.js';

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
  ) {
    super();
  }

  async helmValues() {
    return {
      image: {
        repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
        tag: 'b18ab47-20250114-203624',
      },
      warpRouteId: this.warpRouteId,
      fullnameOverride: this.helmReleaseName,
      environment: this.runEnv,
      hyperlane: {
        chains: this.environmentChainNames,
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
      console.log(
        `Unknown Warp Monitor Helm Release: ${helmRelease} (possibly a release from a stale Warp Route ID).`,
      );
      const uninstall = await confirm({
        message:
          "Would you like to uninstall this Helm Release? Make extra sure it shouldn't exist!",
      });
      if (uninstall) {
        console.log(`Uninstalling Helm Release: ${helmRelease}`);
        await removeHelmRelease(helmRelease, namespace);
      } else {
        console.log(`Skipping uninstall of Helm Release: ${helmRelease}`);
      }
    }
  }
}
