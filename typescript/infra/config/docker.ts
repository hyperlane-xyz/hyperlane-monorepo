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
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  warpMonitor: string;
  rebalancer: string;
  feeQuoting: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: 'ba9a263-20260714-170949',
  relayerRC: 'ba9a263-20260714-170949',
  relayerFastPath: 'ba9a263-20260714-170949',
  validator: '955281d-20260714-112301',
  validatorRC: '955281d-20260714-112301',
  validatorFastPath: '955281d-20260714-112301',
  scraper: '955281d-20260714-112301',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '5dc6aa4-20260714-184449',
  warpMonitor: '744b3bb-20260521-215958',
  rebalancer: 'da26d9a-20260703-122943',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '8b6fdf8-20260605-090142',
  relayerRC: '8b6fdf8-20260605-090142',
  relayerFastPath: '8b6fdf8-20260605-090142',
  validator: '8b6fdf8-20260605-090142',
  validatorRC: '8b6fdf8-20260605-090142',
  validatorFastPath: '8b6fdf8-20260605-090142',
  scraper: '8b6fdf8-20260605-090142',
  // standalone services
  keyFunder: '87f0933-20260605-085727',
};
