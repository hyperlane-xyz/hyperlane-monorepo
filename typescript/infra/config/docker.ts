const GHCR_REGISTRY = 'ghcr.io/hyperlane-xyz';
const ABACUS_ARTIFACT_REGISTRY =
  'us-east1-docker.pkg.dev/abacus-labs-dev/hyperlane';
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

export const UniversalRouterEngineDockerImageRepo = `${ABACUS_ARTIFACT_REGISTRY}/hyperlane-universal-router-engine`;

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
  universalRouterEngine: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '1cdbf6d-20261006-164328',
  relayerRC: '35d3002-20261003-140244',
  relayerFastPath: '35d3002-20261003-140244',
  validator: '524aac0-20260925-195006',
  validatorRC: '524aac0-20260925-195006',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: 'c776083-20261009-082029',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: '17dd7ac-20260928-093912',
  // standalone services
  keyFunder: '112541b-20261001-141255',
  warpMonitor: 'fc544bf-20260908-174702',
  rebalancer: 'fc544bf-20260908-174702',
  scraperProxy: '35d3002-20261003-140007',
  feeQuoting: '12d899d-20260325-184337',
  universalRouterEngine: 'main',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'e830d2e-20261005-112108',
  relayerRC: '35d3002-20261003-140244',
  relayerFastPath: '35d3002-20261003-140244',
  validator: '524aac0-20260925-195006',
  validatorRC: '524aac0-20260925-195006',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: 'c776083-20261009-082029',
  // standalone services
  keyFunder: '112541b-20261001-141255',
  scraperProxy: '35d3002-20261003-140007',
};
