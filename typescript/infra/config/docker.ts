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
  relayer: '4aabed7-20260226-151632',
  relayerRC: '4aabed7-20260226-151632',
  validator: 'a52b9e6-20260122-173915',
  validatorRC: 'a52b9e6-20260122-173915',
  scraper: 'bb96c74-20260129-145233',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '34d6708-20260223-230356',
  warpMonitor: 'ccd638d-20260217-182840',
  rebalancer: '46cbc4a-20260223-211659',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '4aabed7-20260226-151632',
  relayerRC: '4aabed7-20260226-151632',
  validator: 'cc5e978-20260217-190624',
  validatorRC: 'cc5e978-20260217-190624',
  scraper: 'cc5e978-20260217-190624',
  // standalone services
  keyFunder: '34d6708-20260223-230356',
};
