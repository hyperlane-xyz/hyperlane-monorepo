import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../../config';
import { KEY_ROLE_ENUM } from '../roles';

import { AgentAwsKey } from './key';
import { AgentAwsUser } from './user';

export class RelayerAgentAwsUser<
  Networks extends ChainName,
> extends AgentAwsUser<Networks> {
  constructor(environment: string, chainName: Networks, region: string) {
    super(environment, chainName, KEY_ROLE_ENUM.Relayer, region);
  }

  key(agentConfig: AgentConfig<Networks>): AgentAwsKey<Networks> {
    return new AgentAwsKey<Networks>(agentConfig, this.role, this.chainName);
  }
}
