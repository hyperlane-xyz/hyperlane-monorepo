import { ChainName } from '@abacus-network/sdk';

import { AgentConfig } from '../config';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { execCmd } from '../utils/utils';

import { AgentKey } from './agent';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { KEY_ROLES, KEY_ROLE_ENUM } from './roles';

interface KeyAsAddress {
  identifier: string;
  address: string;
}

export function getKey<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
  role: KEY_ROLE_ENUM,
  chainName?: Networks,
  index?: number,
): AgentKey<Networks> {
  if (agentConfig.aws) {
    return new AgentAwsKey(agentConfig, role, chainName, index);
  } else {
    return new AgentGCPKey(agentConfig.environment, role, chainName, index);
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

export async function deleteAgentKeys<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
) {
  const keys = getAllKeys(agentConfig);
  await Promise.all(keys.map((key) => key.delete()));
  await execCmd(
    `gcloud secrets delete ${addressesIdentifier(
      agentConfig.environment,
    )} --quiet`,
  );
}

export async function createAgentKeysIfNotExists<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
) {
  const keys = getAllKeys(agentConfig);

  await Promise.all(
    keys.map(async (key) => {
      return key.createIfNotExists();
    }),
  );

  await persistAddresses(
    agentConfig.environment,
    keys.map((key) => key.serializeAsAddress()),
  );
}

export async function rotateKey<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
  role: KEY_ROLE_ENUM,
  chainName: Networks,
) {
  const key = getKey(agentConfig, role, chainName);
  await key.update();
  const keyIdentifier = key.identifier;
  const addresses = await fetchGCPKeyAddresses(agentConfig.environment);
  const filteredAddresses = addresses.filter((_) => {
    return _.identifier !== keyIdentifier;
  });

  filteredAddresses.push(key.serializeAsAddress());
  await persistAddresses(agentConfig.environment, filteredAddresses);
}

async function persistAddresses(environment: string, keys: KeyAsAddress[]) {
  await setGCPSecret(addressesIdentifier(environment), JSON.stringify(keys), {
    environment: environment,
  });
}

// This function returns all keys for a given outbox chain in a dictionary where the key is the identifier
export async function fetchKeysForChain<Networks extends ChainName>(
  agentConfig: AgentConfig<Networks>,
  chainName: Networks,
): Promise<Record<string, AgentKey<Networks>>> {
  // Get all keys for the chainName. Include keys where chainName is undefined,
  // which are keys that are not chain-specific but should still be included
  const keys = await Promise.all(
    getAllKeys(agentConfig)
      .filter(
        (key) => key.chainName === undefined || key.chainName == chainName,
      )
      .map(async (key) => {
        await key.fetch();
        return [key.identifier, key];
      }),
  );

  return Object.fromEntries(keys);
}

async function fetchGCPKeyAddresses(environment: string) {
  const addresses = await fetchGCPSecret(addressesIdentifier(environment));
  return addresses as KeyAsAddress[];
}

function addressesIdentifier(environment: string) {
  return `abacus-${environment}-key-addresses`;
}
