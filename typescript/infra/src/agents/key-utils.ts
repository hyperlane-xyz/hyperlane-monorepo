import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { AgentConfig, BaseAgentConfig, DeployEnvironment } from '../config';
import { Role } from '../roles';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { execCmd } from '../utils/utils';

import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { CloudAgentKey } from './keys';

interface KeyAsAddress {
  identifier: string;
  address: string;
}

export function getCloudAgentKey(
  agentConfig: AgentConfig,
  role: Role,
  chainName?: ChainName,
  index?: number,
): CloudAgentKey {
  if (agentConfig.aws && role !== Role.Deployer) {
    // The deployer is always GCP-based
    return new AgentAwsKey(agentConfig, role, chainName, index);
  } else {
    return new AgentGCPKey(
      agentConfig.runEnv,
      agentConfig.context,
      role,
      chainName,
      index,
    );
  }
}

export function getValidatorCloudAgentKeys(
  agentConfig: AgentConfig,
): Array<CloudAgentKey> {
  // For each chainName, create validatorCount keys
  return agentConfig.contextChainNames.flatMap((chainName) => {
    if (agentConfig.validators) {
      return agentConfig.validators[chainName].validators.map((_, index) =>
        getCloudAgentKey(agentConfig, Role.Validator, chainName, index),
      );
    } else {
      return [];
    }
  });
}

export function getRelayerCloudAgentKeys(
  agentConfig: AgentConfig,
): Array<CloudAgentKey> {
  return agentConfig.contextChainNames.map((chainName) =>
    getCloudAgentKey(agentConfig, Role.Relayer, chainName),
  );
}

export function getAllCloudAgentKeys(
  agentConfig: BaseAgentConfig,
): Array<CloudAgentKey> {
  return agentConfig.rolesWithKeys.flatMap((role) => {
    if (role === Role.Validator) {
      return getValidatorCloudAgentKeys(agentConfig);
    } else if (role === Role.Relayer) {
      return getRelayerCloudAgentKeys(agentConfig);
    } else {
      return [getCloudAgentKey(agentConfig, role)];
    }
  });
}

export async function deleteAgentKeys(agentConfig: AgentConfig) {
  const keys = getAllCloudAgentKeys(agentConfig);
  await Promise.all(keys.map((key) => key.delete()));
  await execCmd(
    `gcloud secrets delete ${addressesIdentifier(
      agentConfig.runEnv,
      agentConfig.context,
    )} --quiet`,
  );
}

export async function createAgentKeysIfNotExists(agentConfig: AgentConfig) {
  const keys = getAllCloudAgentKeys(agentConfig);

  await Promise.all(
    keys.map(async (key) => {
      return key.createIfNotExists();
    }),
  );

  await persistAddresses(
    agentConfig.runEnv,
    agentConfig.context,
    keys.map((key) => key.serializeAsAddress()),
  );
}

export async function rotateKey(
  agentConfig: AgentConfig,
  role: Role,
  chainName: ChainName,
) {
  const key = getCloudAgentKey(agentConfig, role, chainName);
  await key.update();
  const keyIdentifier = key.identifier;
  const addresses = await fetchGCPKeyAddresses(
    agentConfig.runEnv,
    agentConfig.context,
  );
  const filteredAddresses = addresses.filter((_) => {
    return _.identifier !== keyIdentifier;
  });

  filteredAddresses.push(key.serializeAsAddress());
  await persistAddresses(
    agentConfig.runEnv,
    agentConfig.context,
    filteredAddresses,
  );
}

async function persistAddresses(
  environment: DeployEnvironment,
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

// This function returns all keys for a given mailbox chain in a dictionary where the key is the identifier
export async function fetchKeysForChain(
  agentConfig: AgentConfig,
  chainNames: ChainName | ChainName[],
): Promise<Record<string, CloudAgentKey>> {
  if (!Array.isArray(chainNames)) chainNames = [chainNames];

  // Get all keys for the chainNames. Include keys where chainNames is undefined,
  // which are keys that are not chain-specific but should still be included
  const keys = await Promise.all(
    getAllCloudAgentKeys(agentConfig)
      .filter(
        (key) =>
          key.chainName === undefined || chainNames.includes(key.chainName),
      )
      .map(async (key) => {
        await key.fetch();
        return [key.identifier, key];
      }),
  );

  return Object.fromEntries(keys);
}

async function fetchGCPKeyAddresses(
  environment: DeployEnvironment,
  context: Contexts,
) {
  const addresses = await fetchGCPSecret(
    addressesIdentifier(environment, context),
  );
  return addresses as KeyAsAddress[];
}

function addressesIdentifier(
  environment: DeployEnvironment,
  context: Contexts,
) {
  return `${context}-${environment}-key-addresses`;
}
