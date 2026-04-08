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
  relayer: '7eb690c-20260406-142107',
  relayerRC: '7eb690c-20260406-142107',
  relayerFastPath: '7eb690c-20260406-142107',
  validator: '7eb690c-20260406-142107',
  validatorRC: '7eb690c-20260406-142107',
  scraper: '7eb690c-20260406-142107',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
  warpMonitor: '3b17358-20260315-183126',
  rebalancer: '3b17358-20260315-183126',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '7eb690c-20260406-142107',
  relayerRC: '7eb690c-20260406-142107',
  relayerFastPath: '7eb690c-20260406-142107',
  validator: '7eb690c-20260406-142107',
  validatorRC: '7eb690c-20260406-142107',
  scraper: '7eb690c-20260406-142107',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
};
