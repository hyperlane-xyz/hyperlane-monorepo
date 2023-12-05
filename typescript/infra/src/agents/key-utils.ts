import { ChainMap, ChainName, chainMetadata } from '@hyperlane-xyz/sdk';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { Contexts } from '../../config/contexts';
import { helloWorld } from '../../config/environments/mainnet3/helloworld';
import {
  AgentContextConfig,
  DeployEnvironment,
  RootAgentConfig,
} from '../config';
import { Role } from '../roles';
import { fetchGCPSecret, setGCPSecret } from '../utils/gcloud';
import {
  execCmd,
  isEthereumProtocolChain,
  isNotEthereumProtocolChain,
} from '../utils/utils';

import { AgentAwsKey } from './aws/key';
import { AgentGCPKey } from './gcp';
import { CloudAgentKey } from './keys';

interface KeyAsAddress {
  identifier: string;
  address: string;
}

// Gets the relayer key used for signing txs to the provided chain.
export function getRelayerKeyForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
): CloudAgentKey {
  // If AWS is enabled and the chain is an Ethereum-based chain, we want to use
  // an AWS key.
  if (agentConfig.aws && isEthereumProtocolChain(chainName)) {
    return new AgentAwsKey(agentConfig, Role.Relayer);
  }

  return new AgentGCPKey(agentConfig.runEnv, agentConfig.context, Role.Relayer);
}

// // Returns all keys used by a relayer: an AWS key if AWS is enabled and there
// // are Ethereum-based chains, and a GCP key if there are non-Ethereum-based chains
// // or AWS is not enabled.
// export function getAllRelayerCloudAgentKeys(
//   agentConfig: AgentContextConfig,
// ): Array<CloudAgentKey> {
//   if (!agentConfig.aws) {
//     return [
//       new AgentGCPKey(agentConfig.runEnv, agentConfig.context, Role.Relayer),
//     ];
//   }

//   const keys = [];
//   keys.push(new AgentAwsKey(agentConfig, Role.Relayer));
//   const hasNonEthereumChains = !!agentConfig.contextChainNames[
//     Role.Relayer
//   ].find(isNotEthereumProtocolChain);
//   // If there are any non-ethereum chains, we also want hex keys.
//   if (hasNonEthereumChains) {
//     keys.push(
//       new AgentGCPKey(agentConfig.runEnv, agentConfig.context, Role.Relayer),
//     );
//   }
//   return keys;
// }

// TODO: Note this is basically a dupe of getRelayerKeyForChain!

// Gets the kathy key used for signing txs to the provided chain.
export function getKathyKeyForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
): CloudAgentKey {
  // If AWS is enabled and the chain is an Ethereum-based chain, we want to use
  // an AWS key.
  if (agentConfig.aws && isEthereumProtocolChain(chainName)) {
    return new AgentAwsKey(agentConfig, Role.Kathy);
  }

  return new AgentGCPKey(agentConfig.runEnv, agentConfig.context, Role.Kathy);
}

// // Returns all keys used by Kathy: an AWS key if AWS is enabled and there
// // are Ethereum-based chains, and a GCP key if there are non-Ethereum-based chains
// // or AWS is not enabled.
// export function getAllKathyCloudAgentKeys(
//   agentConfig: AgentContextConfig,
// ): Array<CloudAgentKey> {
//   const gcpKey = new AgentGCPKey(
//     agentConfig.runEnv,
//     agentConfig.context,
//     Role.Kathy,
//   );
//   if (!agentConfig.aws) {
//     return [gcpKey];
//   }

//   // Return both GCP and AWS keys for Kathy even if the agentConfig is configured
//   // to use AWS. Non-Ethereum chains require GCP keys.
//   return [gcpKey, new AgentAwsKey(agentConfig, Role.Kathy)];
// }

// If getting all keys for relayers or validators, it's recommended to use
// `getAllRelayerCloudAgentKeys` or `getAllValidatorCloudAgentKeys` instead.
export function getCloudAgentKey(
  agentConfig: AgentContextConfig,
  role: Role,
  chainName?: ChainName,
  index?: number,
): CloudAgentKey {
  // Non-evm Kathy is always GCP-based but does not index by chain
  if (
    role === Role.Kathy &&
    chainName &&
    isNotEthereumProtocolChain(chainName)
  ) {
    return new AgentGCPKey(agentConfig.runEnv, agentConfig.context, role);
  }
  // Otherwise use an AWS key except for the deployer
  else if (!!agentConfig.aws && role !== Role.Deployer && role !== Role.Kathy) {
    return new AgentAwsKey(agentConfig, role, chainName, index);
  } else {
    // Fallback to GCP
    return new AgentGCPKey(
      agentConfig.runEnv,
      agentConfig.context,
      role,
      chainName,
      index,
    );
  }
}

// Returns the deployer key. This is always a GCP key, not chain specific,
// and in the Hyperlane context.
export function getDeployerKey(agentConfig: AgentContextConfig): CloudAgentKey {
  return new AgentGCPKey(agentConfig.runEnv, Contexts.Hyperlane, Role.Deployer);
}

export function getValidatorKeysForChain(
  agentConfig: AgentContextConfig,
  chainName: ChainName,
  index: number,
): {
  validator: CloudAgentKey;
  chainSigner: CloudAgentKey;
} {
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
  const chainSigner = isEthereumProtocolChain(chainName)
    ? validator
    : new AgentGCPKey(
        agentConfig.runEnv,
        agentConfig.context,
        Role.Validator,
        chainName,
        index,
      );

  return {
    validator,
    chainSigner,
  };
}

// // Returns all keys used by validators: for each chain, an AWS key
// // if AWS is enabled, and a GCP key if AWS is not enabled or the chain
// // is not an EVM chain.
// export function getAllValidatorCloudAgentKeys(
//   agentConfig: RootAgentConfig,
// ): Array<CloudAgentKey> {
//   // For each chainName, create validatorCount keys
//   if (!agentConfig.validators) return [];

//   const validators = agentConfig.validators;
//   return agentConfig.contextChainNames[Role.Validator]
//     .filter((chainName) => !!validators.chains[chainName])
//     .flatMap((chainName) =>
//       validators.chains[chainName].validators.map((_, index) => {
//         const validatorKeys = [];

//         // If AWS is enabled, we want to use AWS keys for the validator signing key
//         // that actually signs checkpoints.
//         if (agentConfig.aws) {
//           validatorKeys.push(
//             new AgentAwsKey(agentConfig, Role.Validator, chainName, index),
//           );
//         }

//         // If the chain is not an EVM chain, we also want to use GCP keys for
//         // self-announcing. This key won't actually sign checkpoints, just the self-announcement tx.
//         // We also want to use a GCP key if AWS is not enabled.
//         if (isNotEthereumProtocolChain(chainName) || !agentConfig.aws) {
//           validatorKeys.push(
//             new AgentGCPKey(
//               agentConfig.runEnv,
//               agentConfig.context,
//               Role.Validator,
//               chainName,
//               index,
//             ),
//           );
//         }

//         return validatorKeys;
//       }),
//     )
//     .flat();
// }

export function getAllCloudAgentKeys(
  agentConfig: RootAgentConfig,
): Array<CloudAgentKey> {
  // const keys = [];
  // if (agentConfig.rolesWithKeys.includes(Role.Relayer))
  //   keys.push(...getAllRelayerCloudAgentKeys(agentConfig));
  // if (agentConfig.rolesWithKeys.includes(Role.Validator))
  //   keys.push(...getAllValidatorCloudAgentKeys(agentConfig));
  // if (agentConfig.rolesWithKeys.includes(Role.Kathy))
  //   keys.push(...getAllKathyCloudAgentKeys(agentConfig));

  // for (const role of agentConfig.rolesWithKeys) {
  //   if (role == Role.Relayer || role == Role.Validator || role == Role.Kathy)
  //     continue;
  //   keys.push(getCloudAgentKey(agentConfig, role));
  // }
  // return keys;

  const keysPerChain = getKeysPerChain(agentConfig);

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

export async function deleteAgentKeys(agentConfig: AgentContextConfig) {
  const keys = getAllCloudAgentKeys(agentConfig);
  await Promise.all(keys.map((key) => key.delete()));
  await execCmd(
    `gcloud secrets delete ${addressesIdentifier(
      agentConfig.runEnv,
      agentConfig.context,
    )} --quiet`,
  );
}

export async function createAgentKeysIfNotExists(
  agentConfig: AgentContextConfig,
) {
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
  agentConfig: AgentContextConfig,
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

// getRoleKeysPerChain
export function getKeysPerChain(
  agentConfig: RootAgentConfig,
): ChainMap<Record<Role, Record<string, CloudAgentKey>>> {
  const keysPerChain: ChainMap<Record<Role, Record<string, CloudAgentKey>>> =
    {};

  const setValidatorKeys = () => {
    const validators = agentConfig.validators;
    for (const chainName of agentConfig.contextChainNames.validator) {
      let chainValidatorKeys = {};

      const validatorCount =
        validators?.chains[chainName].validators.length ?? 0;
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
    for (const chainName of Object.keys(
      helloWorld[agentConfig.context]?.addresses || {},
    )) {
      const kathyKey = getKathyKeyForChain(agentConfig, chainName);
      keysPerChain[chainName] = {
        ...keysPerChain[chainName],
        [Role.Relayer]: {
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

// This function returns all keys for a given mailbox chain in a dictionary where the key is the identifier
export async function fetchKeysForChain(
  agentConfig: RootAgentConfig,
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
