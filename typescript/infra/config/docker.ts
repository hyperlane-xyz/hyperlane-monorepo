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
  relayer: 'b933601-20261021-134126',
  relayerRC: 'b933601-20261021-134126',
  relayerFastPath: 'b933601-20261021-134126',
  validator: '524aac0-20260925-195006',
  validatorRC: '524aac0-20260925-195006',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: 'c776083-20261009-082029',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '957cb09-20261021-152517',
  // standalone services
  keyFunder: '957cb09-20261021-152528',
  warpMonitor: '957cb09-20261021-152528',
  rebalancer: '957cb09-20261021-152528',
  scraperProxy: '957cb09-20261021-152528',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'b933601-20261021-134126',
  relayerRC: 'b933601-20261021-134126',
  relayerFastPath: 'b933601-20261021-134126',
  validator: '524aac0-20260925-195006',
  validatorRC: '524aac0-20260925-195006',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: 'c776083-20261009-082029',
  // standalone services
  keyFunder: '957cb09-20261021-152528',
  scraperProxy: '957cb09-20261021-152528',
};
