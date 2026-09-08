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
  relayer: 'be18813-20260908-054007',
  relayerRC: 'be18813-20260908-054007',
  relayerFastPath: 'be18813-20260908-054007',
  validator: 'cb7237c-20260908-141540',
  validatorRC: 'be18813-20260908-054007',
  validatorFastPath: 'cb7237c-20260908-141540',
  scraper: 'be18813-20260908-054007',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: '757150f-20260908-042619',
  warpMonitor: '757150f-20260908-042619',
  rebalancer: '757150f-20260908-042619',
  scraperProxy: '757150f-20260908-042619',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'be18813-20260908-054007',
  relayerRC: 'be18813-20260908-054007',
  relayerFastPath: 'be18813-20260908-054007',
  validator: 'cb7237c-20260908-141540',
  validatorRC: 'be18813-20260908-054007',
  validatorFastPath: 'cb7237c-20260908-141540',
  scraper: 'be18813-20260908-054007',
  // standalone services
  keyFunder: '757150f-20260908-042619',
  scraperProxy: '757150f-20260908-042619',
};
