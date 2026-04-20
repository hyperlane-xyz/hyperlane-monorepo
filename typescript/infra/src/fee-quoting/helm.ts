import path from 'path';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';

import { DockerImageRepos, mainnetDockerTags } from '../../config/docker.js';
import { DeployEnvironment } from '../config/environment.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';
import { readYaml } from '@hyperlane-xyz/utils/fs';

export class FeeQuotingHelmManager extends HelmManager {
  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/fee-quoting',
  );

  constructor(
    readonly environment: DeployEnvironment,
    readonly registryCommit: string,
  ) {
    super();
  }

  get namespace() {
    return this.environment;
  }

  get helmReleaseName() {
    return 'hyperlane-fee-quoting';
  }

  async helmValues() {
    const registryUri = this.registryCommit
      ? `${DEFAULT_GITHUB_REGISTRY}/tree/${this.registryCommit}`
      : DEFAULT_GITHUB_REGISTRY;

    const envValuesPath = path.join(
      this.helmChartPath,
      `values-${this.environment}.yaml`,
    );
    const envValues = readYaml<Record<string, any>>(envValuesPath);

    return {
      ...envValues,
      image: {
        repository: DockerImageRepos.FEE_QUOTING,
        tag: mainnetDockerTags.feeQuoting,
      },
      hyperlane: {
        ...envValues.hyperlane,
        runEnv: this.environment,
        registryUri,
      },
    };
  }
}
