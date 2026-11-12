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
  relayer: '5ad5b80-20261110-185813',
  relayerRC: '5ad5b80-20261110-185813',
  relayerFastPath: '5ad5b80-20261110-185813',
  validator: '5ad5b80-20261110-185813',
  validatorRC: '5ad5b80-20261110-185813',
  validatorFastPath: '5ad5b80-20261110-185813',
  scraper: '1917f23-20261112-090546',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '957cb09-20261021-152517',
  // standalone services
  keyFunder: '3c19f58-20261110-174232',
  warpMonitor: '957cb09-20261021-152528',
  rebalancer: '957cb09-20261021-152528',
  scraperProxy: '1917f23-20261112-092009',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'e492f45-20261110-131529',
  relayerRC: 'e492f45-20261110-131529',
  relayerFastPath: 'e492f45-20261110-131529',
  validator: '63fa540-20261110-120849',
  validatorRC: '63fa540-20261110-120849',
  validatorFastPath: '63fa540-20261110-120849',
  scraper: '1917f23-20261112-090546',
  // standalone services
  keyFunder: '957cb09-20261021-152528',
  scraperProxy: '1917f23-20261112-092009',
};
