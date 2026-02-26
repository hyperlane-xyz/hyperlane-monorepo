import {
  JsonRpcProvider,
  JsonRpcSigner,
  MaxUint256,
  TransactionReceipt,
  parseEther,
  toBeHex,
} from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import { HyperlaneRelayer } from '@hyperlane-xyz/relayer';
import {
  HyperlaneCore,
  type MultiProvider,
  impersonateAccounts,
  setBalance,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32, retryAsync } from '@hyperlane-xyz/utils';

export interface WarpTransferParams {
  originChain: string;
  destinationChain: string;
  routerAddress: string;
  tokenAddress: string;
  amount: bigint;
  recipient: string;
  senderAddress?: string;
}

export interface WarpTransferResult {
  dispatchTx: TransactionReceipt;
  messageId: string;
  origin: string;
  destination: string;
}

export async function executeWarpTransfer(
  multiProvider: MultiProvider,
  params: WarpTransferParams,
  forkedProvider?: JsonRpcProvider,
): Promise<WarpTransferResult> {
  const {
    originChain,
    destinationChain,
    routerAddress,
    tokenAddress,
    amount,
    recipient,
    senderAddress,
  } = params;

  const provider =
    forkedProvider ??
    (multiProvider.getProvider(originChain) as JsonRpcProvider);
  const destinationDomain = multiProvider.getDomainId(destinationChain);

  let sender: string;
  if (senderAddress) {
    sender = senderAddress;
    await provider.send('anvil_impersonateAccount', [sender]);
  } else {
    sender = await multiProvider.getSigner(originChain).getAddress();
  }

  await provider.send('anvil_setBalance', [sender, toBeHex(parseEther('100'))]);

  const signer = await provider.getSigner(sender);

  const token = ERC20__factory.connect(tokenAddress, signer);
  const router = HypERC20Collateral__factory.connect(routerAddress, signer);

  const currentAllowance = await token.allowance(sender, routerAddress);
  if (currentAllowance < amount) {
    const approveTx = await token.approve(routerAddress, MaxUint256, {
      gasLimit: 100000,
    });
    await approveTx.wait();
  }

  const recipientBytes32 = addressToBytes32(recipient);

  const gasQuote = await router.quoteGasPayment(destinationDomain);

  const tx = await router.transferRemote(
    destinationDomain,
    recipientBytes32,
    amount,
    { gasLimit: 500000, value: gasQuote },
  );
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error('Transfer transaction not mined');
  }

  if (senderAddress) {
    await provider.send('anvil_stopImpersonatingAccount', [senderAddress]);
  }

  const dispatchedMessages = HyperlaneCore.getDispatchedMessages(receipt);
  if (dispatchedMessages.length === 0) {
    throw new Error('No messages dispatched');
  }

  return {
    dispatchTx: receipt,
    messageId: dispatchedMessages[0].id,
    origin: originChain,
    destination: destinationChain,
  };
}

export async function relayMessage(
  multiProvider: MultiProvider,
  core: HyperlaneCore,
  transferResult: WarpTransferResult,
): Promise<TransactionReceipt> {
  const relayCore =
    core.multiProvider === multiProvider
      ? core
      : HyperlaneCore.fromAddressesMap(
          Object.fromEntries(
            core.chains().map((chain) => [chain, core.getAddresses(chain)]),
          ),
          multiProvider,
        );

  return retryAsync(
    async () => {
      const relayer = new HyperlaneRelayer({ core: relayCore });
      const receipts = await relayer.relayAll(transferResult.dispatchTx);
      // relayAll keys receipts by domain ID, so look up by domain ID or chain name
      const destinationDomain = relayCore.multiProvider.getDomainId(
        transferResult.destination,
      );
      const destinationReceipts =
        receipts[transferResult.destination] ?? receipts[destinationDomain];
      if (!destinationReceipts || destinationReceipts.length === 0) {
        throw new Error('Message relay failed');
      }
      return destinationReceipts[0];
    },
    3,
    1000,
  );
}

export async function executeWarpTransferAndRelay(
  multiProvider: MultiProvider,
  core: HyperlaneCore,
  params: WarpTransferParams,
): Promise<{
  transferResult: WarpTransferResult;
  relayReceipt: TransactionReceipt;
}> {
  const transferResult = await executeWarpTransfer(multiProvider, params);
  const relayReceipt = await relayMessage(multiProvider, core, transferResult);
  return { transferResult, relayReceipt };
}

export async function getRebalancerAddress(
  provider: JsonRpcProvider,
  routerAddress: string,
): Promise<string> {
  const movable = MovableCollateralRouter__factory.connect(
    routerAddress,
    provider,
  );
  const rebalancers = await movable.allowedRebalancers();
  if (rebalancers.length === 0) {
    throw new Error(`No rebalancers found for router ${routerAddress}`);
  }
  return rebalancers[0];
}

export async function impersonateRebalancer(
  provider: JsonRpcProvider,
  routerAddress: string,
): Promise<{ rebalancerAddress: string; signer: JsonRpcSigner }> {
  const rebalancerAddress = await getRebalancerAddress(provider, routerAddress);
  await impersonateAccounts(provider, [rebalancerAddress]);
  await setBalance(provider, rebalancerAddress, '0x56BC75E2D63100000');
  return {
    rebalancerAddress,
    signer: await provider.getSigner(rebalancerAddress),
  };
}

export async function tryRelayMessage(
  multiProvider: MultiProvider,
  core: HyperlaneCore,
  transferResult: WarpTransferResult,
): Promise<{ success: boolean; receipt?: TransactionReceipt; error?: string }> {
  try {
    const receipt = await relayMessage(multiProvider, core, transferResult);
    return { success: true, receipt };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
