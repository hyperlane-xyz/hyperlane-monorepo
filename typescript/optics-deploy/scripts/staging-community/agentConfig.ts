import * as alfajores from '../../config/testnets/alfajores';
import * as gorli from '../../config/testnets/gorli';
import * as kovan from '../../config/testnets/kovan';
import * as ropsten from '../../config/testnets/ropsten';
import { AgentChainsConfig, AgentConfig } from '../../src/agents';

// Assumes kubectl is pointed at the right cluster

export const configs: AgentChainsConfig = {
  alfajores: alfajores.chainJson,
  gorli: gorli.chainJson,
  kovan: kovan.chainJson,
  ropsten: ropsten.chainJson
}

// Environment specific config
export const agentConfig: AgentConfig = {
  namespace: 'optics-staging-community',
  runEnv: 'staging-community',
  awsRegion: process.env.AWS_REGION!,
  awsKeyId: process.env.AWS_KEY_ID!,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  dockerImageRepo: "gcr.io/clabs-optics/optics-agent",
  dockerImageTag: "staging-community"
}
