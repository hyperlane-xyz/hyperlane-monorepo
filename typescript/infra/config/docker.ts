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
  relayer: '524aac0-20260925-195006',
  relayerRC: '736ace8-20260909-012244',
  relayerFastPath: '524aac0-20260925-195006',
  validator: '524aac0-20260925-195006',
  validatorRC: '78dcf59-20260923-052203',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: '524aac0-20260925-195006',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: 'cfd4cae-20260911-102750',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  warpMonitor: 'fc544bf-20260908-174702',
  rebalancer: 'fc544bf-20260908-174702',
  scraperProxy: 'ec4aedc-20260925-093728',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '524aac0-20260925-195006',
  relayerRC: '736ace8-20260909-012244',
  relayerFastPath: '524aac0-20260925-195006',
  validator: '524aac0-20260925-195006',
  validatorRC: '78dcf59-20260923-052203',
  validatorFastPath: '524aac0-20260925-195006',
  scraper: '524aac0-20260925-195006',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  scraperProxy: 'ec4aedc-20260925-093728',
};
