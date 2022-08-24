import { ChainName } from '@abacus-network/sdk';

import { Contexts } from '../../config/contexts';
import { AgentConfig } from '../config';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { execCmd } from '../utils/utils';

import { AgentKey, ReadOnlyAgentKey } from './agent';
import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { KEY_ROLE_ENUM } from './roles';

interface KeyAsAddress {
  identifier: string;
  address: string;
}

export function getReadonlyKey<Chain extends ChainName>(
  identifier: string,
  address: string,
): ReadOnlyAgentKey {
  return ReadOnlyAgentKey.fromSerializedAddress(identifier, address);
}

export function getKey<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  role: KEY_ROLE_ENUM,
  chainName?: Chain,
  index?: number,
): AgentKey {
  if (agentConfig.aws && role !== KEY_ROLE_ENUM.Deployer) {
    // The deployer is always GCP-based
    return new AgentAwsKey(agentConfig, role, chainName, index);
  } else {
    return new AgentGCPKey(
      agentConfig.environment,
      agentConfig.context,
      role,
      chainName,
      index,
    );
  }
}

export function getValidatorKeys(
  agentConfig: AgentConfig<any>,
): Array<AgentKey> {
  // For each chainName, create validatorCount keys
  return agentConfig.contextChainNames.flatMap((chainName) =>
    agentConfig.validatorSets[chainName].validators.map((validator, index) => {
      if (validator.readonly) {
        if (validator.identifier) {
          return getReadonlyKey(validator.identifier, validator.address);
        } else {
          throw new Error('Readonly validator keys must specify an identifier');
        }
      } else {
        return getKey(agentConfig, KEY_ROLE_ENUM.Validator, chainName, index);
      }
    }),
  );
}

export function getRelayerKeys(agentConfig: AgentConfig<any>): Array<AgentKey> {
  return agentConfig.contextChainNames.map((chainName) =>
    getKey(agentConfig, KEY_ROLE_ENUM.Relayer, chainName),
  );
}

export function getAllKeys(agentConfig: AgentConfig<any>): Array<AgentKey> {
  return agentConfig.rolesWithKeys.flatMap((role) => {
    if (role === KEY_ROLE_ENUM.Validator) {
      return getValidatorKeys(agentConfig);
    } else if (role === KEY_ROLE_ENUM.Relayer) {
      return getRelayerKeys(agentConfig);
    } else {
      return [getKey(agentConfig, role)];
    }
  });
}

export async function deleteAgentKeys(agentConfig: AgentConfig<any>) {
  const keys = getAllKeys(agentConfig);
  await Promise.all(keys.map((key) => key.delete()));
  await execCmd(
    `gcloud secrets delete ${addressesIdentifier(
      agentConfig.environment,
      agentConfig.context,
    )} --quiet`,
  );
}

export async function createAgentKeysIfNotExists(
  agentConfig: AgentConfig<any>,
) {
  const keys = getAllKeys(agentConfig);

  await Promise.all(
    keys.map(async (key) => {
      return key.createIfNotExists();
    }),
  );

  await persistAddresses(
    agentConfig.environment,
    agentConfig.context,
    keys.map((key) => key.serializeAsAddress()),
  );
}

export async function rotateKey<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  role: KEY_ROLE_ENUM,
  chainName: Chain,
) {
  const key = getKey(agentConfig, role, chainName);
  await key.update();
  const keyIdentifier = key.identifier;
  const addresses = await fetchGCPKeyAddresses(
    agentConfig.environment,
    agentConfig.context,
  );
  const filteredAddresses = addresses.filter((_) => {
    return _.identifier !== keyIdentifier;
  });

  filteredAddresses.push(key.serializeAsAddress());
  await persistAddresses(
    agentConfig.environment,
    agentConfig.context,
    filteredAddresses,
  );
}

async function persistAddresses(
  environment: string,
  context: Contexts,
  keys: KeyAsAddress[],
) {
  await setGCPSecret(
    addressesIdentifier(environment, context),
    JSON.stringify(keys),
    {
      environment,
      context,
    },
  );
}

// This function returns all keys for a given outbox chain in a dictionary where the key is the identifier
export async function fetchKeysForChain<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  chainName: Chain,
): Promise<Record<string, AgentKey>> {
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

async function fetchGCPKeyAddresses(environment: string, context: Contexts) {
  const addresses = await fetchGCPSecret(
    addressesIdentifier(environment, context),
  );
  return addresses as KeyAsAddress[];
}

function addressesIdentifier(environment: string, context: Contexts) {
  return `${context}-${environment}-key-addresses`;
}
