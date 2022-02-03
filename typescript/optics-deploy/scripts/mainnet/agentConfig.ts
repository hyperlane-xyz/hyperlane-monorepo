import * as celo from '../../config/mainnets/celo';
import * as ethereum from '../../config/mainnets/ethereum';
import * as polygon from '../../config/mainnets/polygon';
import * as avalanche from '../../config/mainnets/avalanche';
import { AgentChainConfigs, AgentConfig } from '../../src/agents';

const configDirectory = 'mainnet';

export const configs: AgentChainConfigs = {
  celo: celo.chainJson,
  ethereum: ethereum.chainJson,
  polygon: polygon.chainJson,
  avalanche: avalanche.chainJson,
};

export const agentConfig: AgentConfig = {
  environment: 'production',
  namespace: 'optics-production-community',
  runEnv: configDirectory,
  awsRegion: process.env.AWS_REGION!,
  awsKeyId: process.env.AWS_KEY_ID!,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  dockerImageRepo: 'gcr.io/clabs-optics/optics-agent',
  dockerImageTag: '3594c7d715f0ad1def2b36cb0e29649e1f6712e6',
};

export const configPath = `../../rust/config/${configDirectory}`;
export const networks = [celo, polygon, avalanche, ethereum];
