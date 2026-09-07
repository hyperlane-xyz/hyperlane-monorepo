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
  scraperProxy: string;
  feeQuoting: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: 'fe8dde9-20260906-215204',
  relayerRC: '9008ed6-20260903-002629',
  relayerFastPath: '9008ed6-20260903-002629',
  validator: '9008ed6-20260903-002629',
  validatorRC: '9008ed6-20260903-002629',
  validatorFastPath: '9008ed6-20260903-002629',
  scraper: 'fe8dde9-20260906-215204',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: 'b0c3c5d-20260804-175736',
  warpMonitor: '744b3bb-20260521-215958',
  rebalancer: 'da26d9a-20260703-122943',
  scraperProxy: '6176102-20260907-011707',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '9008ed6-20260903-002629',
  relayerRC: '9008ed6-20260903-002629',
  relayerFastPath: '9008ed6-20260903-002629',
  validator: '9008ed6-20260903-002629',
  validatorRC: '9008ed6-20260903-002629',
  validatorFastPath: '9008ed6-20260903-002629',
  scraper: '9008ed6-20260903-002629',
  // standalone services
  keyFunder: '5dc6aa4-20260714-184449',
};
