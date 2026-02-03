const GCR_REGISTRY = 'gcr.io/abacus-labs-dev';

export const DockerImageNames = {
  AGENT: 'hyperlane-agent',
  MONOREPO: 'hyperlane-monorepo',
  KEY_FUNDER: 'hyperlane-key-funder',
  WARP_MONITOR: 'hyperlane-warp-monitor',
  REBALANCER: 'hyperlane-rebalancer',
} as const;

type DockerImageReposType = {
  [K in keyof typeof DockerImageNames]: `${typeof GCR_REGISTRY}/${(typeof DockerImageNames)[K]}`;
};

export const DockerImageRepos = Object.fromEntries(
  Object.entries(DockerImageNames).map(([key, name]) => [
    key,
    `${GCR_REGISTRY}/${name}`,
  ]),
) as DockerImageReposType;

interface AgentDockerTags {
  relayer: string;
  relayerRC: string;
  validator: string;
  validatorRC: string;
  scraper: string;
}

interface BaseDockerTags extends AgentDockerTags {
  keyFunder: string;
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  warpMonitor: string;
  rebalancer: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: 'c6a879a-20260202-160824',
  relayerRC: 'c6a879a-20260202-160824',
  validator: 'a52b9e6-20260122-173915',
  validatorRC: 'a52b9e6-20260122-173915',
  scraper: 'bb96c74-20260129-145233',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: 'b29a170-20260128-174848',
  warpMonitor: '6b6fd0b-20260123-121413',
  rebalancer: 'c7bcc0e-20260202-155951',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'c6a879a-20260202-160824',
  relayerRC: 'c6a879a-20260202-160824',
  validator: 'eeadda5-20260129-131050',
  validatorRC: 'eeadda5-20260129-131050',
  scraper: 'bb96c74-20260129-145233',
  // standalone services
  keyFunder: 'b29a170-20260128-174848',
};
