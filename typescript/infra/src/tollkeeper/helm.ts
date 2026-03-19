import path from 'path';

import {
  DockerImageRepos,
  mainnetDockerTags,
  testnetDockerTags,
} from '../../config/docker.js';
import { DeployEnvironment } from '../config/environment.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class TollkeeperHelmManager extends HelmManager {
  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/tollkeeper',
  );

  constructor(
    readonly environment: DeployEnvironment,
    readonly chains: string[],
  ) {
    super();
  }

  get namespace() {
    return this.environment;
  }

  get helmReleaseName() {
    return 'tollkeeper';
  }

  private getImageTag(): string {
    if (this.environment === 'mainnet3') {
      return mainnetDockerTags.tollkeeper;
    }
    return testnetDockerTags.tollkeeper;
  }

  async helmValues() {
    const runEnv =
      this.environment === 'mainnet3' ? 'mainnet3' : 'testnet4';

    return {
      image: {
        repository: DockerImageRepos.TOLLKEEPER,
        tag: this.getImageTag(),
      },
      hyperlane: {
        runEnv,
        chains: this.chains,
      },
    };
  }
}
