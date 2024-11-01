import { Result } from '@ethersproject/abi';
import { decodeMultiSendData } from '@safe-global/protocol-kit/dist/src/utils/index.js';
import {
  MetaTransactionData,
  OperationType,
} from '@safe-global/safe-core-sdk-types';
import { BigNumber, ethers } from 'ethers';

import {
  AnnotatedEV5Transaction,
  ChainMap,
  ChainName,
  HyperlaneReader,
  MultiProvider,
  interchainAccountFactories,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils';

import { DeployEnvironment } from '../config/environment.js';
import { getSafeAndService } from '../utils/safe.js';

// export abstract class TransactionReader {
//   async read(chain: ChainName, tx: any): Promise<any> {
//     throw new Error('Not implemented');
//   }
// }

// export class GnosisMultisendReader extends TransactionReader {
//   constructor(multiProvider: MultiProvider) {
//     super();
//   }

//   async read(chain: ChainName, tx: AnnotatedEV5Transaction): Promise<any> {
//     if (!tx.data) {
//       return undefined;
//     }
//     const multisends = decodeMultiSendData(tx.data);

//     return multisends;
//   }
// }

export class TransactionReader extends HyperlaneReader {
  constructor(
    readonly environment: DeployEnvironment,
    readonly multiProvider: MultiProvider,
    readonly chain: ChainName,
    readonly chainAddresses: ChainMap<Record<string, string>>,
  ) {
    super(multiProvider, chain);
  }

  async read(chain: ChainName, tx: AnnotatedEV5Transaction): Promise<any> {
    try {
      return await this.doRead(chain, tx);
    } catch (e) {
      console.error('Error reading transaction', e, chain, tx);
      throw e;
    }
  }

  async doRead(chain: ChainName, tx: AnnotatedEV5Transaction): Promise<any> {
    // If it's an ICA
    if (this.isIcaTransaction(chain, tx)) {
      return this.readIcaTransaction(chain, tx);
    }

    if (await this.isMultisendTransaction(chain, tx)) {
      return this.readMultisendTransaction(chain, tx);
    }

    return {};
  }

  private async readIcaTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<any> {
    if (!tx.data) {
      console.log('No data in ICA transaction');
      return undefined;
    }
    const { symbol } = await this.multiProvider.getNativeToken(chain);
    const decoded =
      interchainAccountFactories.interchainAccountRouter.interface.parseTransaction(
        {
          data: tx.data,
          value: tx.value,
        },
      );

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );
    let prettyArgs = args;
    if (decoded.functionFragment.name === 'enrollRemoteRouters') {
      prettyArgs = await this.formatRouterEnrollments(
        chain,
        'interchainAccountRouter',
        args,
      );
    }

    return {
      value: `${ethers.utils.formatEther(decoded.value)} ${symbol}`,
      signature: decoded.signature,
      args: prettyArgs,
    };
  }

  private async formatRouterEnrollments(
    chain: ChainName,
    routerName: string,
    args: Record<string, any>,
  ): Promise<any> {
    const { _domains: domains, _addresses: addresses } = args;
    return domains.map((domain: number, index: number) => {
      const remoteChainName = this.multiProvider.getChainName(domain);
      const expectedRouter = this.chainAddresses[remoteChainName][routerName];
      const routerToBeEnrolled = addresses[index];
      const matchesExpectedRouter =
        eqAddress(expectedRouter, bytes32ToAddress(routerToBeEnrolled)) &&
        // Poor man's check that the 12 byte padding is all zeroes
        addressToBytes32(bytes32ToAddress(routerToBeEnrolled)) ===
          routerToBeEnrolled;
      return {
        domain: domain,
        chainName: remoteChainName,
        router: routerToBeEnrolled,
        'good?': matchesExpectedRouter
          ? '✅ matches expected router from artifacts'
          : `❌ fatal mismatch, expected ${expectedRouter}`,
      };
    });
  }

  private async readMultisendTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<any> {
    if (!tx.data) {
      console.log('No data in multisend transaction');
      return undefined;
    }
    const multisends = decodeMultiSendData(tx.data);

    const { symbol } = await this.multiProvider.getNativeToken(chain);

    return Promise.all(
      multisends.map(async (multisend, index) => {
        const decoded = await this.read(
          chain,
          metaTransactionDataToEV5Transaction(multisend),
        );
        return {
          index,
          value: `${ethers.utils.formatEther(multisend.value)} ${symbol}`,
          operation: formatOperationType(multisend.operation),
          decoded,
        };
      }),
    );
  }

  isIcaTransaction(chain: ChainName, tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].interchainAccountRouter)
    );
  }

  async isMultisendTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (tx.to === undefined) {
      return false;
    }
    const { safeSdk } = await getSafeAndService(
      this.chain,
      this.multiProvider,
      '0x3965AC3D295641E452E0ea896a086A9cD7C6C5b6',
    );

    // why call only? if we do delegatecall
    return eqAddress(safeSdk.getMultiSendCallOnlyAddress(), tx.to);
  }
}

function metaTransactionDataToEV5Transaction(
  metaTransactionData: MetaTransactionData,
): AnnotatedEV5Transaction {
  return {
    to: metaTransactionData.to,
    value: BigNumber.from(metaTransactionData.value),
    data: metaTransactionData.data,
  };
}

function formatFunctionFragmentArgs(
  args: Result,
  fragment: ethers.utils.FunctionFragment,
): Record<string, string> {
  const accumulator: Record<string, string> = {};
  return fragment.inputs.reduce((acc, input, index) => {
    acc[input.name] = args[index];
    return acc;
  }, accumulator);
}

function formatOperationType(operation: OperationType | undefined): string {
  switch (operation) {
    case OperationType.Call:
      return 'Call';
    case OperationType.DelegateCall:
      return 'Delegate Call';
    default:
      return '⚠️ Unknown ⚠️';
  }
}
