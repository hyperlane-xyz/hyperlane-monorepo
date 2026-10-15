import { BigNumber, Contract, constants, providers } from 'ethers';

import {
  FallbackDomainRoutingHook__factory,
  IERC20__factory,
  IPostDispatchHook__factory,
  InterchainAccountRouter__factory,
  InterchainGasPaymaster__factory,
  QuotedCalls__factory,
} from '@hyperlane-xyz/core';
import { isMissingSelectorCallException } from '@hyperlane-xyz/sdk/utils/contract';
import { Address, Logger } from '@hyperlane-xyz/utils';

import { createEvmChainReader } from '../aggregation-hook-upgrade/reader.js';

import type { Fees } from './types.js';

// OP stack chains charge a data fee for posting the transaction to L1 on top
// of the L2 gas cost, and expose its quote through this predeploy.
const OP_STACK_GAS_PRICE_ORACLE = '0x420000000000000000000000000000000000000F';
const OP_STACK_L1_FEE_ABI = ['function getL1Fee(bytes) view returns (uint256)'];

export interface IcaChainReader {
  hasCode(address: Address): Promise<boolean>;
  // Transactions of the account that have been mined.
  minedTransactionCount(address: Address): Promise<number>;
  packageVersion(address: Address): Promise<string>;
  routerState(router: Address): Promise<{
    owner: Address;
    mailbox: Address;
    hook: Address;
  }>;
  remoteRouter(router: Address, domainId: number): Promise<string>;
  quotedCallsPermit2(quotedCalls: Address): Promise<Address>;
  hookState(hook: Address): Promise<{ hookType: number; mailbox: Address }>;
  allowance(
    token: Address,
    owner: Address,
    spender: Address,
  ): Promise<BigNumber>;
  hasTokenGasOracle(
    igp: Address,
    token: Address,
    domainIds: number[],
  ): Promise<boolean>;
  balance(address: Address): Promise<BigNumber>;
  fees(): Promise<Fees>;
  estimateDeployGas(from: Address, data: string): Promise<BigNumber>;
  // Undefined when the chain has no L1 data fee or the oracle cannot quote it.
  l1DataFee(data: string): Promise<BigNumber | undefined>;
}

export function createIcaChainReader(
  provider: providers.Provider,
  options: { opStack: boolean; logger: Logger },
): IcaChainReader {
  const versions = createEvmChainReader(provider, options.logger);
  return {
    hasCode: async (address) => (await provider.getCode(address)) !== '0x',
    minedTransactionCount: (address) =>
      provider.getTransactionCount(address, 'latest'),
    packageVersion: (address) => versions.packageVersion(address),
    routerState: async (router) => {
      const contract = InterchainAccountRouter__factory.connect(
        router,
        provider,
      );
      const [owner, mailbox, hook] = await Promise.all([
        contract.owner(),
        contract.mailbox(),
        contract.hook(),
      ]);
      return { owner, mailbox, hook };
    },
    remoteRouter: (router, domainId) =>
      InterchainAccountRouter__factory.connect(router, provider).routers(
        domainId,
      ),
    quotedCallsPermit2: (quotedCalls) =>
      QuotedCalls__factory.connect(quotedCalls, provider).PERMIT2(),
    hookState: async (hook) => {
      const [hookType, mailbox] = await Promise.all([
        IPostDispatchHook__factory.connect(hook, provider).hookType(),
        FallbackDomainRoutingHook__factory.connect(hook, provider).mailbox(),
      ]);
      return { hookType, mailbox };
    },
    allowance: (token, owner, spender) =>
      IERC20__factory.connect(token, provider).allowance(owner, spender),
    hasTokenGasOracle: async (igp, token, domainIds) => {
      const gasPaymaster = InterchainGasPaymaster__factory.connect(
        igp,
        provider,
      );
      const oracles = await Promise.all(
        domainIds.map((domainId) =>
          gasPaymaster.tokenGasOracles(token, domainId),
        ),
      );
      return oracles.some((oracle) => oracle !== constants.AddressZero);
    },
    balance: (address) => provider.getBalance(address),
    fees: async () => {
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice ?? feeData.maxFeePerGas;
      const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
      if (gasPrice === null || maxFeePerGas === null) {
        throw new Error('The provider returned no gas price');
      }
      return { gasPrice, maxFeePerGas };
    },
    estimateDeployGas: (from, data) => provider.estimateGas({ from, data }),
    l1DataFee: async (data) => {
      if (!options.opStack) return undefined;
      try {
        return await new Contract(
          OP_STACK_GAS_PRICE_ORACLE,
          OP_STACK_L1_FEE_ABI,
          provider,
        ).getL1Fee(data);
      } catch (error: unknown) {
        if (isMissingSelectorCallException(error)) return undefined;
        throw error;
      }
    },
  };
}
