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
        tag: '6cd61f1-20241112-111341',
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
}
