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
  relayer: 'e22be4b-20260715-194756',
  relayerRC: 'e22be4b-20260715-194756',
  relayerFastPath: 'e22be4b-20260715-194756',
  validator: 'e22be4b-20260715-194756',
  validatorRC: 'e22be4b-20260715-194756',
  validatorFastPath: 'e22be4b-20260715-194756',
  scraper: 'e22be4b-20260715-194756',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '2c47a33-20260724-134609',
  // standalone services
  keyFunder: '5dc6aa4-20260714-184449',
  warpMonitor: '744b3bb-20260521-215958',
  rebalancer: 'da26d9a-20260703-122943',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '4ef51c4-20260717-113727',
  relayerRC: '8b6fdf8-20260605-090142',
  relayerFastPath: '8b6fdf8-20260605-090142',
  validator: '4ef51c4-20260717-113727',
  validatorRC: '8b6fdf8-20260605-090142',
  validatorFastPath: '8b6fdf8-20260605-090142',
  scraper: '4ef51c4-20260717-113727',
  // standalone services
  keyFunder: '5dc6aa4-20260714-184449',
};
