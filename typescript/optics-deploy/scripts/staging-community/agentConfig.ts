import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as ropsten from '../../config/testnets/ropsten';
import { AgentChainConfigs, AgentConfig } from '../../src/agents';

// Assumes kubectl is pointed at the right cluster

export const configs: AgentChainConfigs = {
  alfajores: alfajores.chainJson,
  gorli: gorli.chainJson,
  kovan: kovan.chainJson,
  ropsten: ropsten.chainJson
}

// Environment specific config
export const agentConfig: AgentConfig = {
  environment: 'staging-community',
  namespace: 'optics-staging-community',
  runEnv: 'staging-community',
  awsRegion: process.env.AWS_REGION!,
  awsKeyId: process.env.AWS_KEY_ID!,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  dockerImageRepo: "gcr.io/clabs-optics/optics-agent",
  dockerImageTag: "3594c7d715f0ad1def2b36cb0e29649e1f6712e6"
}
