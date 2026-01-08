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
  relayer: '28f67ad-20260103-234517',
  relayerRC: '28f67ad-20260103-234517',
  validator: '28f67ad-20260103-234517',
  validatorRC: '28f67ad-20260103-234517',
  scraper: '28f67ad-20260103-234517',
  keyFunder: 'ff24bc3-20260104-175430',
  kathy: '8da6852-20251215-172511',
  checkWarpDeploy: '8da6852-20251215-172511',
  warpMonitor: 'eda7b03-20251230-135200',
  rebalancer: 'be84fc0-20251229-194426',
};

export const testnetDockerTags: BaseDockerTags = {
  relayer: 'cd94774-20251217-100437',
  relayerRC: 'cd94774-20251217-100437',
  validator: 'cd94774-20251217-100437',
  validatorRC: 'cd94774-20251217-100437',
  scraper: 'f50feaa-20251219-084739',
  keyFunder: '8da6852-20251215-172511',
  kathy: '8da6852-20251215-172511',
};
