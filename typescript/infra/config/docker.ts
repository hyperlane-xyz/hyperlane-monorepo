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
  relayer: 'b83bac5-20260909-225045',
  relayerRC: '736ace8-20260909-012244',
  relayerFastPath: '736ace8-20260909-012244',
  validator: '78dcf59-20260923-052203',
  validatorRC: '78dcf59-20260923-052203',
  validatorFastPath: '78dcf59-20260923-052203',
  scraper: '7d4fc63-20260924-120439',
  // monorepo services
  checkWarpDeploy: 'main',
  validatorMonitor: 'cfd4cae-20260911-102750',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  warpMonitor: 'fc544bf-20260908-174702',
  rebalancer: 'fc544bf-20260908-174702',
  scraperProxy: 'f05bb6d-20260923-151825',
  feeQuoting: '12d899d-20260325-184337',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: 'b83bac5-20260909-225045',
  relayerRC: '736ace8-20260909-012244',
  relayerFastPath: '736ace8-20260909-012244',
  validator: '78dcf59-20260923-052203',
  validatorRC: '78dcf59-20260923-052203',
  validatorFastPath: '78dcf59-20260923-052203',
  scraper: '7d4fc63-20260924-120439',
  // standalone services
  keyFunder: 'fc544bf-20260908-174702',
  scraperProxy: 'f05bb6d-20260923-151825',
};
