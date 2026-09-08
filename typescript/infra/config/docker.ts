const GHCR_REGISTRY = 'ghcr.io/hyperlane-xyz';

export const DockerImageNames = {
  AGENT: 'hyperlane-agent',
  MONOREPO: 'hyperlane-monorepo',
  NODE_SERVICES: 'hyperlane-node-services',
  FEE_QUOTING: 'hyperlane-fee-quoting',
} as const;

type DockerImageReposType = {
  [K in keyof typeof DockerImageNames]: `${typeof GHCR_REGISTRY}/${(typeof DockerImageNames)[K]}`;
};

export const DockerImageRepos = Object.fromEntries(
  Object.entries(DockerImageNames).map(([key, name]) => [
    key,
    `${GHCR_REGISTRY}/${name}`,
  ]),
) as DockerImageReposType;

interface AgentDockerTags {
  relayer: string;
  relayerRC: string;
  relayerFastPath: string;
  validator: string;
  validatorRC: string;
  validatorFastPath: string;
  scraper: string;
}

interface BaseDockerTags extends AgentDockerTags {
  keyFunder: string;
  scraperProxy: string;
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  validatorMonitor: string;
  warpMonitor: string;
  rebalancer: string;
  feeQuoting: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '98c7f55-20260908-174457',
  relayerRC: '98c7f55-20260908-174457',
  relayerFastPath: '98c7f55-20260908-174457',
  validator: '98c7f55-20260908-174457',
  validatorRC: '98c7f55-20260908-174457',
  validatorFastPath: '98c7f55-20260908-174457',
  scraper: '98c7f55-20260908-174457',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  warpMonitor: 'fc544bf-20260908-174702',
  rebalancer: 'fc544bf-20260908-174702',
  scraperProxy: 'fc544bf-20260908-174702',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '98c7f55-20260908-174457',
  relayerRC: '98c7f55-20260908-174457',
  relayerFastPath: '98c7f55-20260908-174457',
  validator: '98c7f55-20260908-174457',
  validatorRC: '98c7f55-20260908-174457',
  validatorFastPath: '98c7f55-20260908-174457',
  scraper: '98c7f55-20260908-174457',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  scraperProxy: 'fc544bf-20260908-174702',
};
