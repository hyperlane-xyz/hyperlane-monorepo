import { EV5GnosisSafeTxBuilder, InterchainAccount } from '@hyperlane-xyz/sdk';
import { assert, objFilter, rootLogger } from '@hyperlane-xyz/utils';

import { ownersByChain as electroneumOwners } from '../../../config/environments/mainnet3/warp/configGetters/getElectroneumUSDCWarpConfig.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../../core-utils.js';

const originChain = 'ethereum';
const destinationChain = 'electroneum';

const accountConfig = {
  origin: originChain,
  owner: electroneumOwners[originChain],
};

// Main function to execute the script
async function main() {
  const environment = 'mainnet3';
  // Get the multiprovider for the environment
  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  const { core, chainAddresses } = await getHyperlaneCore(
    environment,
    multiProvider,
  );
  const icaChainAddresses = objFilter(
    chainAddresses,
    (chain, _): _ is Record<string, string> =>
      !!chainAddresses[chain]?.interchainAccountRouter,
  );
  const ica = InterchainAccount.fromAddressesMap(
    icaChainAddresses,
    multiProvider,
  );

  const call =
    await core.contractsMap[destinationChain].mailbox.populateTransaction[
      'localDomain()'
    ]();

  assert(call.to, 'call.to is undefined');
  assert(call.data, 'call.data is undefined');

  // Get the encoded call to the remote ICA
  const callRemote = await ica.getCallRemote({
    chain: originChain,
    destination: destinationChain,
    innerCalls: [
      {
        to: call.to,
        data: call.data,
      },
    ],
    config: accountConfig,
  });

  callRemote.chainId = multiProvider.getDomainId(originChain);

  // Override 'from' because the config is using the Deployer key, and is not a signer of the Safe
  callRemote.from = accountConfig.owner;

  const safeBuilder = await EV5GnosisSafeTxBuilder.create(multiProvider, {
    version: '1.0',
    chain: originChain,
    safeAddress: accountConfig.owner,
  });

  const safeTx = await safeBuilder.submit(callRemote);

  console.log('SafeTx', safeTx);
}

main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
