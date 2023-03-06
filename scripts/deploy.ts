/**
 * Script to deploy warp routes
 * Accepts 3 arguments:
 *   - private-key : Hex string of private key. Note: deployment requires funds on all chains
 *   - token-config : Path to token config JSON file (see example in ./configs)
 *   - chain-config : (Optional) Path to chain config JSON file (see example in ./configs)
 * Example: yarn ts-node scripts/deploy.ts --private-key $PRIVATE_KEY --token-config ./configs/warp-route-token-config.json
 */
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import yargs from 'yargs';

import {
  chainMetadata,
  MultiProvider,
  serializeContracts,
} from '@hyperlane-xyz/sdk';

import { HypERC20Deployer } from '../src/deploy';

async function deployWarpRoute() {
  const argv = await yargs
    .option('private-key', {
      type: 'string',
      describe: 'Private key for signing transactions',
      demandOption: true,
    })
    .option('token-config', {
      type: 'string',
      describe: 'Path to token config JSON file',
      demandOption: true,
    })
    .option('chain-config', {
      type: 'string',
      describe: 'Path to chain config JSON file',
    }).argv;

  const privateKey = argv['private-key'];
  const tokenConfigPath = argv['token-config'];
  const chainConfigPath = argv['chain-config'];

  console.log('Reading warp route configs');

  const tokenConfigs = JSON.parse(
    fs.readFileSync(path.resolve(tokenConfigPath), 'utf-8'),
  );
  const targetChains = Object.keys(tokenConfigs);
  console.log(
    `Found token configs for ${targetChains.length} chains:`,
    targetChains.join(', '),
  );

  const chainConfigs = chainConfigPath
    ? JSON.parse(fs.readFileSync(path.resolve(chainConfigPath), 'utf-8'))
    : null;
  if (chainConfigs) {
    const customChains = Object.keys(chainConfigs);
    console.log(
      `Found custom configs for ${customChains.length} chains:`,
      customChains.join(', '),
    );
  }

  console.log('Preparing wallet');
  const signer = new ethers.Wallet(privateKey);

  console.log('Preparing chain providers');
  const multiProvider = new MultiProvider(
    { ...chainMetadata, ...chainConfigs }
  );
  multiProvider.setSharedSigner(signer)

  console.log('Starting deployments');
  const deployer = new HypERC20Deployer(multiProvider, tokenConfigs, undefined);
  await deployer.deploy();

  console.log('Deployments successful. Deployed contracts:');
  // @ts-ignore
  console.log(serializeContracts(deployer.deployedContracts));
}

deployWarpRoute()
  .then(() => console.log('Warp Route deployment done'))
  .catch((e) => console.error('Warp Route deployment error:', e));
