export const DockerImageRepos = {
  AGENT: 'gcr.io/abacus-labs-dev/hyperlane-agent',
  MONOREPO: 'gcr.io/abacus-labs-dev/hyperlane-monorepo',
  KEYFUNDER: 'gcr.io/abacus-labs-dev/hyperlane-keyfunder',
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
  relayer: 'a52b9e6-20260122-173915',
  relayerRC: 'a52b9e6-20260122-173915',
  validator: 'a52b9e6-20260122-173915',
  validatorRC: 'a52b9e6-20260122-173915',
  scraper: '80f3635-20260123-103819',
  // monorepo services
  keyFunder: 'a52b9e6-20260122-173924',
  kathy: '74d999b-20260108-145131',
  checkWarpDeploy: '74d999b-20260108-145131',
  // standalone services
  warpMonitor: '6b6fd0b-20260123-121413',
  rebalancer: '6b6fd0b-20260123-121418',
};

export const testnetDockerTags: BaseDockerTags = {
  // rust agents
  relayer: '0acaa0e-20260120-155439',
  relayerRC: '0acaa0e-20260120-155439',
  validator: '74d999b-20260108-145124',
  validatorRC: '74d999b-20260108-145124',
  scraper: '80f3635-20260123-103819',
  // monorepo services
  keyFunder: '74d999b-20260108-145131',
  kathy: '74d999b-20260108-145131',
};
