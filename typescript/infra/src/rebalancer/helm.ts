import fs from 'fs';
import path from 'path';

import { getWarpCoreConfig } from '../../config/registry.js';
import { DeployEnvironment } from '../config/environment.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class RebalancerHelmManager extends HelmManager {
  static helmReleasePrefix: string = 'hyperlane-rebalancer';

  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/rebalancer',
  );

  constructor(
    public warpRouteId: string,
    public environment: DeployEnvironment,
    public registryCommit: string,
    public rebalancerConfigFile: string,
    public withMetrics: boolean,
  ) {
    super();
  }

  async runPreflightChecks() {
    const warpCoreConfig = getWarpCoreConfig(this.warpRouteId);
    if (!warpCoreConfig) {
      throw new Error(
        `Warp Route ID not found in registry: ${this.warpRouteId}`,
      );
    }

    // check if we can read a file at the rebalancer config file path
    if (!fs.existsSync(this.rebalancerConfigFile)) {
      throw new Error(
        `Rebalancer config file not found: ${this.rebalancerConfigFile}`,
      );
    }
  }

  get namespace() {
    return this.environment;
  }

  async helmValues() {
    return {
      image: {
        repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
        tag: 'ad6f664-20250401-202427',
      },
      warpRouteId: this.warpRouteId,
      rebalancerConfigFile: this.rebalancerConfigFile,
      withMetrics: this.withMetrics,
      fullnameOverride: this.helmReleaseName,
      environment: this.environment,
      hyperlane: {
        registryCommit: this.registryCommit,
      },
    };
  }

  get helmReleaseName() {
    return RebalancerHelmManager.getHelmReleaseName(this.warpRouteId);
  }

  static getHelmReleaseName(warpRouteId: string): string {
    let name = `${RebalancerHelmManager.helmReleasePrefix}-${warpRouteId
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

  // TODO: allow for a rebalancer to be uninstalled
}
