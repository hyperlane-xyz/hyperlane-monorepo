import { ethers } from 'ethers';

import {
  ERC20__factory,
  HypERC20App,
  HypERC20Collateral__factory,
} from '@hyperlane-xyz/hyperlane-token';
import {
  ChainName,
  HyperlaneContractsMap,
  HyperlaneCore,
  MultiProvider,
} from '@hyperlane-xyz/sdk';
import { Address, timeout } from '@hyperlane-xyz/utils';

import { readDeploymentArtifacts } from '../configs.js';
import { MINIMUM_TEST_SEND_BALANCE } from '../consts.js';
import { getDeployerContext, getMergedContractAddresses } from '../context.js';
import { runPreflightChecks } from '../deploy/utils.js';
import { logBlue, logGreen } from '../logger.js';
import { assertTokenBalance } from '../utils/balances.js';

// TODO improve the UX here by making params optional and
// prompting for missing values
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
}: {
  key: string;
  chainConfigPath: string;
  coreArtifactsPath: string;
  origin: ChainName;
  destination: ChainName;
  routerAddress: Address;
  wei: string;
  recipient?: string;
  timeoutSec: number;
}) {
  const { signer, multiProvider } = getDeployerContext(key, chainConfigPath);
  const artifacts = coreArtifactsPath
    ? readDeploymentArtifacts(coreArtifactsPath)
    : undefined;

  await assertTokenBalance(
    multiProvider,
    signer,
    origin,
    routerAddress,
    wei.toString(),
  );
  await runPreflightChecks({
    local: origin,
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
      wei,
      recipient,
      signer,
      multiProvider,
      artifacts,
    }),
    timeoutSec * 1000,
    'Timed out waiting for messages to be delivered',
  );
}

async function executeDelivery({
  origin,
  destination,
  routerAddress,
  wei,
  recipient,
  multiProvider,
  signer,
  artifacts,
}: {
  origin: ChainName;
  destination: ChainName;
  routerAddress: Address;
  wei: string;
  recipient?: string;
  multiProvider: MultiProvider;
  signer: ethers.Signer;
  artifacts?: HyperlaneContractsMap<any>;
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
  const wrappedToken = await getWrappedToken(routerAddress, provider);
  if (wrappedToken) {
    const token = ERC20__factory.connect(wrappedToken, connectedSigner);
    const approval = await token.allowance(signerAddress, routerAddress);
    if (approval.lt(wei)) {
      const approveTx = await token.approve(routerAddress, wei);
      await approveTx.wait();
    }
  } else {
    // TODO finish support for other types
    // See code in warp UI for an example
    // Requires gas handling
    throw new Error(
      'Sorry, only HypERC20Collateral transfers are currently supported in the CLI',
    );
  }

  const app = new HypERC20App(
    {
      [origin]: {
        router: HypERC20Collateral__factory.connect(
          routerAddress,
          connectedSigner,
        ),
      },
    },
    multiProvider,
  );

  const receipt = await app.transfer(origin, destination, recipient, wei);
  const message = core.getDispatchedMessages(receipt)[0];
  logBlue(`Sent message from ${origin} to ${recipient} on ${destination}.`);
  logBlue(`Message ID: ${message.id}`);
  await core.waitForMessageProcessed(receipt, 5000);
  logGreen(`Transfer sent to destination chain!`);
}

async function getWrappedToken(
  address: Address,
  provider: ethers.providers.Provider,
): Promise<Address | null> {
  try {
    const contract = HypERC20Collateral__factory.connect(address, provider);
    const wrappedToken = await contract.wrappedToken();
    if (ethers.utils.isAddress(wrappedToken)) return wrappedToken;
    else return null;
  } catch (error) {
    // Token isn't a HypERC20Collateral
    return null;
  }
}
