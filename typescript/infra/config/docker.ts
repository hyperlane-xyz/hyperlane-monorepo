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
  relayer: '70586aa-20260710-150231',
  relayerRC: '70586aa-20260710-150231',
  relayerFastPath: '70586aa-20260710-150231',
  validator: '557df49-20260615-165434',
  validatorRC: '557df49-20260615-165434',
  validatorFastPath: '557df49-20260615-165434',
  scraper: '557df49-20260615-165434',
  // monorepo services
  checkWarpDeploy: 'main',
  // standalone services
  keyFunder: '3b17358-20260315-183126',
  warpMonitor: '744b3bb-20260521-215958',
  rebalancer: 'da26d9a-20260703-122943',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '70586aa-20260710-150231',
  relayerRC: '70586aa-20260710-150231',
  relayerFastPath: '70586aa-20260710-150231',
  validator: '8b6fdf8-20260605-090142',
  validatorRC: '8b6fdf8-20260605-090142',
  validatorFastPath: '8b6fdf8-20260605-090142',
  scraper: '8b6fdf8-20260605-090142',
  // standalone services
  keyFunder: '87f0933-20260605-085727',
};
