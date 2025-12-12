import yargs from 'yargs';

import { InterchainAccount } from '@hyperlane-xyz/sdk';
import { assert, objFilter, rootLogger } from '@hyperlane-xyz/utils';

import { awSafes } from '../../../config/environments/mainnet3/governance/safe/aw.js';
import { regularSafes } from '../../../config/environments/mainnet3/governance/safe/regular.js';
import { supportedChainNames } from '../../../config/environments/mainnet3/supportedChainNames.js';
import { legacyIcaChainRouters } from '../../../src/config/chain.js';
import { SafeMultiSend } from '../../../src/govern/multisend.js';
import { withGovernanceType } from '../../../src/governance.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../../core-utils.js';

const originChain = 'ethereum';
const accountConfig = {
  origin: originChain,
  owner: awSafes[originChain],
};

// Main function to execute the script
async function main() {
  const { governanceType } = await withGovernanceType(
    yargs(process.argv.slice(2)),
  ).argv;

  if (governanceType === 'regular') {
    accountConfig.owner = regularSafes[originChain];
  }

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

  const remoteCalls = [];

  for (const chain of supportedChainNames) {
    if (
      chain === 'arcadia' ||
      chain === originChain ||
      !icaChainAddresses[chain] ||
      legacyIcaChainRouters[chain]
    ) {
      continue;
    }

    const call =
      await core.contractsMap[chain].mailbox.populateTransaction[
        'localDomain()'
      ]();

    assert(call.to, 'call.to is undefined');
    assert(call.data, 'call.data is undefined');

    // Get the encoded call to the remote ICA
    remoteCalls.push(
      await ica.getCallRemote({
        chain: 'ethereum',
        destination: chain,
        innerCalls: [
          {
            to: call.to,
            data: call.data,
          },
        ],
        config: accountConfig,
      }),
    );
  }

  const safeMultiSend = await SafeMultiSend.initialize(
    multiProvider,
    originChain,
    accountConfig.owner,
  );

  await safeMultiSend.sendTransactions(
    remoteCalls.map((call) => ({
      to: call.to!,
      data: call.data!,
    })),
  );
}

// Execute the main function and handle promise
main().catch((error) => {
  rootLogger.error('An error occurred:', error);
  process.exit(1);
});
