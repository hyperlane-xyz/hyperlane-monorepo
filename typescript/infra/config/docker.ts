const GCR_REGISTRY = 'gcr.io/abacus-labs-dev';

export const DockerImageNames = {
  AGENT: 'hyperlane-agent',
  MONOREPO: 'hyperlane-monorepo',
  KEYFUNDER: 'hyperlane-keyfunder',
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
  kathy: string;
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  warpMonitor: string;
  rebalancer: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: 'f9945be-20260116-154633',
  relayerRC: 'f9945be-20260116-154633',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '74d999b-20260108-145124',
  // monorepo services
  keyFunder: '74d999b-20260108-145131',
  kathy: '74d999b-20260108-145131',
  checkWarpDeploy: '74d999b-20260108-145131',
  // standalone services
  warpMonitor: '74d999b-20260108-145128',
  rebalancer: '74d999b-20260108-145129',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'f9945be-20260116-154633',
  relayerRC: 'f9945be-20260116-154633',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '74d999b-20260108-145124',
  // monorepo services
  keyFunder: '74d999b-20260108-145131',
  kathy: '74d999b-20260108-145131',
};
