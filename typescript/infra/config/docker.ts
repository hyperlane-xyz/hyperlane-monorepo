export const DockerImageRepos = {
  AGENT: 'gcr.io/abacus-labs-dev/hyperlane-agent',
  MONOREPO: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
  WARP_MONITOR: 'gcr.io/abacus-labs-dev/hyperlane-warp-monitor',
  REBALANCER: 'gcr.io/abacus-labs-dev/hyperlane-rebalancer',
} as const;

interface AgentDockerTags {
  relayer: string;
  relayerRC: string;
  validator: string;
  validatorRC: string;
  scraper: string;
}

interface BaseDockerTags extends AgentDockerTags {
  keyFunder: string;
  kathy: string;
}

interface MainnetDockerTags extends BaseDockerTags {
  checkWarpDeploy: string;
  warpMonitor: string;
  rebalancer: string;
}

export const mainnetDockerTags: MainnetDockerTags = {
  // rust agents
  relayer: '945239f-20260116-125135',
  relayerRC: '945239f-20260116-125135',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '74d999b-20260108-145124',
  // monorepo services
  keyFunder: '74d999b-20260108-145131',
  kathy: '74d999b-20260108-145131',
  checkWarpDeploy: '74d999b-20260108-145131',
  // standalone services
  warpMonitor: '74d999b-20260108-145128',
  rebalancer: '74d999b-20260108-145129',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '945239f-20260116-125135',
  relayerRC: '945239f-20260116-125135',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '74d999b-20260108-145124',
  // monorepo services
  keyFunder: '74d999b-20260108-145131',
  kathy: '74d999b-20260108-145131',
};
