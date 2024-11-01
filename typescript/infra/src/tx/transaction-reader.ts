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
  CoreConfig,
  EvmIsmReader,
  HyperlaneReader,
  InterchainAccount,
  MultiProvider,
  coreFactories,
  interchainAccountFactories,
  normalizeConfig,
} from '@hyperlane-xyz/sdk';
import {
  addressToBytes32,
  bytes32ToAddress,
  deepEquals,
  eqAddress,
  retryAsync,
  sleep,
} from '@hyperlane-xyz/utils';

import {
  icaOwnerChain,
  icas,
  safes,
} from '../../config/environments/mainnet3/owners.js';
import { DeployEnvironment } from '../config/environment.js';
import { getSafeAndService } from '../utils/safe.js';

export class TransactionReader extends HyperlaneReader {
  errors: any[] = [];

  constructor(
    readonly environment: DeployEnvironment,
    readonly multiProvider: MultiProvider,
    readonly chain: ChainName,
    readonly chainAddresses: ChainMap<Record<string, string>>,
    readonly coreConfig: ChainMap<CoreConfig>,
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
    // If it's to an ICA
    if (this.isIcaTransaction(chain, tx)) {
      return this.readIcaTransaction(chain, tx);
    }

    // If it's to a Mailbox
    if (this.isMailboxTransaction(chain, tx)) {
      return this.readMailboxTransaction(chain, tx);
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
    } else if (decoded.functionFragment.name === 'callRemoteWithOverrides') {
      prettyArgs = await this.readIcaCall(chain, args);
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

      let insight = '✅ matches expected router from artifacts';
      if (!matchesExpectedRouter) {
        insight = `❌ fatal mismatch, expected ${expectedRouter}`;
        this.errors.push({
          chain: chain,
          remoteDomain: domain,
          remoteChain: remoteChainName,
          router: routerToBeEnrolled,
          expected: expectedRouter,
          info: 'Incorrect router getting enrolled',
        });
      }

      return {
        domain: domain,
        chainName: remoteChainName,
        router: routerToBeEnrolled,
        insight,
      };
    });
  }

  private async readMailboxTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<any> {
    if (!tx.data) {
      console.log('No data in mailbox transaction');
      return undefined;
    }
    const { symbol } = await this.multiProvider.getNativeToken(chain);
    const decoded = coreFactories.mailbox.interface.parseTransaction({
      data: tx.data,
      value: tx.value,
    });

    const args = formatFunctionFragmentArgs(
      decoded.args,
      decoded.functionFragment,
    );
    let prettyArgs = args;
    if (decoded.functionFragment.name === 'setDefaultIsm') {
      prettyArgs = await this.formatMailboxSetDefaultIsm(chain, args);
    }

    return {
      signature: decoded.signature,
      args: prettyArgs,
    };
  }

  ismDerivationsInProgress: ChainMap<boolean> = {};

  private async formatMailboxSetDefaultIsm(
    chain: ChainName,
    args: Record<string, any>,
  ): Promise<any> {
    const { _module: module } = args;

    const reader = new EvmIsmReader(this.multiProvider, chain);
    const startTime = Date.now();
    console.log('Deriving ISM config...', chain);
    this.ismDerivationsInProgress[chain] = true;
    const derivedConfig = await reader.deriveIsmConfig(module);
    delete this.ismDerivationsInProgress[chain];
    console.log(
      'Finished deriving ISM config',
      chain,
      'in',
      (Date.now() - startTime) / (1000 * 60),
      'mins',
    );
    const remainingInProgress = Object.keys(this.ismDerivationsInProgress);
    console.log(
      'Remaining derivations in progress:',
      remainingInProgress.length,
      'chains',
      remainingInProgress,
    );
    const expectedIsmConfig = this.coreConfig[chain].defaultIsm;

    let insight = '✅ matches expected ISM config';
    const normalizedDerived = normalizeConfig(derivedConfig);
    const normalizedExpected = normalizeConfig(expectedIsmConfig);
    if (!deepEquals(normalizedDerived, normalizedExpected)) {
      this.errors.push({
        chain: chain,
        module,
        derivedConfig,
        expectedIsmConfig,
        info: 'Incorrect default ISM being set',
      });
      insight = `❌ fatal mismatch of ISM config`;
      console.log(
        'Mismatch of ISM config',
        chain,
        JSON.stringify(normalizedDerived),
        JSON.stringify(normalizedExpected),
      );
    }

    return {
      module,
      insight,
    };
  }

  private async readIcaCall(
    chain: ChainName,
    args: Record<string, any>,
  ): Promise<any> {
    const {
      _destination: destination,
      _router: router,
      _ism: ism,
      _calls: calls,
    } = args;
    const remoteChainName = this.multiProvider.getChainName(destination);

    const expectedRouter =
      this.chainAddresses[remoteChainName].interchainAccountRouter;
    const matchesExpectedRouter =
      eqAddress(expectedRouter, bytes32ToAddress(router)) &&
      // Poor man's check that the 12 byte padding is all zeroes
      addressToBytes32(bytes32ToAddress(router)) === router;
    let routerInsight = '✅ matches expected router from artifacts';
    if (!matchesExpectedRouter) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        router: router,
        expected: expectedRouter,
        info: 'Incorrect router in ICA call',
      });
      routerInsight = `❌ fatal mismatch, expected ${expectedRouter}`;
    }

    let ismInsight = '✅ matches expected ISM';
    if (ism !== ethers.constants.HashZero) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        ism,
        info: 'Incorrect ISM in ICA call, expected zero hash',
      });
      ismInsight = `❌ fatal mismatch, expected zero hash`;
    }

    const remoteIcaAddress = await InterchainAccount.fromAddressesMap(
      this.chainAddresses,
      this.multiProvider,
    ).getAccount(remoteChainName, {
      owner: safes[icaOwnerChain],
      origin: icaOwnerChain,
      routerOverride: router,
      ismOverride: ism,
    });
    const expectedRemoteIcaAddress = icas[remoteChainName as keyof typeof icas];
    let remoteIcaInsight = '✅ matches expected ICA';
    if (
      !expectedRemoteIcaAddress ||
      !eqAddress(remoteIcaAddress, expectedRemoteIcaAddress)
    ) {
      this.errors.push({
        chain: chain,
        remoteDomain: destination,
        remoteChain: remoteChainName,
        ica: remoteIcaAddress,
        expected: expectedRemoteIcaAddress,
        info: 'Incorrect destination ICA in ICA call',
      });
      remoteIcaInsight = `❌ fatal mismatch, expected ${remoteIcaAddress}`;
    }

    const decodedCalls = await Promise.all(
      calls.map((call: any) => {
        const icaCallAsTx = {
          to: bytes32ToAddress(call[0]),
          value: BigNumber.from(call[1]),
          data: call[2],
        };
        return this.read(remoteChainName, icaCallAsTx);
      }),
    );

    return {
      destination: {
        domain: destination,
        chainName: remoteChainName,
      },
      router: {
        address: router,
        insight: routerInsight,
      },
      ism: {
        address: ism,
        insight: ismInsight,
      },
      destinationIca: {
        address: remoteIcaAddress,
        insight: remoteIcaInsight,
      },
      calls: decodedCalls,
    };
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

  isMailboxTransaction(chain: ChainName, tx: AnnotatedEV5Transaction): boolean {
    return (
      tx.to !== undefined &&
      eqAddress(tx.to, this.chainAddresses[chain].mailbox)
    );
  }

  async isMultisendTransaction(
    chain: ChainName,
    tx: AnnotatedEV5Transaction,
  ): Promise<boolean> {
    if (tx.to === undefined) {
      return false;
    }
    const multiSendCallOnlyAddress = await this.getMultiSendCallOnlyAddress(
      chain,
    );
    if (!multiSendCallOnlyAddress) {
      return false;
    }

    // why call only? if we do delegatecall
    return eqAddress(multiSendCallOnlyAddress, tx.to);
  }

  multiSendCallOnlyAddressCache: ChainMap<string> = {};

  async getMultiSendCallOnlyAddress(
    chain: ChainName,
  ): Promise<string | undefined> {
    if (this.multiSendCallOnlyAddressCache[chain]) {
      return this.multiSendCallOnlyAddressCache[chain];
    }

    const safe = safes[chain];
    if (!safe) {
      return undefined;
    }

    const { safeSdk } = await retryAsync(() =>
      getSafeAndService(this.chain, this.multiProvider, safe),
    );

    // why call only? if we do delegatecall
    this.multiSendCallOnlyAddressCache[chain] =
      safeSdk.getMultiSendCallOnlyAddress();
    return this.multiSendCallOnlyAddressCache[chain];
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
