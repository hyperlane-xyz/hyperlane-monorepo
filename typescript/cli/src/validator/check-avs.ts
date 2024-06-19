import {
  ECDSAStakeRegistry__factory,
  ValidatorAnnounce__factory,
} from '@hyperlane-xyz/core';
import { MerkleTreeHook__factory } from '@hyperlane-xyz/core';
// import { ChainName } from '@hyperlane-xyz/sdk';
import { Address } from '@hyperlane-xyz/utils';

import { avsAddresses } from '../avs/config.js';
import { CommandContext } from '../context/types.js';
import { warnYellow } from '../logger.js';

import {
  getLatestMerkleTreeCheckpointIndex,
  getLatestValidatorCheckpointIndex,
  getValidatorStorageLocations,
  isValidatorSigningLatestCheckpoint,
} from './utils.js';

// interface ChainInfo {
//   chain: string;
//   storageLocation: string;
//   latestMerkleTreeCheckpointIndex: number;
//   latestValidatorCheckpointIndex: number;
//   validatorSynced: boolean;
//   warnings: string[];
// }

// interface ValidatorInfo {
//   validatorAddress: Address;
//   operatorAddress: Address;
//   chains: Record<ChainName, ChainInfo>;
// }

export const checkValidatorAVSSetup = async (
  context: CommandContext,
  chain: string,
) => {
  const { multiProvider, registry } = context;

  async function checkValidators() {
    const chains = await registry.getChains();
    const addresses = await registry.getAddresses();

    for (const chain of chains) {
      // TODO: remove
      if (chain === 'anvil8545') {
        continue;
      }

      const chainAddresses = addresses[chain];
      if (chainAddresses === undefined) {
        continue;
      }

      const validatorAnnounce = ValidatorAnnounce__factory.connect(
        chainAddresses.validatorAnnounce,
        multiProvider.getSigner(chain),
      );

      const MerkleTreeHook = MerkleTreeHook__factory.connect(
        chainAddresses.merkleTreeHook,
        multiProvider.getSigner(chain),
      );

      const latestMerkleTreeCheckpointIndex =
        await getLatestMerkleTreeCheckpointIndex(MerkleTreeHook);

      const validatorStorageLocations = await getValidatorStorageLocations(
        validatorAnnounce,
        validatingKeys,
      );

      if (!validatorStorageLocations) {
        warnYellow(
          `❗️ Failed to fetch validator storage locations on ${chain}, skipping this chain...`,
        );
        continue;
      }

      for (let i = 0; i < validatingKeys.length; i++) {
        const validatorKey = validatingKeys[i];
        const storageLocation = validatorStorageLocations[i];
        const warnings = [];

        if (storageLocation.length === 0) {
          continue;
        }

        const latestValidatorCheckpointIndex =
          await getLatestValidatorCheckpointIndex(storageLocation[0]);

        if (!latestMerkleTreeCheckpointIndex) {
          warnings.push(
            `❗️ Failed to fetch latest checkpoint index of merkleTreeHook on ${chain}.`,
          );
        }

        if (!latestValidatorCheckpointIndex) {
          warnings.push(
            `❗️ Failed to fetch latest signed checkpoint index of on ${chain}.`,
          );
        }

        let validatorSynced = undefined;
        if (latestMerkleTreeCheckpointIndex && latestValidatorCheckpointIndex) {
          validatorSynced = isValidatorSigningLatestCheckpoint(
            latestValidatorCheckpointIndex,
            latestMerkleTreeCheckpointIndex,
          );
        }

        const chainInfo = {
          chain,
          storageLocation: storageLocation[0],
          latestMerkleTreeCheckpointIndex,
          latestValidatorCheckpointIndex,
          validatorSynced,
          warnings,
        };

        avsKeys
          .find((key) => key.signingKey === validatorKey)
          ?.chains.push(chainInfo);
      }
    }
  }

  // TODO: read from registry when these contracts are added
  const ecdsaStakeRegistryAddress = avsAddresses[chain]['ecdsaStakeRegistry'];

  const ecdsaStakeRegistry = ECDSAStakeRegistry__factory.connect(
    ecdsaStakeRegistryAddress,
    multiProvider.getSigner(chain),
  );

  const filter = ecdsaStakeRegistry.filters.SigningKeyUpdate(null, null);
  const provider = multiProvider.getProvider(chain);
  const latestBlock = await provider.getBlockNumber();
  const blockLimit = 50000; // 50k blocks per query

  let fromBlock = 1625972; // when ecdsaStakeRegistry was deployed

  let avsKeys: {
    operatorKey: Address;
    signingKey: Address;
    chains: {}[];
  }[] = [];

  const avsKeysMap = new Map();
  // const validatorInfo: ValidatorInfo = {};

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

      if (avsKeysMap.has(operatorKey)) {
        const existingEntry = avsKeysMap.get(operatorKey);
        existingEntry.signingKey = signingKey;
      } else {
        avsKeysMap.set(operatorKey, {
          operatorKey,
          signingKey,
          chains: [],
        });
      }
    });

    fromBlock = toBlock + 1;
  }

  avsKeys = Array.from(avsKeysMap.values());

  const validatingKeys = avsKeys.map((key) => key.signingKey);

  await checkValidators();

  console.log(JSON.stringify(avsKeys, null, 2));
};

// const logOutput = (
//   avskeys: {
//     operatorKey: Address;
//     signingKey: Address;
//     chains: {}[];
//   }[],
// ) => {
//   console.log(JSON.stringify(avskeys, null, 2));
// };
