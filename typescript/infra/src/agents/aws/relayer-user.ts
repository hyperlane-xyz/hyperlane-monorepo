import { ChainName } from '@abacus-network/sdk';
import { KEY_ROLE_ENUM } from '..';
import { AgentConfig } from '../../config';
import { AgentAwsKey } from './key';
import { AgentAwsUser } from './user';

export class RelayerAgentAwsUser<
  Networks extends ChainName,
> extends AgentAwsUser<Networks> {
  constructor(environment: string, chainName: Networks, region: string) {
    super(environment, chainName, KEY_ROLE_ENUM.Relayer, region);
  }

  keys(agentConfig: AgentConfig<Networks>): Array<AgentAwsKey<Networks>> {
    const remotes = agentConfig.domainNames.filter((d) => d !== this.chainName);
    return remotes.map(
      (r) =>
        new AgentAwsKey<Networks>(agentConfig, this.chainName, this.role, r),
    );
  }
}
