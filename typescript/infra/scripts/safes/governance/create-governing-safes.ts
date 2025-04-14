import Safe, {
  PredictedSafeProps,
  SafeAccountConfig,
} from '@safe-global/protocol-kit';
import { ethers } from 'ethers';
import {
  SendTransactionReturnType,
  waitForTransactionReceipt,
} from 'viem/actions';
import {
  abstract,
  arbitrum,
  base,
  berachain,
  blast,
  bsc,
  fraxtal,
  linea,
  manta,
  mode,
  optimism,
  sei,
  sophon,
  swellchain,
  taiko,
  treasure,
  unichain,
  zeroNetwork,
  zircuit,
  zkLinkNova,
  zksync,
} from 'viem/chains';

import { ChainName } from '@hyperlane-xyz/sdk';

import { Contexts } from '../../../config/contexts.js';
import {
  DEPLOYER,
  icas,
  safes,
} from '../../../config/environments/mainnet3/owners.js';
import { getChain } from '../../../config/registry.js';
import { Role } from '../../../src/roles.js';
import { getInfraPath, writeJsonAtPath } from '../../../src/utils/utils.js';
import { getKeyForRole } from '../../agent-utils.js';

const GOVERNANCE_SAFES_CONFIG_PATH = `${getInfraPath()}/config/environments/mainnet3/safe`;

const viemChains = [
  abstract,
  arbitrum,
  base,
  berachain,
  blast,
  bsc,
  fraxtal,
  linea,
  manta,
  mode,
  optimism,
  sei,
  sophon,
  swellchain,
  taiko,
  treasure,
  unichain,
  zeroNetwork,
  zircuit,
  zkLinkNova,
  zksync,
];

const safeChainUrls: Record<ChainName, string> = {
  abstract: 'https://abstract-safe.protofire.io/home?safe=abstract',
  arbitrum: 'https://app.safe.global/home?safe=arb1',
  base: 'https://app.safe.global/home?chain=base&safe=base',
  berachain: 'https://safe.berachain.com/home?safe=berachain',
  blast: 'https://app.safe.global/home?safe=blast',
  bsc: 'https://app.safe.global/home?safe=bnb',
  ethereum: 'https://app.safe.global/home?safe=eth',
  fraxtal: 'https://safe.mainnet.frax.com/transactions/queue?safe=fraxtal',
  hyperevm: 'https://wl-hyperliquid-palmera-dao.vercel.app/home?safe=hype',
  linea: 'https://app.safe.global/home?safe=linea',
  mantapacific: 'https://safe.manta.network/transactions/queue?safe=manta',
  mode: 'https://safe.optimism.io/home?safe=mode',
  optimism: 'https://app.safe.global/home?safe=oeth',
  sei: 'https://sei-safe.protofire.io/home?safe=sei',
  sophon: 'https://safe.sophon.xyz/home?safe=sophon',
  swell: 'https://safe.optimism.io/home?safe=swell-l2',
  taiko: 'https://safe.taiko.xyz/home?safe=taiko',
  treasure:
    'https://app.palmeradao.xyz/6751ed2cf70aa4d63124285f/details?safe=treasure%',
  unichain: 'https://app.safe.global/home?safe=unichain',
  zeronetwork:
    'https://safe-whitelabel-git-zero-palmera-dao.vercel.app/settings/setup?safe=ZERϴ',
  zircuit: 'https://safe.zircuit.com/home?safe=zircuit',
  zklink: 'https://safe.zklink.io/home?safe=zklink-nova',
  zksync: 'https://app.safe.global/home?safe=zksync',
};

const getDeployerPrivateKey = async () => {
  const key = getKeyForRole('mainnet3', Contexts.Hyperlane, Role.Deployer);
  await key.fetch();

  return key.privateKey;
};

const predictedSafes: Record<
  ChainName,
  Record<GovernanceSafeType, string>
> = {};

const safeUrlOutputs = {} as Record<
  ChainName,
  Record<GovernanceSafeType, string>
>;

enum GovernanceSafeType {
  Regular = 'regular',
  Irregular = 'irregular',
  Exceptional = 'exceptional',
}

const safeAccountConfig: SafeAccountConfig = {
  owners: [DEPLOYER],
  threshold: 1,
};

const safeOnlyChains = Object.keys(safes).filter((chain) => !(chain in icas));

async function main() {
  const PRIVATE_KEY = await getDeployerPrivateKey();

  for (const chain of safeOnlyChains) {
    safeUrlOutputs[chain] = {} as Record<GovernanceSafeType, string>;

    const chainMetadata = await getChain(chain);
    const rpcUrls = chainMetadata.rpcUrls;

    const addresses = {} as Record<GovernanceSafeType, string>;

    for (const safeType of Object.values(GovernanceSafeType)) {
      const salt = ethers.utils.id(`hyperlane-governance-${safeType}`);

      const predictedSafe: PredictedSafeProps = {
        safeAccountConfig,
        safeDeploymentConfig: {
          saltNonce: salt,
        },
      };

      let protocolKit: Safe.default;

      try {
        protocolKit = await Safe.init({
          provider: rpcUrls[0].http,
          signer: PRIVATE_KEY,
          predictedSafe,
        });
      } catch (error) {
        console.error(`Error initializing Safe for ${chain} ${safeType}`);
        console.error(error);
        continue;
      }

      const predictedSafeAddress = await protocolKit.getAddress();
      console.log(
        `Predicted Safe Address for ${chain} ${safeType}: ${predictedSafeAddress}`,
      );

      let deploymentTx;

      try {
        deploymentTx = await protocolKit.createSafeDeploymentTransaction();
      } catch (error) {
        console.error(
          `Error creating Safe deployment transaction for ${chain} ${safeType}`,
        );
        console.error(error);
        continue;
      }

      const client = await protocolKit.getSafeProvider().getExternalSigner();

      if (!client) {
        console.error(`No client found for ${chain} ${safeType}`);
        continue;
      }

      const chainConfig = Object.values(viemChains).find(
        (chain) => chain.id === Number(chainMetadata.chainId),
      );
      if (!chainConfig) {
        console.error(
          `Chain configuration not found for chain ID ${chainMetadata.chainId}`,
        );
        continue;
      }

      let tx: SendTransactionReturnType;

      try {
        tx = await client.sendTransaction({
          to: deploymentTx.to,
          value: BigInt(deploymentTx.value),
          data: deploymentTx.data as `0x${string}`,
          chain: chainConfig,
        });
      } catch (error) {
        console.error(`Error sending transaction for ${chain} ${safeType}`);
        console.error(error);
        continue;
      }

      const receipt = await waitForTransactionReceipt(client, {
        hash: tx,
      });

      if (receipt.status === 'success') {
        addresses[safeType] = predictedSafeAddress;
        safeUrlOutputs[chain][
          safeType
        ] = `${safeChainUrls[chain]}:${predictedSafeAddress}`;
      } else {
        console.error(`Transaction failed for ${chain} ${safeType}`);
        console.error(receipt);
      }

      predictedSafes[chain] = addresses;
    }
  }

  console.log(JSON.stringify(predictedSafes, null, 2));
  console.log(JSON.stringify(safeUrlOutputs, null, 2));

  const fileName = `governance-safes.json`;

  writeJsonAtPath(
    `${GOVERNANCE_SAFES_CONFIG_PATH}/${fileName}`,
    predictedSafes,
  );
}

main().catch((error) => {
  console.error('Error deploying multi-chain Safes:', error);
  process.exit(1);
});
