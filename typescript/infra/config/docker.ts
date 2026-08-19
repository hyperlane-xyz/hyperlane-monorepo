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
  validatorMonitor: string;
  warpMonitor: string;
  rebalancer: string;
  feeQuoting: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '14646bd-20260805-072134',
  relayerRC: '14646bd-20260805-072134',
  relayerFastPath: '14646bd-20260805-072134',
  validator: '14646bd-20260805-072134',
  validatorRC: '14646bd-20260805-072134',
  validatorFastPath: '14646bd-20260805-072134',
  scraper: '3fa7390-20260819-114148',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: 'b0c3c5d-20260804-175736',
  warpMonitor: 'd7437fd-20260819-164139',
  rebalancer: 'da26d9a-20260703-122943',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '14646bd-20260805-072134',
  relayerRC: '14646bd-20260805-072134',
  relayerFastPath: '14646bd-20260805-072134',
  validator: '14646bd-20260805-072134',
  validatorRC: '14646bd-20260805-072134',
  validatorFastPath: '14646bd-20260805-072134',
  scraper: '3fa7390-20260819-114148',
  // standalone services
  keyFunder: '5dc6aa4-20260714-184449',
};
