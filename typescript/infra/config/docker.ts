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
  kathy: string;
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  warpMonitor: string;
  rebalancer: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '36d7378-20260126-141132',
  relayerRC: '36d7378-20260126-141132',
  validator: 'a52b9e6-20260122-173915',
  validatorRC: 'a52b9e6-20260122-173915',
  scraper: '80f3635-20260123-103819',
  // monorepo services
  kathy: '74d999b-20260108-145131',
  checkWarpDeploy: '74d999b-20260108-145131',
  // standalone services
  keyFunder: 'b29a170-20260128-174848',
  warpMonitor: '6b6fd0b-20260123-121413',
  rebalancer: '6b6fd0b-20260123-121418',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '36d7378-20260126-141132',
  relayerRC: '36d7378-20260126-141132',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '80f3635-20260123-103819',
  // monorepo services
  kathy: '74d999b-20260108-145131',
  // standalone services
  keyFunder: 'b29a170-20260128-174848',
};
