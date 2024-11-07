import path from 'path';

import { DeployEnvironment } from '../../src/config/environment.js';
import { HelmManager } from '../../src/utils/helm.js';
import { getInfraPath } from '../../src/utils/utils.js';

export class WarpRouteMonitorHelmManager extends HelmManager {
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
        tag: 'ef7a886-20241101-165749',
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

  get helmReleaseName(): string {
    let name = `hyperlane-warp-route-${this.warpRouteId
      .toLowerCase()
      .replaceAll('/', '-')}`;

    // Max helm release length is 53 characters, and it can't end with a dash
    if (name.length > 53) {
      name = name.slice(0, 53);
      name = name.replace(/-+$/, '');
    }
    return name;
  }
}
