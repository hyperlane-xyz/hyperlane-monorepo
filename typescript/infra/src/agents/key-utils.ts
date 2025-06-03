import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import { join } from 'path';
import { Pair } from 'yaml';

import { ChainMap, ChainName } from '@hyperlane-xyz/sdk';
import {
  Address,
  ProtocolType,
  deepEquals,
  objMap,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts.js';
import { helloworld } from '../../config/environments/helloworld.js';
import localKathyAddresses from '../../config/kathy.json';
import { getChain } from '../../config/registry.js';
import localRelayerAddresses from '../../config/relayer.json';
import { getAWValidatorsPath } from '../../scripts/agent-utils.js';
import { getJustHelloWorldConfig } from '../../scripts/helloworld/utils.js';
import { AgentContextConfig, RootAgentConfig } from '../config/agent/agent.js';
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';
import { fetchGCPSecret, setGCPSecretUsingClient } from '../utils/gcloud.js';
import {
  execCmd,
  getInfraPath,
  isEthereumProtocolChain,
  readJSON,
  writeJsonAtPath,
} from '../utils/utils.js';

import { AgentAwsKey } from './aws/key.js';
import { AgentGCPKey } from './gcp.js';
import { CloudAgentKey } from './keys.js';

export type LocalRoleAddresses = Record<
  DeployEnvironment,
  Record<Contexts, Address>
>;
export const relayerAddresses: LocalRoleAddresses =
  localRelayerAddresses as LocalRoleAddresses;
export const kathyAddresses: LocalRoleAddresses =
  localKathyAddresses as LocalRoleAddresses;

const debugLog = rootLogger.child({ module: 'infra:agents:key:utils' }).debug;

export interface KeyAsAddress {
  identifier: string;
  address: string;
}

const CONFIG_DIRECTORY_PATH = join(getInfraPath(), 'config');

// ==================
// Functions for getting keys
// ==================

// Returns a nested object of the shape:
// {
//   [chain]: {
//     [role]: keys[],
//   }
// }
//
// Note that some types of keys are used on multiple different chains
// and may be duplicated in the returned object. E.g. the deployer key
// or the relayer key, etc
export function getRoleKeysPerChain(
  agentConfig: RootAgentConfig,
): ChainMap<Record<Role, CloudAgentKey[]>> {
  return objMap(getRoleKeyMapPerChain(agentConfig), (_chain, roleKeys) => {
    return objMap(roleKeys, (_role, keys) => {
      return Object.values(keys);
    });
  });
}

// Returns a nested object of the shape:
// {
//   [chain]: {
//     [role]: {
//       // To guarantee no key duplicates, the key identifier is used as the key
//       [key identifier]: key
//     }
//   }
// }
function getRoleKeyMapPerChain(
  agentConfig: RootAgentConfig,
): ChainMap<Record<Role, Record<string, CloudAgentKey>>> {
  const keysPerChain: ChainMap<Record<Role, Record<string, CloudAgentKey>>> =
    {};

  const setValidatorKeys = () => {
    const validators = agentConfig.validators;
    for (const chainName of agentConfig.contextChainNames.validator) {
      let chainValidatorKeys = {};
      const validatorCount =
        validators?.chains[chainName]?.validators.length ?? 1;
      for (let index = 0; index < validatorCount; index++) {
        const { validator, chainSigner } = getValidatorKeysForChain(
          agentConfig,
          chainName,
          index,
        );
        chainValidatorKeys = {
          ...chainValidatorKeys,
          [validator.identifier]: validator,
          [chainSigner.identifier]: chainSigner,
        };
      }
      keysPerChain[chainName] = {
        ...keysPerChain[chainName],
        [Role.Validator]: chainValidatorKeys,
      };
    }
  };

  const setRelayerKeys = () => {
    for (const chainName of agentConfig.contextChainNames.relayer) {
      const relayerKey = getRelayerKeyForChain(agentConfig, chainName);
      keysPerChain[chainName] = {
        ...keysPerChain[chainName],
        [Role.Relayer]: {
          [relayerKey.identifier]: relayerKey,
        },
      };
    }
  };

  const setKathyKeys = () => {
    const helloWorldConfig = getJustHelloWorldConfig(
      helloworld[agentConfig.runEnv as 'mainnet3' | 'testnet4'], // test doesn't have hello world configs
      agentConfig.context,
    );
    // Kathy is only needed on chains where the hello world contracts are deployed.
    for (const chainName of Object.keys(helloWorldConfig.addresses)) {
      const kathyKey = getKathyKeyForChain(agentConfig, chainName);
      keysPerChain[chainName] = {
        ...keysPerChain[chainName],
        [Role.Kathy]: {
          [kathyKey.identifier]: kathyKey,
        },
      };
    }
  };

  const setDeployerKeys = () => {
    const deployerKey = getDeployerKey(agentConfig);
    // Default to using the relayer keys for the deployer keys
    for (const chainName of agentConfig.contextChainNames.relayer) {
      keysPerChain[chainName] = {
        ...keysPerChain[chainName],
        [Role.Deployer]: {
          [deployerKey.identifier]: deployerKey,
        },
      };
    }
  };

  for (const role of agentConfig.rolesWithKeys) {
    switch (role) {
      case Role.Validator:
        setValidatorKeys();
        break;
      case Role.Relayer:
        setRelayerKeys();
        break;
      case Role.Kathy:
        setKathyKeys();
        break;
      case Role.Deployer:
        setDeployerKeys();
        break;
      default:
        throw Error(`Unsupported role with keys ${role}`);
    }
  }

  return keysPerChain;
}

// Gets a big array of all keys.
export function getAllCloudAgentKeys(
  agentConfig: RootAgentConfig,
): Array<CloudAgentKey> {
  debugLog('Retrieving all cloud agent keys');
  const keysPerChain = getRoleKeyMapPerChain(agentConfig);

  const keysByIdentifier = Object.keys(keysPerChain).reduce(
    (acc, chainName) => {
      const chainKeyRoles = keysPerChain[chainName];
      // All keys regardless of role
      const chainKeys = Object.keys(chainKeyRoles).reduce((acc, role) => {
        const roleKeys = chainKeyRoles[role as Role];
        return {
          ...acc,
          ...roleKeys,
        };
      }, {});

      return {
        ...acc,
        ...chainKeys,
      };
    },
    {},
  );

  return Object.values(keysByIdentifier);
}

// Gets a specific key. The chain name or index is required depending on the role.
// For this reason, using this function is only encouraged if the caller
// knows they want a specific key relating to a specific role.
export function getCloudAgentKey(
  agentConfig: AgentContextConfig,
  role: Role,
  chainName?: ChainName,
  index?: number,
): CloudAgentKey {
  debugLog(`Retrieving cloud agent key for ${role} on ${chainName}`);
  switch (role) {
    case Role.Validator:
      if (chainName === undefined || index === undefined) {
        throw Error('Must provide chainName and index for validator key');
      }
      // For now just get the validator key, and not the chain signer.
      return getValidatorKeysForChain(agentConfig, chainName, index).validator;
    case Role.Relayer:
      if (chainName === undefined) {
        throw Error('Must provide chainName for relayer key');
      }
      return getRelayerKeyForChain(agentConfig, chainName);
    case Role.Kathy:
      if (chainName === undefined) {
        throw Error('Must provide chainName for kathy key');
      }
      return getKathyKeyForChain(agentConfig, chainName);
    case Role.Deployer:
      return getDeployerKey(agentConfig);
    default:
      throw Error(`Unsupported role ${role}`);
  }
}

// ==================
// Keys for specific roles
// ==================

// Gets the relayer key used for signing txs to the provided chain.
export function getRelayerKeyForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
): CloudAgentKey {
  debugLog(`Retrieving relayer key for ${chainName}`);
  // If AWS is enabled and the chain is an Ethereum-based chain, we want to use
  // an AWS key.
  if (agentConfig.aws && isEthereumProtocolChain(chainName)) {
    return new AgentAwsKey(agentConfig, Role.Relayer, chainName);
  }

  return new AgentGCPKey(
    agentConfig.runEnv,
    agentConfig.context,
    Role.Relayer,
    chainName,
  );
}

// Gets the kathy key used for signing txs to the provided chain.
// Note this is basically a dupe of getRelayerKeyForChain, but to encourage
// consumers to be aware of what role they're using, and to keep the door open
// for future per-role deviations, we have separate functions.
export function getKathyKeyForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
): CloudAgentKey {
  debugLog(`Retrieving kathy key for ${chainName}`);
  // If AWS is enabled and the chain is an Ethereum-based chain, we want to use
  // an AWS key.
  if (agentConfig.aws && isEthereumProtocolChain(chainName)) {
    return new AgentAwsKey(agentConfig, Role.Kathy);
  }

  return new AgentGCPKey(agentConfig.runEnv, agentConfig.context, Role.Kathy);
}

// Returns the deployer key. This is always a GCP key, not chain specific,
// and in the Hyperlane context.
export function getDeployerKey(agentConfig: AgentContextConfig): CloudAgentKey {
  debugLog('Retrieving deployer key');
  return new AgentGCPKey(agentConfig.runEnv, Contexts.Hyperlane, Role.Deployer);
}

// Helper function to determine if a chain is Starknet
function isStarknetChain(chainName: ChainName): boolean {
  const metadata = getChain(chainName);
  return metadata?.protocol === ProtocolType.Starknet;
}

// Returns the validator signer key and the chain signer key for the given validator for
// the given chain and index.
// The validator signer key is used to sign checkpoints and can be AWS regardless of the
// chain protocol type. The chain signer is dependent on the chain protocol type.
export function getValidatorKeysForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
  index: number,
): {
  validator: CloudAgentKey;
  chainSigner: CloudAgentKey;
} {
  debugLog(`Retrieving validator keys for ${chainName}`);
  const validator = agentConfig.aws
    ? new AgentAwsKey(agentConfig, Role.Validator, chainName, index)
    : new AgentGCPKey(
        agentConfig.runEnv,
        agentConfig.context,
        Role.Validator,
        chainName,
        index,
      );

  // If the chain is Ethereum-based, we can just use the validator key (even if it's AWS-based)
  // as the chain signer. Otherwise, we need to use a GCP key.
  let chainSigner;
  if (isEthereumProtocolChain(chainName)) {
    chainSigner = validator;
  } else {
    debugLog(`Retrieving GCP key for ${chainName}, as it is not EVM`);
    chainSigner = new AgentGCPKey(
      agentConfig.runEnv,
      agentConfig.context,
      Role.Validator,
      chainName,
      index,
    );
  }

  return {
    validator,
    chainSigner,
  };
}

// ==================
// Functions for managing keys
// ==================

export async function createAgentKeysIfNotExistsWithPrompt(
  agentConfig: AgentContextConfig,
) {
  const agentKeysToCreate = await agentKeysToBeCreated(agentConfig);

  if (agentKeysToCreate.length > 0) {
    const shouldContinue = await confirm({
      message: chalk.yellow.bold(
        `Warning: New agent keys will be created: ${agentKeysToCreate.join(', ')}. Are you sure you want to continue?`,
      ),
      default: false,
    });
    if (!shouldContinue) {
      console.log(chalk.red.bold('Exiting...'));
      process.exit(1);
    }

    console.log(chalk.blue.bold('Creating new agent keys if needed.'));
    await createAgentKeys(agentConfig, agentKeysToCreate);
    return true;
  } else {
    console.log(chalk.gray.bold('No new agent keys will be created.'));
    return false;
  }
}

// We can create or delete keys if they are not Starknet keys.
function getModifiableKeys(agentConfig: AgentContextConfig): CloudAgentKey[] {
  const keys = getAllCloudAgentKeys(agentConfig);
  // if the key has a chainName and it is a Starknet chain, filter it out
  return keys.filter(
    (key) => !(key.chainName && isStarknetChain(key.chainName)),
  );
}

async function createAgentKeys(
  agentConfig: AgentContextConfig,
  agentKeysToCreate: string[],
) {
  debugLog('Creating agent keys if none exist');

  const keys = getAllCloudAgentKeys(agentConfig);

  const keysToCreate = keys.filter((key) =>
    agentKeysToCreate.includes(key.identifier),
  );

  // Process only non-Starknet keys for creation
  await Promise.all(
    keysToCreate.map(async (key) => {
      debugLog(`Creating key if not exists: ${key.identifier}`);
      return key.createIfNotExists();
    }),
  );

  // We still need to persist addresses, but this handles both Starknet and non-Starknet keys
  await persistAddressesLocally(agentConfig, keysToCreate);
  // Key funder expects the serialized addresses in GCP
  await persistAddressesInGcp(
    agentConfig.runEnv,
    agentConfig.context,
    keysToCreate.map((key) => key.serializeAsAddress()),
  );
  return;
}

async function agentKeysToBeCreated(
  agentConfig: AgentContextConfig,
): Promise<string[]> {
  const keysToCreateIfNotExist = getModifiableKeys(agentConfig);

  return (
    await Promise.all(
      keysToCreateIfNotExist.map(async (key) =>
        (await key.exists()) ? null : key.identifier,
      ),
    )
  ).filter((id): id is string => !!id);
}

export async function deleteAgentKeys(agentConfig: AgentContextConfig) {
  debugLog('Deleting agent keys');

  // Filter out Starknet keys - we don't want to delete them
  const keysToDelete = getModifiableKeys(agentConfig);

  await Promise.all(keysToDelete.map((key) => key.delete()));
  await execCmd(
    `gcloud secrets delete ${addressesIdentifier(
      agentConfig.runEnv,
      agentConfig.context,
    )} --quiet`,
  );
}

export async function rotateKey(
  agentConfig: AgentContextConfig,
  role: Role,
  chainName: ChainName,
) {
  debugLog(`Rotating key for ${role} on ${chainName}`);
  const key = getCloudAgentKey(agentConfig, role, chainName);
  await key.update();
  await persistAddressesLocally(agentConfig, [key]);
}

async function persistAddressesInGcp(
  environment: DeployEnvironment,
  context: Contexts,
  keys: KeyAsAddress[],
) {
  try {
    const existingSecret = (await fetchGCPSecret(
      addressesIdentifier(environment, context),
      true,
    )) as KeyAsAddress[];
    if (deepEquals(keys, existingSecret)) {
      debugLog(
        `Addresses already persisted to GCP for ${context} context in ${environment} environment`,
      );
      return;
    }
  } catch (e) {
    // If the secret doesn't exist, we'll create it below.
    debugLog(
      `No existing secret found for ${context} context in ${environment} environment`,
    );
  }

  debugLog(
    `Persisting addresses to GCP for ${context} context in ${environment} environment`,
  );
  await setGCPSecretUsingClient(
    addressesIdentifier(environment, context),
    JSON.stringify(keys),
    {
      environment,
      context,
    },
  );
}

async function persistAddressesLocally(
  agentConfig: AgentContextConfig,
  keys: CloudAgentKey[],
) {
  debugLog(
    `Persisting addresses to GCP for ${agentConfig.context} context in ${agentConfig.runEnv} environment`,
  );
  // recent keys fetched from aws saved to local artifacts
  const multisigValidatorKeys: ChainMap<{ validators: Address[] }> = {};
  let relayer, kathy;
  for (const key of keys) {
    // Some types of keys come in an AWS and a GCP variant. We prefer
    // to persist the AWS version of the key if AWS is enabled.
    // Note this means we prefer EVM addresses here, as even if AWS
    // is enabled, we use the GCP address for non-EVM chains because
    // only the EVM has the tooling & cryptographic compatibility with
    // our AWS KMS keys.
    if (agentConfig.aws && !(key instanceof AgentAwsKey)) {
      continue;
    }

    if (key.role === Role.Relayer) {
      if (relayer)
        throw new Error('More than one Relayer found in gcpCloudAgentKeys');
      relayer = key.address;
    }
    if (key.role === Role.Kathy) {
      if (kathy)
        throw new Error('More than one Kathy found in gcpCloudAgentKeys');
      kathy = key.address;
    }

    if (key.chainName) {
      multisigValidatorKeys[key.chainName] ||= {
        validators: [],
      };

      // The validator role always has a chainName.
      if (key.role === Role.Validator) {
        multisigValidatorKeys[key.chainName].validators.push(key.address);
      }
    }
  }
  if (!relayer) throw new Error('No Relayer found in awsCloudAgentKeys');
  if (agentConfig.context === Contexts.Hyperlane) {
    if (!kathy) throw new Error('No Kathy found in awsCloudAgentKeys');
    await persistRoleAddressesToLocalArtifacts(
      Role.Kathy,
      agentConfig.runEnv,
      agentConfig.context,
      kathy,
      kathyAddresses,
    );
  }
  await persistRoleAddressesToLocalArtifacts(
    Role.Relayer,
    agentConfig.runEnv,
    agentConfig.context,
    relayer,
    relayerAddresses,
  );

  if (Object.keys(multisigValidatorKeys).length > 0) {
    await persistValidatorAddressesToLocalArtifacts(
      agentConfig.runEnv,
      agentConfig.context,
      multisigValidatorKeys,
    );
  }
}

// non-validator roles
export async function persistRoleAddressesToLocalArtifacts(
  role: Role,
  environment: DeployEnvironment,
  context: Contexts,
  updated: Address,
  addresses: Record<DeployEnvironment, Record<Contexts, Address>>,
) {
  addresses[environment][context] = updated;

  // Resolve the relative path
  const filePath = join(getInfraPath(), `config/${role}.json`);

  writeJsonAtPath(filePath, addresses);
}

// maintaining the multisigIsm schema sans threshold
export async function persistValidatorAddressesToLocalArtifacts(
  environment: DeployEnvironment,
  context: Contexts,
  fetchedValidatorAddresses: ChainMap<{ validators: Address[] }>,
) {
  // Write the updated object back to the file
  writeJsonAtPath(
    getAWValidatorsPath(environment, context),
    fetchedValidatorAddresses,
  );
}

export function fetchLocalKeyAddresses(role: Role): LocalRoleAddresses {
  try {
    const addresses: LocalRoleAddresses = readJSON(
      CONFIG_DIRECTORY_PATH,
      `${role}.json`,
    );

    debugLog(`Fetching addresses from GCP for ${role} role ...`);
    return addresses;
  } catch (e) {
    throw new Error(`Error fetching addresses locally for ${role} role: ${e}`);
  }
}

function addressesIdentifier(
  environment: DeployEnvironment,
  context: Contexts,
) {
  return `${context}-${environment}-key-addresses`;
}
