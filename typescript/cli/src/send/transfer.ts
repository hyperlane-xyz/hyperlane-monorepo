import { BigNumber, ethers } from 'ethers';

import {
  ERC20__factory,
  EvmHypCollateralAdapter,
  HypERC20Collateral__factory,
  TokenType,
} from '@hyperlane-xyz/hyperlane-token';
import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProtocolProvider,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, timeout } from '@hyperlane-xyz/utils';

import { log, logBlue, logGreen } from '../../logger.js';
import { readDeploymentArtifacts } from '../config/artifacts.js';
import { MINIMUM_TEST_SEND_BALANCE } from '../consts.js';
import {
  getContextWithSigner,
  getMergedContractAddresses,
} from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { assertNativeBalances, assertTokenBalance } from '../utils/balances.js';

// TODO improve the UX here by making params optional and
// prompting for missing values
export async function sendTestTransfer({
  key,
  chainConfigPath,
  coreArtifactsPath,
  origin,
  destination,
  routerAddress,
  tokenType,
  wei,
  recipient,
  timeoutSec,
  skipWaitForDelivery,
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  routerAddress: Address;
  tokenType: TokenType;
  wei: string;
  recipient?: string;
  timeoutSec: number;
  skipWaitForDelivery: boolean;
}) {
  const { signer, multiProvider } = getContextWithSigner(key, chainConfigPath);
  const artifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  if (tokenType === TokenType.collateral) {
    await assertTokenBalance(
      multiProvider,
      signer,
      origin,
      routerAddress,
      wei.toString(),
    );
  } else if (tokenType === TokenType.native) {
    await assertNativeBalances(multiProvider, signer, [origin], wei.toString());
  } else {
    throw new Error(
      'Only collateral and native token types are currently supported in the CLI. For synthetic transfers, try the Warp UI.',
    );
  }

  await runPreflightChecks({
    origin,
    remotes: [destination],
    multiProvider,
    signer,
    minBalanceWei: MINIMUM_TEST_SEND_BALANCE,
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
      artifacts,
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
  artifacts,
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
  artifacts?: HyperlaneContractsMap<any>;
  skipWaitForDelivery: boolean;
}) {
  const signerAddress = await signer.getAddress();
  recipient ||= signerAddress;

  const mergedContractAddrs = getMergedContractAddresses(artifacts);

  const core = HyperlaneCore.fromAddressesMap(
    mergedContractAddrs,
    multiProvider,
  );

  const provider = multiProvider.getProvider(origin);
  const connectedSigner = signer.connect(provider);

  if (tokenType === TokenType.collateral) {
    const wrappedToken = await getWrappedToken(routerAddress, provider);
    const token = ERC20__factory.connect(wrappedToken, connectedSigner);
    const approval = await token.allowance(signerAddress, routerAddress);
    if (approval.lt(wei)) {
      const approveTx = await token.approve(routerAddress, wei);
      await approveTx.wait();
    }
  }

  // TODO move next section into MultiProtocolTokenApp when it exists
  const adapter = new EvmHypCollateralAdapter(
    origin,
    MultiProtocolProvider.fromMultiProvider(multiProvider),
    { token: routerAddress },
  );
  const destinationDomain = multiProvider.getDomainId(destination);
  const gasPayment = await adapter.quoteGasPayment(destinationDomain);
  const txValue =
    tokenType === TokenType.native
      ? BigNumber.from(gasPayment).add(wei).toString()
      : gasPayment;
  const transferTx = await adapter.populateTransferRemoteTx({
    weiAmountOrId: wei,
    destination: destinationDomain,
    recipient,
    txValue,
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
