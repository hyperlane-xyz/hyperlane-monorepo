import { Wallet } from 'ethers';

import {
  ECDSAStakeRegistry__factory,
  MerkleTreeHook__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { ChainMap, ChainName, MultiProvider } from '@hyperlane-xyz/sdk';
import { Address, isObjEmpty } from '@hyperlane-xyz/utils';

import { CommandContext } from '../context/types.js';
import {
  errorRed,
  indent,
  logBlue,
  logBlueKeyValue,
  logBoldBlue,
  logGreen,
  warnYellow,
} from '../logger.js';
import {
  getLatestMerkleTreeCheckpointIndex,
  getLatestValidatorCheckpointIndex,
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
  chains: ChainMap<ChainInfo>;
}

export const checkValidatorAVSSetup = async (
  chain: string,
  context: CommandContext,
  operatorKeyPath?: string,
) => {
  logBlue(`Checking AVS setup for ${chain}...`);

  const { multiProvider } = context;

  const topLevelErrors: string[] = [];

  let operator: Wallet | undefined;
  if (operatorKeyPath) {
    operator = await readOperatorFromEncryptedJson(operatorKeyPath);
  }

  const avsOperatorRecord = await getAvsOperators(
    chain,
    multiProvider,
    topLevelErrors,
    operator?.address,
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
    multiProvider.getSigner(chain),
  );

  if (operatorKey) {
    // If operator key is provided, only fetch the operator's validator info
    const signingKey = await ecdsaStakeRegistry.getLastestOperatorSigningKey(
      operatorKey,
    );
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

const setValidatorInfo = async (
  context: CommandContext,
  avsOperatorRecord: Record<Address, ValidatorInfo>,
  topLevelErrors: string[],
) => {
  const { multiProvider, registry } = context;
  const failedToReadChains: string[] = [];

  const validatorAddresses = Object.keys(avsOperatorRecord);

  const chains = await registry.getChains();
  const addresses = await registry.getAddresses();

  for (const chain of chains) {
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
      multiProvider.getSigner(chain),
    );

    const merkleTreeHook = MerkleTreeHook__factory.connect(
      chainAddresses.merkleTreeHook,
      multiProvider.getSigner(chain),
    );

    const latestMerkleTreeCheckpointIndex =
      await getLatestMerkleTreeCheckpointIndex(merkleTreeHook);
    const validatorStorageLocations = await getValidatorStorageLocations(
      validatorAnnounce,
      validatorAddresses,
    );

    if (!validatorStorageLocations) {
      failedToReadChains.push(chain);
      continue;
    }

    for (let i = 0; i < validatorAddresses.length; i++) {
      const validatorAddress = validatorAddresses[i];
      const storageLocation = validatorStorageLocations[i];
      const warnings: string[] = [];

      // Skip if no storage location is found, address is not validating on this chain
      if (storageLocation.length === 0) continue;

      const latestValidatorCheckpointIndex =
        await getLatestValidatorCheckpointIndex(storageLocation[0]);

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
        storageLocation: storageLocation[0],
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
    logBlueKeyValue('\n\nValidator', validatorAddress);
    logBlueKeyValue('Operator address', data.operatorAddress);

    if (!isObjEmpty(data.chains)) {
      logBoldBlue(indent('Validating on...'));
      for (const [chain, chainInfo] of Object.entries(data.chains)) {
        logBoldBlue(indent(chain));

        if (chainInfo.storageLocation) {
          logBlueKeyValue(
            indent('Storage location'),
            chainInfo.storageLocation,
          );
        }

        if (chainInfo.latestMerkleTreeCheckpointIndex) {
          logBlueKeyValue(
            indent('Latest merkle tree checkpoint index'),
            String(chainInfo.latestMerkleTreeCheckpointIndex),
          );
        }

        if (chainInfo.latestValidatorCheckpointIndex) {
          logBlueKeyValue(
            indent('Latest validator checkpoint index'),
            String(chainInfo.latestValidatorCheckpointIndex),
          );

          if (chainInfo.validatorSynced) {
            logGreen(indent('✅ Validator is signing latest checkpoint'));
          } else {
            errorRed(indent('❌ Validator is not signing latest checkpoint'));
          }
        } else {
          errorRed(indent('❌ Failed to fetch latest signed checkpoint index'));
        }

        if (chainInfo.warnings && chainInfo.warnings.length > 0) {
          warnYellow(indent('The following warnings were encountered:'));
          for (const warning of chainInfo.warnings) {
            warnYellow(indent(warning, 3));
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
  } catch (err) {
    topLevelErrors.push(
      `❗️ EcdsaStakeRegistry address not found for ${chain}`,
    );
    return undefined;
  }
};
