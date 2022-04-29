import { ChainName } from '@abacus-network/sdk';
import { AgentConfig } from '../config';
import { AgentGCPKey } from './gcp';
import { AgentAwsKey } from './aws/key';
import { AgentKey } from './agent';
import { KEY_ROLES, KEY_ROLE_ENUM } from './roles';

export function getKey<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
  role: KEY_ROLE_ENUM,
  chainName?: Networks,
  suffix?: Networks | number,
): AgentKey<Networks> {
  if (agentConfig.aws) {
    return new AgentAwsKey(agentConfig, role, chainName, suffix);
  } else {
    return new AgentGCPKey(agentConfig, role, chainName, suffix);
  }
}

export function getAllKeys<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
): Array<AgentKey<Networks>> {
  return KEY_ROLES.flatMap((role) => {
    if (role === KEY_ROLE_ENUM.Validator) {
      // For each chainName, create validatorCount keys
      return agentConfig.domainNames.flatMap((chainName) =>
        [
          ...Array(
            agentConfig.validatorSets[chainName].validators.length,
          ).keys(),
        ].map((index) => getKey(agentConfig, role, chainName, index)),
      );
    } else if (role === KEY_ROLE_ENUM.Relayer) {
      return agentConfig.domainNames.map((chainName) =>
        getKey(agentConfig, role, chainName),
      );
    } else {
      return [getKey(agentConfig, role)];
    }
  });
}
