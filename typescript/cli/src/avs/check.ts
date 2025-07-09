import { Wallet } from 'ethers';

import {
  ECDSAStakeRegistry__factory,
  IDelegationManager__factory,
  MerkleTreeHook__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  MultiProvider,
  isValidValidatorStorageLocation,
} from '@hyperlane-xyz/sdk';
import { Address, ProtocolType, isObjEmpty } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import {
  errorRed,
  log,
  logBlue,
  logBlueKeyValue,
  logBoldBlue,
  logDebug,
  logGreen,
  warnYellow,
} from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import {
  getLatestMerkleTreeCheckpointIndex,
  getLatestValidatorCheckpointIndexAndUrl,
  getValidatorStorageLocations,
  isValidatorSigningLatestCheckpoint,
} from '../validator/utils.js';

import { avsAddresses } from './config.js';
import { readOperatorFromEncryptedJson } from './stakeRegistry.js';

interface ChainInfo {
  storageLocation?: string;
  latestMerkleTreeCheckpointIndex?: number;
  latestValidatorCheckpointIndex?: number;
  validatorSynced?: boolean;
  warnings?: string[];
}

interface ValidatorInfo {
  operatorAddress: Address;
  operatorName?: string;
  chains: ChainMap<ChainInfo>;
}

export const checkValidatorAvsSetup = async (
  chain: string,
  context: CommandContext,
  operatorKeyPath?: string,
  operatorAddress?: string,
) => {
  logBlue(
    `Checking AVS validator status for ${chain}, ${
      !operatorKeyPath ? 'this may take up to a minute to run' : ''
    }...`,
  );

  const { multiProvider } = context;

  const topLevelErrors: string[] = [];

  let operatorWallet: Wallet | undefined;
  if (operatorKeyPath) {
    operatorWallet = await readOperatorFromEncryptedJson(operatorKeyPath);
  }

  const avsOperatorRecord = await getAvsOperators(
    chain,
    multiProvider,
    topLevelErrors,
    operatorAddress ?? operatorWallet?.address,
  );

  await setOperatorName(
    chain,
    avsOperatorRecord,
    multiProvider,
    topLevelErrors,
  );

  if (!isObjEmpty(avsOperatorRecord)) {
    await setValidatorInfo(context, avsOperatorRecord, topLevelErrors);
  }

  logOutput(avsOperatorRecord, topLevelErrors);
};

const getAvsOperators = async (
  chain: string,
  multiProvider: MultiProvider,
  topLevelErrors: string[],
  operatorKey?: string,
): Promise<ChainMap<ValidatorInfo>> => {
  const avsOperators: Record<Address, ValidatorInfo> = {};

  const ecdsaStakeRegistryAddress = getEcdsaStakeRegistryAddress(
    chain,
    topLevelErrors,
  );

  if (!ecdsaStakeRegistryAddress) {
    return avsOperators;
  }

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    ecdsaStakeRegistryAddress,
    multiProvider.getProvider(chain),
  );

  if (operatorKey) {
    // If operator key is provided, only fetch the operator's validator info
    const signingKey =
      await ecdsaStakeRegistry.getLastestOperatorSigningKey(operatorKey);
    avsOperators[signingKey] = {
      operatorAddress: operatorKey,
      chains: {},
    };

    return avsOperators;
  }

  const filter = ecdsaStakeRegistry.filters.SigningKeyUpdate(null, null);
  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();
  const blockLimit = 50000; // 50k blocks per query

  let fromBlock = 1625972; // when ecdsaStakeRegistry was deployed

  while (fromBlock < latestBlock) {
    const toBlock = Math.min(fromBlock + blockLimit, latestBlock);
    const logs = await ecdsaStakeRegistry.queryFilter(
      filter,
      fromBlock,
      toBlock,
    );

    logs.forEach((log) => {
      const event = ecdsaStakeRegistry.interface.parseLog(log);
      const operatorKey = event.args.operator;
      const signingKey = event.args.newSigningKey;

      if (avsOperators[signingKey]) {
        avsOperators[signingKey].operatorAddress = operatorKey;
      } else {
        avsOperators[signingKey] = {
          operatorAddress: operatorKey,
          chains: {},
        };
      }
    });

    fromBlock = toBlock + 1;
  }

  return avsOperators;
};

const getAVSMetadataURI = async (
  chain: string,
  operatorAddress: string,
  multiProvider: MultiProvider,
): Promise<string | undefined> => {
  const delegationManagerAddress = avsAddresses[chain]['delegationManager'];

  const delegationManager = IDelegationManager__factory.connect(
    delegationManagerAddress,
    multiProvider.getProvider(chain),
  );

  const filter = delegationManager.filters.OperatorMetadataURIUpdated(
    operatorAddress,
    null,
  );

  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();
  const blockLimit = 50000; // 50k blocks per query

  let fromBlock = 17445563;
  while (fromBlock < latestBlock) {
    const toBlock = Math.min(fromBlock + blockLimit, latestBlock);
    const logs = await delegationManager.queryFilter(
      filter,
      fromBlock,
      toBlock,
    );

    if (logs.length > 0) {
      const event = delegationManager.interface.parseLog(logs[0]);
      return event.args.metadataURI;
    }

    fromBlock = toBlock + 1;
  }

  return undefined;
};

const setOperatorName = async (
  chain: string,
  avsOperatorRecord: Record<Address, ValidatorInfo>,
  multiProvider: MultiProvider,
  topLevelErrors: string[] = [],
) => {
  for (const [_, validatorInfo] of Object.entries(avsOperatorRecord)) {
    const metadataURI = await getAVSMetadataURI(
      chain,
      validatorInfo.operatorAddress,
      multiProvider,
    );

    if (metadataURI) {
      const operatorName = await fetchOperatorName(metadataURI);
      if (operatorName) {
        validatorInfo.operatorName = operatorName;
      } else {
        topLevelErrors.push(
          `❗️ Failed to fetch operator name from metadataURI: ${metadataURI}`,
        );
      }
    }
  }
};

const setValidatorInfo = async (
  context: CommandContext,
  avsOperatorRecord: Record<Address, ValidatorInfo>,
  topLevelErrors: string[],
) => {
  const { multiProvider, registry, chainMetadata } = context;
  const failedToReadChains: string[] = [];

  const validatorAddresses = Object.keys(avsOperatorRecord);

  const chains = await registry.getChains();
  const addresses = await registry.getAddresses();

  for (const chain of chains) {
    // skip if chain is not an Ethereum chain
    if (chainMetadata[chain].protocol !== ProtocolType.Ethereum) continue;

    const chainAddresses = addresses[chain];

    // skip if no contract addresses are found for this chain
    if (chainAddresses === undefined) continue;

    if (!chainAddresses.validatorAnnounce) {
      topLevelErrors.push(`❗️ ValidatorAnnounce is not deployed on ${chain}`);
    }

    if (!chainAddresses.merkleTreeHook) {
      topLevelErrors.push(`❗️ MerkleTreeHook is not deployed on ${chain}`);
    }

    if (!chainAddresses.validatorAnnounce || !chainAddresses.merkleTreeHook) {
      continue;
    }

    const validatorAnnounce = ValidatorAnnounce__factory.connect(
      chainAddresses.validatorAnnounce,
      multiProvider.getProvider(chain),
    );

    const merkleTreeHook = MerkleTreeHook__factory.connect(
      chainAddresses.merkleTreeHook,
      multiProvider.getProvider(chain),
    );

    const latestMerkleTreeCheckpointIndex =
      await getLatestMerkleTreeCheckpointIndex(merkleTreeHook, chain);

    const validatorStorageLocations = await getValidatorStorageLocations(
      validatorAnnounce,
      validatorAddresses,
      chain,
    );

    if (!validatorStorageLocations) {
      failedToReadChains.push(chain);
      continue;
    }

    for (let i = 0; i < validatorAddresses.length; i++) {
      const validatorAddress = validatorAddresses[i];
      const storageLocation = validatorStorageLocations[i];
      const warnings: string[] = [];

      const lastStorageLocation =
        storageLocation.length > 0 ? storageLocation.slice(-1)[0] : '';

      // Skip if no storage location is found, address is not validating on this chain or if not a valid storage location
      if (!isValidValidatorStorageLocation(lastStorageLocation)) {
        continue;
      }

      const [latestValidatorCheckpointIndex, latestCheckpointUrl] =
        (await getLatestValidatorCheckpointIndexAndUrl(
          lastStorageLocation,
        )) ?? [undefined, undefined];

      if (!latestMerkleTreeCheckpointIndex) {
        warnings.push(
          `❗️ Failed to fetch latest checkpoint index of merkleTreeHook on ${chain}.`,
        );
      }

      if (!latestValidatorCheckpointIndex) {
        warnings.push(
          `❗️ Failed to fetch latest signed checkpoint index of validator on ${chain}, this is likely due to failing to read an S3 bucket`,
        );
      }

      let validatorSynced = undefined;
      if (latestMerkleTreeCheckpointIndex && latestValidatorCheckpointIndex) {
        validatorSynced = isValidatorSigningLatestCheckpoint(
          latestValidatorCheckpointIndex,
          latestMerkleTreeCheckpointIndex,
        );
      }

      const chainInfo: ChainInfo = {
        storageLocation: latestCheckpointUrl,
        latestMerkleTreeCheckpointIndex,
        latestValidatorCheckpointIndex,
        validatorSynced,
        warnings,
      };

      const validatorInfo = avsOperatorRecord[validatorAddress];
      if (validatorInfo) {
        validatorInfo.chains[chain as ChainName] = chainInfo;
      }
    }
  }

  if (failedToReadChains.length > 0) {
    topLevelErrors.push(
      `❗️ Failed to read storage locations onchain for ${failedToReadChains.join(
        ', ',
      )}`,
    );
  }
};

const logOutput = (
  avsKeysRecord: Record<Address, ValidatorInfo>,
  topLevelErrors: string[],
) => {
  if (topLevelErrors.length > 0) {
    for (const error of topLevelErrors) {
      errorRed(error);
    }
  }

  for (const [validatorAddress, data] of Object.entries(avsKeysRecord)) {
    log('\n\n');
    if (data.operatorName) logBlueKeyValue('Operator name', data.operatorName);
    logBlueKeyValue('Operator address', data.operatorAddress);
    logBlueKeyValue('Validator address', validatorAddress);

    if (!isObjEmpty(data.chains)) {
      logBoldBlue(indentYamlOrJson('Validating on...', 2));
      for (const [chain, chainInfo] of Object.entries(data.chains)) {
        logBoldBlue(indentYamlOrJson(chain, 2));

        if (chainInfo.storageLocation) {
          logBlueKeyValue(
            indentYamlOrJson('Storage location', 2),
            chainInfo.storageLocation,
          );
        }

        if (chainInfo.latestMerkleTreeCheckpointIndex) {
          logBlueKeyValue(
            indentYamlOrJson('Latest merkle tree checkpoint index', 2),
            String(chainInfo.latestMerkleTreeCheckpointIndex),
          );
        }

        if (chainInfo.latestValidatorCheckpointIndex) {
          logBlueKeyValue(
            indentYamlOrJson('Latest validator checkpoint index', 2),
            String(chainInfo.latestValidatorCheckpointIndex),
          );

          if (chainInfo.validatorSynced) {
            logGreen(
              indentYamlOrJson('✅ Validator is signing latest checkpoint', 2),
            );
          } else {
            errorRed(
              indentYamlOrJson(
                '❌ Validator is not signing latest checkpoint',
                2,
              ),
            );
          }
        } else {
          errorRed(
            indentYamlOrJson(
              '❌ Failed to fetch latest signed checkpoint index',
              2,
            ),
          );
        }

        if (chainInfo.warnings && chainInfo.warnings.length > 0) {
          warnYellow(
            indentYamlOrJson('The following warnings were encountered:', 2),
          );
          for (const warning of chainInfo.warnings) {
            warnYellow(indentYamlOrJson(warning, 3));
          }
        }
      }
    } else {
      logBlue('Validator is not validating on any chain');
    }
  }
};

const getEcdsaStakeRegistryAddress = (
  chain: string,
  topLevelErrors: string[],
): Address | undefined => {
  try {
    return avsAddresses[chain]['ecdsaStakeRegistry'];
  } catch {
    topLevelErrors.push(`❗️ EcdsaStakeRegistry address not found for ${chain}`);
    return undefined;
  }
};

const fetchOperatorName = async (metadataURI: string) => {
  try {
    const response = await fetch(metadataURI);
    const data = await response.json();
    return data['name'];
  } catch (err) {
    logDebug(`Failed to fetch operator name from ${metadataURI}: ${err}`);
    return undefined;
  }
};
