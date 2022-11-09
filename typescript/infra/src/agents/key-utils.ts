import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../config/contexts';
import { AgentConfig } from '../config';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import { execCmd } from '../utils/utils';

import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { CloudAgentKey } from './keys';
import { KEY_ROLE_ENUM } from './roles';

interface KeyAsAddress {
  identifier: string;
  address: string;
}

export function getCloudAgentKey<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  role: KEY_ROLE_ENUM,
  chainName?: Chain,
  index?: number,
): CloudAgentKey {
  if (
    agentConfig.aws &&
    role !== KEY_ROLE_ENUM.Deployer &&
    role !== KEY_ROLE_ENUM.Create2Deployer
  ) {
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

export function getValidatorCloudAgentKeys(
  agentConfig: AgentConfig<any>,
): Array<CloudAgentKey> {
  // For each chainName, create validatorCount keys
  return agentConfig.contextChainNames.flatMap((chainName) =>
    agentConfig.validatorSets[chainName].validators
      .filter((validator) => !validator.readonly)
      .map((validator, index) =>
        getCloudAgentKey(
          agentConfig,
          KEY_ROLE_ENUM.Validator,
          chainName,
          index,
        ),
      ),
  );
}

export function getRelayerCloudAgentKeys(
  agentConfig: AgentConfig<any>,
): Array<CloudAgentKey> {
  return agentConfig.contextChainNames.map((chainName) =>
    getCloudAgentKey(agentConfig, KEY_ROLE_ENUM.Relayer, chainName),
  );
}

export function getAllCloudAgentKeys(
  agentConfig: AgentConfig<any>,
): Array<CloudAgentKey> {
  return agentConfig.rolesWithKeys.flatMap((role) => {
    if (role === KEY_ROLE_ENUM.Validator) {
      return getValidatorCloudAgentKeys(agentConfig);
    } else if (role === KEY_ROLE_ENUM.Relayer) {
      return getRelayerCloudAgentKeys(agentConfig);
    } else {
      return [getCloudAgentKey(agentConfig, role)];
    }
  });
}

export async function deleteAgentKeys(agentConfig: AgentConfig<any>) {
  const keys = getAllCloudAgentKeys(agentConfig);
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
  const keys = getAllCloudAgentKeys(agentConfig);

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
  const key = getCloudAgentKey(agentConfig, role, chainName);
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

// This function returns all keys for a given chain in a dictionary where the key is the identifier
export async function fetchKeysForChain<Chain extends ChainName>(
  agentConfig: AgentConfig<Chain>,
  chainName: Chain,
): Promise<Record<string, CloudAgentKey>> {
  // Get all keys for the chainName. Include keys where chainName is undefined,
  // which are keys that are not chain-specific but should still be included
  const keys = await Promise.all(
    getAllCloudAgentKeys(agentConfig)
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
