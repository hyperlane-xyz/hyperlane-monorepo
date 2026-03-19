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
  relayer: '67060da-20260318-191438',
  relayerRC: '67060da-20260318-191438',
  validator: '67060da-20260318-191438',
  validatorRC: '67060da-20260318-191438',
  scraper: '67060da-20260318-191438',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
  warpMonitor: '3b17358-20260315-183126',
  rebalancer: '3b17358-20260315-183126',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '67060da-20260318-191438',
  relayerRC: '67060da-20260318-191438',
  validator: '67060da-20260318-191438',
  validatorRC: '67060da-20260318-191438',
  scraper: '67060da-20260318-191438',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
};
