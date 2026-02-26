import { BigNumber, type ContractReceipt, ethers, providers } from 'ethers';

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
  amount: BigNumber;
  recipient: string;
  senderAddress?: string;
}

export interface WarpTransferResult {
  dispatchTx: ContractReceipt;
  messageId: string;
  origin: string;
  destination: string;
}

export async function executeWarpTransfer(
  multiProvider: MultiProvider,
  params: WarpTransferParams,
  forkedProvider?: providers.JsonRpcProvider,
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
    (multiProvider.getProvider(originChain) as providers.JsonRpcProvider);
  const destinationDomain = multiProvider.getDomainId(destinationChain);

  let sender: string;
  if (senderAddress) {
    sender = senderAddress;
    await provider.send('anvil_impersonateAccount', [sender]);
  } else {
    sender = await multiProvider.getSigner(originChain).getAddress();
  }

  await provider.send('anvil_setBalance', [
    sender,
    ethers.utils.parseEther('100').toHexString(),
  ]);

  const signer = provider.getSigner(sender);

  const token = ERC20__factory.connect(tokenAddress, signer);
  const router = HypERC20Collateral__factory.connect(routerAddress, signer);

  const currentAllowance = await token.allowance(sender, routerAddress);
  if (currentAllowance.lt(amount)) {
    const approveTx = await token.approve(
      routerAddress,
      ethers.constants.MaxUint256,
      { gasLimit: 100000 },
    );
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
): Promise<ContractReceipt> {
  return retryAsync(
    async () => {
      const relayer = new HyperlaneRelayer({ core });
      const receipts = await relayer.relayAll(transferResult.dispatchTx);
      // relayAll keys receipts by domain ID, so look up by domain ID or chain name
      const destinationDomain = core.multiProvider.getDomainId(
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
  relayReceipt: ContractReceipt;
}> {
  const transferResult = await executeWarpTransfer(multiProvider, params);
  const relayReceipt = await relayMessage(multiProvider, core, transferResult);
  return { transferResult, relayReceipt };
}

export async function getRebalancerAddress(
  provider: providers.JsonRpcProvider,
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
  provider: providers.JsonRpcProvider,
  routerAddress: string,
): Promise<{ rebalancerAddress: string; signer: providers.JsonRpcSigner }> {
  const rebalancerAddress = await getRebalancerAddress(provider, routerAddress);
  await impersonateAccounts(provider, [rebalancerAddress]);
  await setBalance(provider, rebalancerAddress, '0x56BC75E2D63100000');
  return {
    rebalancerAddress,
    signer: provider.getSigner(rebalancerAddress),
  };
}

export async function tryRelayMessage(
  multiProvider: MultiProvider,
  core: HyperlaneCore,
  transferResult: WarpTransferResult,
): Promise<{ success: boolean; receipt?: ContractReceipt; error?: string }> {
  try {
    const receipt = await relayMessage(multiProvider, core, transferResult);
    return { success: true, receipt };
  } catch (error) {
    return { success: false, error: String(error) };
  }
}
