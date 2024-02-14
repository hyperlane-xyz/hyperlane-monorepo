import { input } from '@inquirer/prompts';
import { ethers } from 'ethers';

import {
  ERC20__factory,
  HypERC20Collateral__factory,
  HypERC20__factory,
} from '@hyperlane-xyz/core';
import {
  ChainName,
  EvmHypCollateralAdapter,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProtocolProvider,
  MultiProvider,
  Token,
  TokenAmount,
  TokenType,
} from '@hyperlane-xyz/sdk';
import { Address, timeout } from '@hyperlane-xyz/utils';

import { log, logBlue, logGreen } from '../../logger.js';
import { MINIMUM_TEST_SEND_GAS } from '../consts.js';
import { getContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { assertNativeBalances, assertTokenBalance } from '../utils/balances.js';
import { runSingleChainSelectionStep } from '../utils/chains.js';

export async function sendTestTransfer({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  routerAddress,
  wei,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath?: string;
  origin?: ChainName;
  destination?: ChainName;
  routerAddress?: Address;
  wei: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider, customChains, coreArtifacts } =
    await getContext({
      chainConfigPath,
      coreConfig: { coreArtifactsPath },
      keyConfig: { key },
    });

  if (!origin) {
    origin = await runSingleChainSelectionStep(
      customChains,
      'Select the origin chain',
    );
  }

  if (!destination) {
    destination = await runSingleChainSelectionStep(
      customChains,
      'Select the destination chain',
    );
  }

  if (!routerAddress) {
    routerAddress = await input({
      message: 'Please specify the router address',
    });
  }

  // TODO: move to SDK token router app
  // deduce TokenType
  // 1. decimals() call implies synthetic
  // 2. wrappedToken() call implies collateral
  // 3. if neither, it's native
  let tokenAddress: Address | undefined;
  let tokenType: TokenType;
  const provider = multiProvider.getProvider(origin);
  try {
    const synthRouter = HypERC20__factory.connect(routerAddress, provider);
    await synthRouter.decimals();
    tokenType = TokenType.synthetic;
    tokenAddress = routerAddress;
  } catch (error) {
    try {
      const collateralRouter = HypERC20Collateral__factory.connect(
        routerAddress,
        provider,
      );
      tokenAddress = await collateralRouter.wrappedToken();
      tokenType = TokenType.collateral;
    } catch (error) {
      tokenType = TokenType.native;
    }
  }

  if (tokenAddress) {
    // checks token balances for collateral and synthetic
    await assertTokenBalance(
      multiProvider,
      signer,
      origin,
      tokenAddress,
      wei.toString(),
    );
  } else {
    await assertNativeBalances(multiProvider, signer, [origin], wei.toString());
  }

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minGas: MINIMUM_TEST_SEND_GAS,
    chainsToGasCheck: [origin],
  });

  await timeout(
    executeDelivery({
      origin,
      destination,
      routerAddress,
      tokenType,
      wei,
      recipient,
      signer,
      multiProvider,
      coreArtifacts,
      skipWaitForDelivery,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  routerAddress,
  tokenType,
  wei,
  recipient,
  multiProvider,
  signer,
  coreArtifacts,
  skipWaitForDelivery,
}: {
  origin: ChainName;
  destination: ChainName;
  routerAddress: Address;
  tokenType: TokenType;
  wei: string;
  recipient?: string;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  coreArtifacts?: HyperlaneContractsMap<any>;
  skipWaitForDelivery: boolean;
}) {
  const signerAddress = await signer.getAddress();
  recipient ||= signerAddress;

  const mergedContractAddrs = getMergedContractAddresses(coreArtifacts);

  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );

  const provider = multiProvider.getProvider(origin);
  const connectedSigner = signer.connect(provider);

  // TODO replace all code below with WarpCore
  // https://github.com/hyperlane-xyz/hyperlane-monorepo/issues/3259

  if (tokenType === TokenType.collateral) {
    const wrappedToken = await getWrappedToken(routerAddress, provider);
    const token = ERC20__factory.connect(wrappedToken, connectedSigner);
    const approval = await token.allowance(signerAddress, routerAddress);
    if (approval.lt(wei)) {
      const approveTx = await token.approve(routerAddress, wei);
      await approveTx.wait();
    }
  }

  const adapter = new EvmHypCollateralAdapter(
    origin,
    MultiProtocolProvider.fromMultiProvider(multiProvider),
    { token: routerAddress },
  );
  const destinationDomain = multiProvider.getDomainId(destination);
  const gasAmount = await adapter.quoteGasPayment(destinationDomain);
  const gasToken = Token.FromChainMetadataNativeToken(
    multiProvider.getChainMetadata(origin),
  );
  const transferTx = await adapter.populateTransferRemoteTx({
    weiAmountOrId: wei,
    destination: destinationDomain,
    recipient,
    interchainGas: new TokenAmount(gasAmount, gasToken),
  });

  const txResponse = await connectedSigner.sendTransaction(transferTx);
  const txReceipt = await multiProvider.handleTx(origin, txResponse);

  const message = core.getDispatchedMessages(txReceipt)[0];
  logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
  logBlue(`Message ID: ${message.id}`);

  if (skipWaitForDelivery) return;

  // Max wait 10 minutes
  await core.waitForMessageProcessed(txReceipt, 10000, 60);
  logGreen(`Transfer sent to destination chain!`);
}

async function getWrappedToken(
  address: Address,
  provider: ethers.providers.Provider,
): Promise<Address> {
  try {
    const contract = HypERC20Collateral__factory.connect(address, provider);
    const wrappedToken = await contract.wrappedToken();
    if (ethers.utils.isAddress(wrappedToken)) return wrappedToken;
    else throw new Error('Invalid wrapped token address');
  } catch (error) {
    log('Error getting wrapped token', error);
    throw new Error(
      `Could not get wrapped token from router address ${address}`,
    );
  }
}
