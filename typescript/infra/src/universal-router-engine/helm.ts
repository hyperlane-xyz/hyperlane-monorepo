import path from 'path';

import { DEFAULT_GITHUB_REGISTRY } from '@hyperlane-xyz/registry';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { Contexts } from '../../config/contexts.js';
import {
  mainnetDockerTags,
  UniversalRouterEngineDockerImageRepo,
} from '../../config/docker.js';
import { getAgentConfig } from '../../scripts/agent-utils.js';
import { DeployEnvironment } from '../config/deploy-environment.js';
import { HelmManager } from '../utils/helm.js';
import { getInfraPath } from '../utils/utils.js';

export class UniversalRouterEngineHelmManager extends HelmManager {
  readonly helmChartPath: string = path.join(
    getInfraPath(),
    './helm/universal-router-engine',
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
    return 'universal-router-engine';
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
    const agentConfig = getAgentConfig(Contexts.Hyperlane, this.environment);

    return {
      ...envValues,
      image: {
        repository: UniversalRouterEngineDockerImageRepo,
        tag: mainnetDockerTags.universalRouterEngine,
      },
      hyperlane: {
        ...envValues.hyperlane,
        runEnv: this.environment,
        registryUri,
        chains: agentConfig.environmentChainNames,
      },
    };
  }
}
