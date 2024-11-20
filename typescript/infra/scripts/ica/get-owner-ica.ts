import { AccountConfig, ChainMap, InterchainAccount } from '@hyperlane-xyz/sdk';
import {
  assert,
  eqAddress,
  isZeroishAddress,
  objFilter,
} from '@hyperlane-xyz/utils';

import { getIcaIsm } from '../../config/environments/mainnet3/ica.js';
import { DEPLOYER as mainnet3Deployer } from '../../config/environments/mainnet3/owners.js';
import {
  AbacusWorksIcaManager,
  IcaArtifact,
  IcaDeployResult,
  persistAbacusWorksIcas,
  readAbacusWorksIcas,
} from '../../src/config/icas.js';
import { isEthereumProtocolChain } from '../../src/utils/utils.js';
import {
  getAbacusWorksIcasPath,
  getArgs as getEnvArgs,
  withChains,
} from '../agent-utils.js';
import { getEnvironmentConfig, getHyperlaneCore } from '../core-utils.js';

function getArgs() {
  return withChains(getEnvArgs())
    .option('ownerChain', {
      type: 'string',
      description: 'Origin chain where the governing owner lives',
      demandOption: true,
    })
    .option('owner', {
      type: 'string',
      description:
        "Address of the owner on the ownerChain. Defaults to the environment's configured owner for the ownerChain.",
      demandOption: false,
    })
    .option('deploy', {
      type: 'boolean',
      description: 'Deploys the ICA if it does not exist',
      default: false,
    })
    .alias('chains', 'destinationChains').argv;
}

async function main() {
  const {
    environment,
    ownerChain,
    chains: chainsArg,
    deploy,
    owner: ownerOverride,
  } = await getArgs();

  assert(environment === 'mainnet3', 'Only mainnet3 is supported');

  const config = getEnvironmentConfig(environment);
  const multiProvider = await config.getMultiProvider();

  // Read the existing ICA artifacts
  let artifacts: ChainMap<IcaArtifact>;
  try {
    artifacts = await readAbacusWorksIcas(environment);
  } catch (err) {
    console.error('Error reading artifacts, defaulting to no artifacts:', err);
    artifacts = {};
  }

  // Determine the owner address
  const originOwner = ownerOverride ?? config.owners[ownerChain]?.owner;
  if (!originOwner) {
    throw new Error(`No owner found for ${ownerChain}`);
  }

  // Protect against accidentally using an ICA as the owner
  if (
    artifacts[ownerChain]?.ica &&
    eqAddress(originOwner, artifacts[ownerChain].ica)
  ) {
    throw new Error(`Origin owner ${originOwner} must not be an ICA!`);
  }

  // Log the owner address
  console.log(`Governance owner on ${ownerChain}: ${originOwner}`);

  // Get the chain addresses
  const { chainAddresses } = await getHyperlaneCore(environment, multiProvider);
  // Filter out non-EVM chains
  const ethereumChainAddresses = objFilter(
    chainAddresses,
    (chain, _addresses): _addresses is Record<string, string> => {
      return isEthereumProtocolChain(chain);
    },
  );
  const ica = InterchainAccount.fromAddressesMap(
    ethereumChainAddresses,
    multiProvider,
  );

  // Check that the interchain account router address is not zero
  const ownerChainInterchainAccountRouter =
    ica.contractsMap[ownerChain].interchainAccountRouter.address;
  if (isZeroishAddress(ownerChainInterchainAccountRouter)) {
    console.error(`Interchain account router address is zero`);
    process.exit(1);
  }

  // Create the owner config
  const ownerConfig: AccountConfig = {
    origin: ownerChain,
    owner: originOwner,
    routerOverride: ownerChainInterchainAccountRouter,
  };

  // Determine the chains to process
  let chains: string[];
  if (chainsArg) {
    chains = chainsArg;
  } else {
    chains = ica.chains().filter((chain) => chain !== ownerChain);
    console.log(
      'Chains not supplied, using all ICA supported chains other than the owner chain:',
      chains,
    );
  }

  // Initialize ICA manager
  const abacusWorksIca = new AbacusWorksIcaManager(
    multiProvider,
    ica,
    chainAddresses,
    mainnet3Deployer,
    getIcaIsm,
  );

  // Verify or deploy each chain's ICA
  const settledResults = await Promise.allSettled(
    chains.map(async (chain) => {
      return abacusWorksIca.verifyOrDeployChainIca(chain, {
        chainArtifact: artifacts[chain],
        deploy,
        ownerConfig,
      });
    }),
  );

  // User-friendly output for the console.table
  const results: Record<string, Omit<IcaDeployResult, 'chain'>> = {};
  // Map of chain to ICA artifact
  const icaArtifacts: ChainMap<IcaArtifact> = {};
  settledResults.forEach((settledResult) => {
    if (settledResult.status === 'fulfilled') {
      const { chain, result, error, deployed, recovered } = settledResult.value;
      if (error || !result) {
        console.error(`Failed to process ${chain}:`, error);
      } else {
        results[chain] = {
          deployed,
          recovered,
          ...result,
        };
        icaArtifacts[chain] = result;
      }
    } else {
      console.error(`Promise rejected:`, settledResult.reason);
    }
  });

  console.table(results);

  console.log(
    `Writing results to local artifacts: ${getAbacusWorksIcasPath(
      environment,
    )}`,
  );
  persistAbacusWorksIcas(environment, icaArtifacts);
}

main()
  .then()
  .catch((err) => {
    console.error('Error:', err);
    process.exit(1);
  });
