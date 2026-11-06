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
  relayer: '8930084-20261106-102431',
  relayerRC: '8930084-20261106-102431',
  relayerFastPath: '8930084-20261106-102431',
  validator: 'fe5dfda-20261104-144738',
  validatorRC: '211801c-20261022-150937',
  validatorFastPath: 'c3cf9cb-20261027-064332',
  scraper: 'd38e4f0-20261106-073950',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '957cb09-20261021-152517',
  // standalone services
  keyFunder: '0f248ed-20261104-132645',
  warpMonitor: '957cb09-20261021-152528',
  rebalancer: '957cb09-20261021-152528',
  scraperProxy: '9ef15ff-20261105-153819',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'a36ef55-20261106-082037',
  relayerRC: 'a36ef55-20261106-082037',
  relayerFastPath: 'a36ef55-20261106-082037',
  validator: '211801c-20261022-150937',
  validatorRC: '211801c-20261022-150937',
  validatorFastPath: 'c3cf9cb-20261027-064332',
  scraper: 'd38e4f0-20261106-073950',
  // standalone services
  keyFunder: '957cb09-20261021-152528',
  scraperProxy: '9ef15ff-20261105-153819',
};
