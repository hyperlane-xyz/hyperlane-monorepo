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
  relayer: '24a8034-20261026-142944',
  relayerRC: '24a8034-20261026-142944',
  relayerFastPath: '1467e4c-20261022-004453',
  validator: '24a8034-20261026-142944',
  validatorRC: '211801c-20261022-150937',
  validatorFastPath: '211801c-20261022-150937',
  scraper: '24a8034-20261026-142944',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '957cb09-20261021-152517',
  // standalone services
  keyFunder: '7302226-20261026-134814',
  warpMonitor: '957cb09-20261021-152528',
  rebalancer: '957cb09-20261021-152528',
  scraperProxy: '8160041-20261022-172207',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '1467e4c-20261022-004453',
  relayerRC: '1467e4c-20261022-004453',
  relayerFastPath: '1467e4c-20261022-004453',
  validator: '211801c-20261022-150937',
  validatorRC: '211801c-20261022-150937',
  validatorFastPath: '211801c-20261022-150937',
  scraper: 'a717804-20261023-074850',
  // standalone services
  keyFunder: '957cb09-20261021-152528',
  scraperProxy: '8160041-20261022-172207',
};
