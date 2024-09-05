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
    readonly configFilePath: string,
    readonly runEnv: DeployEnvironment,
    readonly environmentChainNames: string[],
  ) {
    super();
  }

  async helmValues() {
    const pathRelativeToMonorepoRoot = this.configFilePath.includes(
      'typescript/infra',
    )
      ? this.configFilePath
      : path.join('typescript/infra', this.configFilePath);
    return {
      image: {
        repository: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
        tag: '3e9e2bf-20240904-174017',
      },
      configFilePath: pathRelativeToMonorepoRoot,
      fullnameOverride: this.helmReleaseName,
      environment: this.runEnv,
      chains: this.environmentChainNames,
    };
  }

  get namespace() {
    return this.runEnv;
  }

  get helmReleaseName(): string {
    const match = this.configFilePath.match(/\/([^/]+)-deployments\.yaml$/);
    const name = match ? match[1] : this.configFilePath;
    return `hyperlane-warp-route-${name.toLowerCase()}`; // helm requires lower case release names
  }
}
