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
  relayer: '01ccfea-20260908-170823',
  relayerRC: '01ccfea-20260908-170823',
  relayerFastPath: '01ccfea-20260908-170823',
  validator: '01ccfea-20260908-170823',
  validatorRC: '01ccfea-20260908-170823',
  validatorFastPath: '01ccfea-20260908-170823',
  scraper: '01ccfea-20260908-170823',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: '01ccfea-20260908-170716',
  warpMonitor: '01ccfea-20260908-170716',
  rebalancer: '01ccfea-20260908-170716',
  scraperProxy: '01ccfea-20260908-170716',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '01ccfea-20260908-170823',
  relayerRC: '01ccfea-20260908-170823',
  relayerFastPath: '01ccfea-20260908-170823',
  validator: '01ccfea-20260908-170823',
  validatorRC: '01ccfea-20260908-170823',
  validatorFastPath: '01ccfea-20260908-170823',
  scraper: '01ccfea-20260908-170823',
  // standalone services
  keyFunder: '01ccfea-20260908-170716',
  scraperProxy: '01ccfea-20260908-170716',
};
