import { confirm } from '@inquirer/prompts';
import { BigNumber, constants } from 'ethers';

import { ERC20__factory, TransferRouter__factory } from '@hyperlane-xyz/core';
import type { WarpCoreConfig } from '@hyperlane-xyz/sdk';
import { ProtocolType, addressToBytes32, assert } from '@hyperlane-xyz/utils';

import { EXPLORER_URL } from '../consts.js';
import { ensureEvmSignersForChains } from '../context/context.js';
import type { WriteCommandContext } from '../context/types.js';
import { logBlue, logGreen, logRed } from '../logger.js';

import type { TransferRouterOutput } from './types.js';

export async function executeTransferRouterTransfer({
  context,
  transferRouterConfig,
  warpCoreConfig,
  origin,
  destination,
  amount,
  recipient,
}: {
  context: WriteCommandContext;
  transferRouterConfig: TransferRouterOutput;
  warpCoreConfig: WarpCoreConfig;
  origin: string;
  destination: string;
  amount: string;
  recipient?: string;
}): Promise<void> {
  const { multiProvider } = context;

  const originProtocol = multiProvider.getProtocol(origin);
  if (originProtocol !== ProtocolType.Ethereum) {
    throw new Error(
      `Origin chain '${origin}' uses protocol '${originProtocol}'. Transfer router only supports EVM chains.`,
    );
  }

  const chainConfig = transferRouterConfig[origin];
  assert(
    chainConfig,
    `No TransferRouter deployment found for chain '${origin}'`,
  );
  const transferRouterAddress = chainConfig.transferRouter;

  const originToken = warpCoreConfig.tokens.find((t) => t.chainName === origin);
  assert(originToken, `No warp route token found for origin chain '${origin}'`);
  const routeAddress = originToken.addressOrDenom;
  assert(routeAddress, `Token on '${origin}' has no addressOrDenom`);

  await ensureEvmSignersForChains(context, [origin]);

  const signer = multiProvider.getSigner(origin);
  const signerAddress = await signer.getAddress();
  const resolvedRecipient = recipient ?? signerAddress;
  const recipientBytes32 = addressToBytes32(resolvedRecipient);
  const destDomain = multiProvider.getDomainId(destination);

  const transferRouter = TransferRouter__factory.connect(
    transferRouterAddress,
    signer,
  );
  const tokenAddress = await transferRouter.token();
  const erc20 = ERC20__factory.connect(tokenAddress, signer);

  const quotes = await transferRouter.quoteTransferRemote(
    destDomain,
    recipientBytes32,
    BigNumber.from(amount),
    routeAddress,
  );

  let nativeGas = BigNumber.from(0);
  let tokenAmount = BigNumber.from(0);

  for (const quote of quotes) {
    if (quote.token === constants.AddressZero) {
      nativeGas = nativeGas.add(quote.amount);
    } else if (quote.token.toLowerCase() === tokenAddress.toLowerCase()) {
      tokenAmount = tokenAmount.add(quote.amount);
    }
  }

  logBlue('Fee breakdown:');
  for (const quote of quotes) {
    logBlue(`  token: ${quote.token}, amount: ${quote.amount.toString()}`);
  }
  logBlue(`Total token approval needed: ${tokenAmount.toString()}`);
  logBlue(`Total native gas: ${nativeGas.toString()}`);

  if (!context.skipConfirmation) {
    const confirmed = await confirm({
      message: `Transfer ${amount} tokens from ${origin} to ${resolvedRecipient} on ${destination}?`,
    });
    if (!confirmed) {
      logRed('Transfer cancelled');
      return;
    }
  }

  if (tokenAmount.gt(0)) {
    logBlue('Approving ERC20 spend...');
    const approveTx = await erc20.approve(transferRouterAddress, tokenAmount);
    await multiProvider.handleTx(origin, approveTx);
    logBlue('ERC20 approval confirmed');
  }

  logBlue('Sending transfer...');
  const tx = await transferRouter.transferRemote(
    destDomain,
    recipientBytes32,
    BigNumber.from(amount),
    routeAddress,
    { value: nativeGas },
  );
  const receipt = await multiProvider.handleTx(origin, tx);

  const iface = TransferRouter__factory.createInterface();
  const transferRoutedTopic = iface.getEventTopic('TransferRouted');
  const eventLog = receipt.logs.find(
    (log) => log.topics[0] === transferRoutedTopic,
  );
  assert(eventLog, 'TransferRouted event not found in receipt');

  const parsed = iface.parseLog(eventLog);
  const messageId: string = parsed.args.messageId;

  logBlue(
    `Transfer sent from ${signerAddress} on ${origin} to ${resolvedRecipient} on ${destination}`,
  );
  logBlue(`Message ID: ${messageId}`);
  logBlue(`Explorer Link: ${EXPLORER_URL}/message/${messageId}`);
  logGreen('Transfer complete!');
}
