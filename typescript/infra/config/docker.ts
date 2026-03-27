const GHCR_REGISTRY = 'ghcr.io/hyperlane-xyz';

export const DockerImageNames = {
  AGENT: 'hyperlane-agent',
  MONOREPO: 'hyperlane-monorepo',
  NODE_SERVICES: 'hyperlane-node-services',
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
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '6bbc7b5-20260326-002348',
  relayerRC: '1663fd7-20260327-165421',
  relayerFastPath: '1663fd7-20260327-165421',
  validator: '910e8e8-20260318-204227',
  validatorRC: '910e8e8-20260318-204227',
  scraper: '910e8e8-20260318-204227',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
  warpMonitor: '3b17358-20260315-183126',
  rebalancer: '3b17358-20260315-183126',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '1663fd7-20260327-165421',
  relayerRC: '1663fd7-20260327-165421',
  relayerFastPath: '1663fd7-20260327-165421',
  validator: '910e8e8-20260318-204227',
  validatorRC: '910e8e8-20260318-204227',
  scraper: '910e8e8-20260318-204227',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
};
