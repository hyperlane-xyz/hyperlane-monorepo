import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as mumbai from '../../config/testnets/mumbai';
import * as fuji from '../../config/testnets/fuji';
import { AgentChainConfigs, AgentConfig } from '../../src/agents';

const configDirectory = 'dev';
export const configPath = `../../rust/config/${configDirectory}`;

export const configs: AgentChainConfigs = {
  alfajores: alfajores.chainJson,
  gorli: gorli.chainJson,
  kovan: kovan.chainJson,
  mumbai: mumbai.chainJson,
  fuji: fuji.chainJson,
};

export const networks = [alfajores, kovan, gorli, fuji, mumbai];

// Environment specific config
export const agentConfig: AgentConfig = {
  environment: 'dev',
  namespace: 'optics-dev',
  runEnv: configDirectory,
  dockerImageRepo: 'gcr.io/clabs-optics/optics-agent',
  dockerImageTag: 'dev-2021-12-20',
};
