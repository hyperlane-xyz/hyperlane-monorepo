const GHCR_REGISTRY = 'ghcr.io/hyperlane-xyz';

export const DockerImageNames = {
  AGENT: 'hyperlane-agent',
  MONOREPO: 'hyperlane-monorepo',
  KEY_FUNDER: 'hyperlane-key-funder',
  WARP_MONITOR: 'hyperlane-warp-monitor',
  REBALANCER: 'hyperlane-rebalancer',
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
  relayer: '1d56bfd-20260312-161015',
  relayerRC: '1d56bfd-20260312-161015',
  validator: '6d8f392-20260310-131412',
  validatorRC: '6d8f392-20260310-131412',
  scraper: '6d8f392-20260310-131412',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: 'c558a9f-20260304-105251',
  warpMonitor: 'c558a9f-20260304-105251',
  rebalancer: 'c558a9f-20260304-105251',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'c558a9f-20260304-105241',
  relayerRC: 'c558a9f-20260304-105241',
  validator: 'c558a9f-20260304-105241',
  validatorRC: 'c558a9f-20260304-105241',
  scraper: 'c558a9f-20260304-105241',
  // standalone services
  keyFunder: 'c558a9f-20260304-105251',
};
