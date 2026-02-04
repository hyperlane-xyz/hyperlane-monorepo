import { stringify as yamlStringify } from 'yaml';

import { TokenRouter__factory } from '@hyperlane-xyz/core';
import { GasAction } from '@hyperlane-xyz/provider-sdk';
import {
  type ChainName,
  type DispatchedMessage,
  HyperlaneCore,
  MultiProtocolProvider,
  PredicateApiClient,
  type PredicateAttestation,
  ProviderType,
  type Token,
  TokenAmount,
  WarpCore,
  type WarpCoreConfig,
} from '@hyperlane-xyz/sdk';
import {
  ProtocolType,
  addressToByteHexString,
  addressToBytes32,
  parseWarpRouteMessage,
  timeout,
} from '@hyperlane-xyz/utils';

import { EXPLORER_URL } from '../consts.js';
import { type WriteCommandContext } from '../context/types.js';
import { runPreflightChecksForChains } from '../deploy/utils.js';
import { log, logBlue, logGreen, logRed } from '../logger.js';
import { indentYamlOrJson } from '../utils/files.js';
import { runSelfRelay } from '../utils/relay.js';
import { runTokenSelectionStep } from '../utils/tokens.js';

export const WarpSendLogs = {
  SUCCESS: 'Transfer was self-relayed!',
};

export async function sendTestTransfer({
  context,
  warpCoreConfig,
  chains,
  amount,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
  selfRelay,
  skipValidation,
  predicateApiKey,
  attestation,
}: {
  context: WriteCommandContext;
  warpCoreConfig: WarpCoreConfig;
  chains: ChainName[];
  amount: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
  skipValidation?: boolean;
  predicateApiKey?: string;
  attestation?: string;
}) {
  const { multiProvider } = context;

  // TODO: Add multi-protocol support. WarpCore supports multi-protocol transfers,
  // but CLI transaction handling currently only processes EthersV5 transactions.
  const nonEvmChains = chains.filter(
    (chain) => multiProvider.getProtocol(chain) !== ProtocolType.Ethereum,
  );
  if (nonEvmChains.length > 0) {
    const chainDetails = nonEvmChains
      .map((chain) => `'${chain}' (${multiProvider.getProtocol(chain)})`)
      .join(', ');
    throw new Error(
      `'hyperlane warp send' only supports EVM chains. Non-EVM chains found: ${chainDetails}`,
    );
  }

  await runPreflightChecksForChains({
    context,
    chains,
    minGas: GasAction.TEST_SEND_GAS,
  });

  for (let i = 0; i < chains.length; i++) {
    const origin = chains[i];
    const destination = chains[i + 1];

    if (destination) {
      logBlue(`Sending a message from ${origin} to ${destination}`);
      await timeout(
        executeDelivery({
          context,
          origin,
          destination,
          warpCoreConfig,
          amount,
          recipient,
          skipWaitForDelivery,
          selfRelay,
          skipValidation,
          predicateApiKey,
          attestation,
        }),
        timeoutSec * 1000,
        'Timed out waiting for messages to be delivered',
      );
    }
  }
}

async function executeDelivery({
  context,
  origin,
  destination,
  warpCoreConfig,
  amount,
  recipient,
  skipWaitForDelivery,
  selfRelay,
  skipValidation,
  predicateApiKey,
  attestation,
}: {
  context: WriteCommandContext;
  origin: ChainName;
  destination: ChainName;
  warpCoreConfig: WarpCoreConfig;
  amount: string;
  recipient?: string;
  skipWaitForDelivery: boolean;
  selfRelay?: boolean;
  skipValidation?: boolean;
  predicateApiKey?: string;
  attestation?: string;
}) {
  const { multiProvider, registry } = context;

  const signer = multiProvider.getSigner(origin);
  const recipientSigner = multiProvider.getSigner(destination);

  const recipientAddress = await recipientSigner.getAddress();
  const signerAddress = await signer.getAddress();

  recipient ||= recipientAddress;

  const chainAddresses = await registry.getAddresses();

  const core = HyperlaneCore.fromAddressesMap(chainAddresses, multiProvider);

  const warpCore = WarpCore.FromConfig(
    MultiProtocolProvider.fromMultiProvider(multiProvider),
    warpCoreConfig,
  );

  let token: Token;
  const tokensForRoute = warpCore.getTokensForRoute(origin, destination);
  if (tokensForRoute.length === 0) {
    logRed(`No Warp Routes found from ${origin} to ${destination}`);
    throw new Error('Error finding warp route');
  } else if (tokensForRoute.length === 1) {
    token = tokensForRoute[0];
  } else {
    logBlue(`Please select a token from the Warp config`);
    const routerAddress = await runTokenSelectionStep(tokensForRoute);
    token = warpCore.findToken(origin, routerAddress)!;
  }

  if (!skipValidation) {
    const errors = await warpCore.validateTransfer({
      originTokenAmount: token.amount(amount),
      destination,
      recipient,
      sender: signerAddress,
    });
    if (errors) {
      logRed('Error validating transfer', JSON.stringify(errors));
      throw new Error('Error validating transfer');
    }
  }

  if (predicateApiKey || attestation) {
    if (token.isNative()) {
      throw new Error(
        'Predicate compliance is not supported for native token warp routes. ' +
          'Only ERC20 collateral and synthetic routes support Predicate attestations.',
      );
    }
  }

  let finalAttestation: PredicateAttestation | undefined;

  if (attestation) {
    try {
      finalAttestation = JSON.parse(attestation);
    } catch (e) {
      throw new Error(`Invalid attestation JSON: ${e}`);
    }
  } else if (predicateApiKey) {
    logBlue('Fetching Predicate attestation...');
    const predicateClient = new PredicateApiClient(predicateApiKey);

    const destinationDomain = multiProvider.getDomainId(destination);
    const recipientBytes32 = addressToBytes32(
      addressToByteHexString(recipient),
    );
    const tokenAmount = token.amount(amount);

    const calldata = TokenRouter__factory.createInterface().encodeFunctionData(
      'transferRemote(uint32,bytes32,uint256)',
      [destinationDomain, recipientBytes32, tokenAmount.amount],
    );

    const quote = await warpCore.getInterchainTransferFee({
      originTokenAmount: tokenAmount,
      destination,
      sender: signerAddress,
      recipient,
    });

    const hypAdapter = token.getHypAdapter(
      MultiProtocolProvider.fromMultiProvider(multiProvider),
      origin,
    );
    let predicateTarget = token.addressOrDenom;
    if ('getPredicateWrapperAddress' in hypAdapter) {
      const wrapperAddress = await (
        hypAdapter as {
          getPredicateWrapperAddress: () => Promise<string | null>;
        }
      ).getPredicateWrapperAddress();
      if (wrapperAddress) {
        predicateTarget = wrapperAddress;
        log(`Using PredicateRouterWrapper address: ${wrapperAddress}`);
      }
    }

    const response = await predicateClient.fetchAttestation({
      to: predicateTarget,
      from: signerAddress,
      data: calldata,
      msg_value: quote.igpQuote.amount.toString(),
      chain: origin,
    });

    finalAttestation = response.attestation;
    logGreen('Predicate attestation obtained successfully');
  }

  // TODO: override hook address for self-relay
  const transferTxs = await warpCore.getTransferRemoteTxs({
    originTokenAmount: new TokenAmount(amount, token),
    destination,
    sender: signerAddress,
    recipient,
    attestation: finalAttestation,
  });

  const txReceipts = [];
  for (const tx of transferTxs) {
    if (tx.type === ProviderType.EthersV5) {
      const txResponse = await signer.sendTransaction(tx.transaction);
      const txReceipt = await multiProvider.handleTx(origin, txResponse);
      txReceipts.push(txReceipt);
    }
  }
  const transferTxReceipt = txReceipts[txReceipts.length - 1];
  const messageIndex: number = 0;
  const message: DispatchedMessage =
    HyperlaneCore.getDispatchedMessages(transferTxReceipt)[messageIndex];

  const parsed = parseWarpRouteMessage(message.parsed.body);

  logBlue(
    `Sent transfer from sender (${signerAddress}) on ${origin} to recipient (${recipient}) on ${destination}.`,
  );
  logBlue(`Message ID: ${message.id}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${message.id}`);
  log(`Message:\n${indentYamlOrJson(yamlStringify(message, null, 2), 4)}`);
  log(`Body:\n${indentYamlOrJson(yamlStringify(parsed, null, 2), 4)}`);

  if (selfRelay) {
    return runSelfRelay({
      txReceipt: transferTxReceipt,
      multiProvider: multiProvider,
      registry: registry,
      successMessage: WarpSendLogs.SUCCESS,
    });
  }

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await core.waitForMessageProcessed(transferTxReceipt, 10000, 60);
  logGreen(`Transfer sent to ${destination} chain!`);
}
