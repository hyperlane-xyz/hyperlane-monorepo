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
  relayer: '5302a89-20260215-172420',
  relayerRC: '5302a89-20260215-172420',
  validator: 'a52b9e6-20260122-173915',
  validatorRC: 'a52b9e6-20260122-173915',
  scraper: 'bb96c74-20260129-145233',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '859a5cc-20260215-033315',
  warpMonitor: '6b6fd0b-20260123-121413',
  rebalancer: '6b6fd0b-20260123-121418',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'cc5e978-20260217-190624',
  relayerRC: 'cc5e978-20260217-190624',
  validator: 'cc5e978-20260217-190624',
  validatorRC: 'cc5e978-20260217-190624',
  scraper: 'cc5e978-20260217-190624',
  // standalone services
  keyFunder: '859a5cc-20260215-033315',
};
