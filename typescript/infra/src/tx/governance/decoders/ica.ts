import { BigNumber, ethers } from 'ethers';

import {
  ChainName,
  InterchainAccount,
  interchainAccountFactories,
} from '@hyperlane-xyz/sdk';
import {
  StandardHookMetadataParams,
  addressToBytes32,
  bytes32ToAddress,
  eqAddress,
  isZeroishAddress,
  parseStandardHookMetadata,
  rootLogger,
} from '@hyperlane-xyz/utils';

import { icaOwnerChain } from '../../../../config/environments/mainnet3/owners.js';
import type { GovernanceDecoder } from '../types.js';
import {
  formatFunctionFragmentArgs,
  getOwnerInsight,
  isRecoverableNestedDecodeError,
  summarizeError,
} from '../utils.js';
import type { GovernTransaction, GovernanceDecoderState } from '../types.js';

interface HookMetadataInsight extends StandardHookMetadataParams {
  raw: string;
  insight: string;
}

interface IcaRemoteCallInsight {
  destination: {
    domain: number;
    chain: ChainName;
  };
  router: {
    address: string;
    insight: string;
  };
  ism: {
    address: string;
    insight: string;
  };
  destinationIca: {
    address: string;
    insight: string;
  };
  hookMetadata?: HookMetadataInsight;
  calls: GovernTransaction[];
}

type IcaCall = readonly [string, BigNumber | string | number, string];

const logger = rootLogger.child({
  module: 'governance-ica-decoder',
});

const icaInterfaceWithHookMetadata = new ethers.utils.Interface([
  'function callRemoteWithOverrides(uint32 _destination, bytes32 _router, bytes32 _ism, tuple(bytes32,uint256,bytes)[] _calls, bytes _hookMetadata) payable returns (bytes32)',
]);

const CALL_REMOTE_WITH_HOOK_METADATA_SELECTOR =
  icaInterfaceWithHookMetadata.getSighash('callRemoteWithOverrides');

export function createIcaDecoder(): GovernanceDecoder {
  return {
    id: 'ica',
    priority: 30,
    match: ({ state, chain, tx }) =>
      isIcaTransaction(state, chain, tx) ? true : undefined,
    decode: async ({ runtime, state, chain, tx }) => {
      if (!tx.data) {
        throw new Error('No data in ICA transaction');
      }
      const { symbol } = await state.multiProvider.getNativeToken(chain);
      const icaInterface =
        interchainAccountFactories.interchainAccountRouter.interface;

      const hasHookMetadata = tx.data.startsWith(
        CALL_REMOTE_WITH_HOOK_METADATA_SELECTOR,
      );
      const parseInterface = hasHookMetadata
        ? icaInterfaceWithHookMetadata
        : icaInterface;
      const decoded = parseInterface.parseTransaction({
        data: tx.data,
        value: tx.value,
      });

      const args = formatFunctionFragmentArgs(
        decoded.args,
        decoded.functionFragment,
      );
      let prettyArgs: unknown = args;

      if (
        decoded.functionFragment.name ===
        icaInterface.functions['enrollRemoteRouter(uint32,bytes32)'].name
      ) {
        prettyArgs = await formatRouterEnrollments(
          state,
          chain,
          'interchainAccountRouter',
          args,
        );
      } else if (
        decoded.functionFragment.name ===
        icaInterface.functions['enrollRemoteRouters(uint32[],bytes32[])'].name
      ) {
        prettyArgs = await formatRouterEnrollments(
          state,
          chain,
          'interchainAccountRouter',
          args,
        );
      } else if (decoded.functionFragment.name === 'callRemoteWithOverrides') {
        prettyArgs = await readIcaRemoteCall(state, runtime.read, chain, args);
      } else if (decoded.signature === 'transferOwnership(address)') {
        const ownableTx = await runtime.readOwnableTransaction(chain, tx);
        return {
          ...ownableTx,
          to: `ICA Router (${chain} ${state.chainAddresses[chain].interchainAccountRouter})`,
          signature: decoded.signature,
        };
      }

      const isLegacy = isLegacyEthIcaRouter(state, tx);
      const routerAddress = isLegacy
        ? state.chainAddresses.ethereum.legacyInterchainAccountRouter
        : state.chainAddresses[chain].interchainAccountRouter;

      return {
        to: `ICA Router${isLegacy ? ' (Legacy)' : ''} (${chain} ${routerAddress})`,
        value: `${ethers.utils.formatEther(decoded.value)} ${symbol}`,
        signature: decoded.signature,
        args: prettyArgs,
        chain,
      };
    },
  };
}

function isIcaTransaction(
  state: GovernanceDecoderState,
  chain: ChainName,
  tx: Parameters<GovernanceDecoder['decode']>[0]['tx'],
): boolean {
  if (tx.to === undefined) return false;

  const isCurrentRouter = eqAddress(
    tx.to,
    state.chainAddresses[chain].interchainAccountRouter,
  );
  const isLegacyEthRouter = eqAddress(
    tx.to,
    state.chainAddresses.ethereum.legacyInterchainAccountRouter,
  );

  return isCurrentRouter || isLegacyEthRouter;
}

function isLegacyEthIcaRouter(
  state: GovernanceDecoderState,
  tx: Parameters<GovernanceDecoder['decode']>[0]['tx'],
): boolean {
  return (
    tx.to !== undefined &&
    eqAddress(
      tx.to,
      state.chainAddresses.ethereum.legacyInterchainAccountRouter,
    )
  );
}

async function formatRouterEnrollments(
  state: GovernanceDecoderState,
  chain: ChainName,
  routerName: string,
  args: Record<string, unknown>,
): Promise<
  Array<{
    domain: number;
    chainName: ChainName;
    router: string;
    insight: string;
  }>
> {
  const domains = args._domains as number[];
  const addresses = args._addresses as string[];
  return domains.map((domain, index) => {
    const remoteChainName = state.multiProvider.getChainName(domain);
    const expectedRouter = state.chainAddresses[remoteChainName][routerName];
    const routerToBeEnrolled = addresses[index];
    const isAddressMatch = eqAddress(
      expectedRouter,
      bytes32ToAddress(routerToBeEnrolled),
    );
    const expectedPaddedRouter = addressToBytes32(
      bytes32ToAddress(routerToBeEnrolled),
    );
    const isPaddingCorrect = eqAddress(
      expectedPaddedRouter,
      routerToBeEnrolled,
    );

    let insight = '✅ matches expected router from artifacts';
    if (!isAddressMatch || !isPaddingCorrect) {
      if (!isAddressMatch) {
        insight = `❌ fatal mismatch, expected ${expectedRouter}`;
        state.diagnostics.addFatal({
          chain,
          remoteDomain: domain,
          remoteChain: remoteChainName,
          router: routerToBeEnrolled,
          expected: expectedRouter,
          info: 'Incorrect router address getting enrolled',
        });
      }

      if (!isPaddingCorrect) {
        insight = `❌ fatal mismatch, expected ${expectedPaddedRouter}`;
        state.diagnostics.addFatal({
          chain,
          remoteDomain: domain,
          remoteChain: remoteChainName,
          router: routerToBeEnrolled,
          expected: expectedPaddedRouter,
          info: 'Router address is not properly padded to 32 bytes (should be 12 leading zero bytes)',
        });
      }
    }

    return {
      domain,
      chainName: remoteChainName,
      router: routerToBeEnrolled,
      insight,
    };
  });
}

async function readIcaRemoteCall(
  state: GovernanceDecoderState,
  read: GovernanceDecoder['decode'] extends (
    context: infer TContext,
  ) => Promise<unknown>
    ? TContext extends { runtime: { read: infer TRead } }
      ? TRead
      : never
    : never,
  chain: ChainName,
  args: Record<string, unknown>,
): Promise<IcaRemoteCallInsight> {
  const {
    _destination: destination,
    _router: router,
    _ism: ism,
    _calls: calls,
    _hookMetadata: hookMetadataRaw,
  } = args as {
    _destination: number;
    _router: string;
    _ism: string;
    _calls: IcaCall[];
    _hookMetadata?: string;
  };
  const remoteChainName = state.multiProvider.getChainName(destination);

  const expectedRouter =
    state.chainAddresses[remoteChainName].interchainAccountRouter;
  const matchesExpectedRouter =
    eqAddress(expectedRouter, bytes32ToAddress(router)) &&
    addressToBytes32(bytes32ToAddress(router)) === router;
  let routerInsight = '✅ matches expected router from artifacts';
  if (!matchesExpectedRouter) {
    state.diagnostics.addFatal({
      chain,
      remoteDomain: destination,
      remoteChain: remoteChainName,
      router,
      expected: expectedRouter,
      info: 'Incorrect router in ICA call',
    });
    routerInsight = `❌ fatal mismatch, expected ${expectedRouter}`;
  }

  let ismInsight = '✅ matches expected ISM';
  if (ism !== ethers.constants.HashZero) {
    state.diagnostics.addFatal({
      chain,
      remoteDomain: destination,
      remoteChain: remoteChainName,
      ism,
      info: 'Incorrect ISM in ICA call, expected zero hash',
    });
    ismInsight = `❌ fatal mismatch, expected zero hash`;
  }

  const expectedRemoteIcaAddress = state.icas[remoteChainName];
  const expectedLegacyRemoteIcaAddress = state.legacyIcas[remoteChainName];
  let remoteIcaAddress: string | undefined;
  let remoteIcaInsight = '✅ matches expected ICA';

  try {
    remoteIcaAddress = await InterchainAccount.fromAddressesMap(
      state.chainAddresses,
      state.multiProvider,
    ).getAccount(remoteChainName, {
      owner: state.safes[icaOwnerChain],
      origin: icaOwnerChain,
      routerOverride: router,
      ismOverride: ism,
    });

    if (!expectedRemoteIcaAddress && !expectedLegacyRemoteIcaAddress) {
      remoteIcaInsight = `⚠️ no expected ICA configured for ${remoteChainName}, derived: ${remoteIcaAddress}`;
    } else {
      const isValidIca =
        expectedRemoteIcaAddress &&
        eqAddress(remoteIcaAddress, expectedRemoteIcaAddress);
      const isValidLegacyIca =
        expectedLegacyRemoteIcaAddress &&
        eqAddress(remoteIcaAddress, expectedLegacyRemoteIcaAddress);

      if (!isValidIca && !isValidLegacyIca) {
        const displayExpected =
          expectedRemoteIcaAddress ??
          expectedLegacyRemoteIcaAddress ??
          '<none>';
        state.diagnostics.addFatal({
          chain,
          remoteDomain: destination,
          remoteChain: remoteChainName,
          ica: remoteIcaAddress,
          expected: displayExpected,
          info: 'Incorrect destination ICA in ICA call',
        });
        remoteIcaInsight = `❌ fatal mismatch, expected ${displayExpected}`;
      }
    }
  } catch (error: unknown) {
    const summary = summarizeError(error);
    logger.warn(
      `Failed to derive ICA address for ${remoteChainName}, using expected address: ${summary}`,
    );
    state.diagnostics.addWarning({
      chain,
      remoteDomain: destination,
      remoteChain: remoteChainName,
      info: 'Could not verify destination ICA address',
      error: summary,
    });
    remoteIcaAddress =
      expectedRemoteIcaAddress ?? expectedLegacyRemoteIcaAddress;
    remoteIcaInsight = `⚠️ could not verify ICA on ${remoteChainName} (${summary})`;
  }

  const decodedCalls = await Promise.all(
    calls.map(async (call) => {
      const icaCallAsTx = {
        to: bytes32ToAddress(call[0]),
        value: BigNumber.from(call[1]),
        data: call[2],
      };
      try {
        return await read(remoteChainName, icaCallAsTx);
      } catch (error: unknown) {
        if (!isRecoverableNestedDecodeError(error)) {
          throw error;
        }
        const summary = summarizeError(error);
        logger.warn(
          `Failed to decode ICA call to ${icaCallAsTx.to} on ${remoteChainName}: ${summary}`,
        );
        state.diagnostics.addWarning({
          chain,
          remoteDomain: destination,
          remoteChain: remoteChainName,
          to: icaCallAsTx.to,
          info: 'Could not decode nested ICA call',
          error: summary,
        });
        return {
          chain: remoteChainName,
          insight: `⚠️ failed to decode (${summary})`,
          to: icaCallAsTx.to,
          data: call[2],
        };
      }
    }),
  );

  const hookMetadataInsight = hookMetadataRaw
    ? await parseHookMetadataWithInsight(chain, hookMetadataRaw)
    : undefined;

  return {
    destination: {
      domain: destination,
      chain: remoteChainName,
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
      address: remoteIcaAddress ?? 'unknown',
      insight: remoteIcaInsight,
    },
    ...(hookMetadataInsight && { hookMetadata: hookMetadataInsight }),
    calls: decodedCalls,
  };
}

async function parseHookMetadataWithInsight(
  chain: ChainName,
  metadata: string,
): Promise<HookMetadataInsight> {
  const parsed = parseStandardHookMetadata(metadata);
  if (!parsed) {
    return {
      raw: metadata,
      insight: '❌ failed to parse hookMetadata',
    };
  }

  const { msgValue, gasLimit, refundAddress } = parsed;

  let insight: string;
  if (isZeroishAddress(refundAddress)) {
    insight = '⚠️ refund to zero address (excess goes to msg.sender)';
  } else {
    const ownerInsight = await getOwnerInsight(chain, refundAddress);
    insight = `✅ refund to ${ownerInsight}`;
  }

  return {
    raw: metadata,
    msgValue,
    gasLimit,
    refundAddress,
    insight,
  };
}
