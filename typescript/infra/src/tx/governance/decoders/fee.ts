import assert from 'assert';
import { ethers } from 'ethers';

import { BaseFee__factory, RoutingFee__factory } from '@hyperlane-xyz/core';
import {
  ChainName,
  EvmTokenFeeReader,
  OnchainTokenFeeType,
  TokenFeeType,
  onChainTypeToTokenFeeTypeMap,
} from '@hyperlane-xyz/sdk';
import { isZeroishAddress } from '@hyperlane-xyz/utils';

import { formatFeeConfig } from '../fees.js';
import type { GovernanceDecoder } from '../types.js';

const FEE_SELECTORS = new Set([
  '0x16068373', // setFeeContract(uint32,address) - RoutingFee
  '0x1e83409a', // claim(address) - BaseFee
]);

export function createFeeContractDecoder(): GovernanceDecoder {
  return {
    id: 'fee-contract',
    priority: 110,
    match: async ({ state, chain, tx }) => {
      if (!tx.to || !tx.data) return undefined;
      const selector = tx.data.slice(0, 10).toLowerCase();
      if (!FEE_SELECTORS.has(selector)) return undefined;

      const provider = state.multiProvider.getProvider(chain);
      const code = await provider.getCode(tx.to);
      if (code === '0x') return undefined;
      return code.includes('fb8dc179') ? true : undefined;
    },
    decode: async ({ runtime, state, chain, tx }) => {
      assert(tx.data, 'No data in fee transaction');
      assert(tx.to, 'No to address in fee transaction');

      const provider = state.multiProvider.getProvider(chain);
      const baseFee = BaseFee__factory.connect(tx.to, provider);

      const onChainFeeType: OnchainTokenFeeType = await baseFee.feeType();
      const feeTypeName = onChainTypeToTokenFeeTypeMap[onChainFeeType];
      assert(feeTypeName, `Unknown Fee Type ${onChainFeeType}`);

      const { insight, feeDetails, decoded } = await parseFeeTransactionData(
        state.multiProvider,
        chain,
        feeTypeName,
        tx,
      );

      const ownableTx = insight
        ? {}
        : await runtime.readOwnableTransaction(chain, tx);

      return {
        ...ownableTx,
        chain,
        to: `${feeTypeName} Contract (${chain} ${tx.to})`,
        ...(insight ? { insight } : {}),
        ...(feeDetails ? { feeDetails } : {}),
        signature: decoded.signature,
      };
    },
  };
}

async function parseFeeTransactionData(
  multiProvider: Parameters<
    GovernanceDecoder['decode']
  >[0]['state']['multiProvider'],
  chain: ChainName,
  feeTypeName: TokenFeeType,
  tx: Parameters<GovernanceDecoder['decode']>[0]['tx'],
): Promise<{
  decoded: ethers.utils.TransactionDescription;
  insight?: string;
  feeDetails?: Record<string, unknown>;
}> {
  assert(tx.data, 'No data in fee transaction');

  const iface =
    feeTypeName === TokenFeeType.RoutingFee
      ? RoutingFee__factory.createInterface()
      : BaseFee__factory.createInterface();

  const decoded = iface.parseTransaction({
    data: tx.data,
    value: tx.value,
  });

  if (decoded.functionFragment.name === 'claim') {
    const [beneficiary] = decoded.args;
    return { decoded, insight: `Claim fees to ${beneficiary}` };
  }

  if (feeTypeName === TokenFeeType.RoutingFee) {
    return parseRoutingFeeTransaction(multiProvider, chain, decoded);
  }

  return { decoded };
}

async function parseRoutingFeeTransaction(
  multiProvider: Parameters<
    GovernanceDecoder['decode']
  >[0]['state']['multiProvider'],
  chain: ChainName,
  decoded: ethers.utils.TransactionDescription,
): Promise<{
  decoded: ethers.utils.TransactionDescription;
  insight?: string;
  feeDetails?: Record<string, unknown>;
}> {
  if (decoded.functionFragment.name !== 'setFeeContract') {
    return { decoded };
  }

  const [destination, feeContract] = decoded.args;
  const chainName =
    multiProvider.tryGetChainName(destination) ?? `unknown (${destination})`;

  if (isZeroishAddress(feeContract)) {
    return {
      decoded,
      insight: `Remove fee contract for domain ${destination} (${chainName})`,
    };
  }

  try {
    const feeReader = new EvmTokenFeeReader(multiProvider, chain);
    const feeConfig = await feeReader.deriveTokenFeeConfig({
      address: feeContract,
    });
    const formatted = await formatFeeConfig(chain, feeConfig);
    return {
      decoded,
      insight: `Set fee contract for domain ${destination} (${chainName}) to ${formatted.description}`,
      feeDetails: formatted.feeDetails,
    };
  } catch {
    return {
      decoded,
      insight: `Set fee contract for domain ${destination} (${chainName}) to ${feeContract} (Warning: could not read fee config)`,
    };
  }
}
