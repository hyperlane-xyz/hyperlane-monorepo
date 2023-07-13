import { ethers } from 'ethers';
import yargs from 'yargs';

import { types, utils } from '@hyperlane-xyz/utils';

import {
  ChainMap, // ChainName,
  Chains,
  MultiProvider,
  chainMetadata,
} from '../src';

import {
  CctpIsmConfig,
  HyperlaneCctpIsmDeployer,
} from './ism/HyperlaneCctpIsmDeployer';

function buildCctpIsmConfigMap() {
  const config: ChainMap<CctpIsmConfig> = {};
  config[Chains.goerli] = {
    messageTransmitter: '0x26413e8157cd32011e726065a5462e97dd4d03d9',
  };
  config[Chains.fuji] = {
    messageTransmitter: '0xa9fb1b3009dcb79e2fe346c16a604b8fa8ae0a79',
  };
  return config;
}

export async function getArgs() {
  const args = await yargs(process.argv.slice(2))
    .describe('key', 'A hexadecimal private key for transaction signing')
    .string('key')
    .coerce('key', assertBytes32)
    .demandOption('key');
  return args.argv;
}

export function assertBytesN(value: string, length: number): string {
  const valueWithPrefix = utils.ensure0x(value);
  if (
    ethers.utils.isHexString(valueWithPrefix) &&
    ethers.utils.hexDataLength(valueWithPrefix) == length
  ) {
    return valueWithPrefix;
  }
  throw new Error(
    `Invalid value ${value}, must be a ${length} byte hex string`,
  );
}

export function assertBytes32(value: string): string {
  return assertBytesN(value, 32);
}

let multiProvider: MultiProvider;

export function getMultiProvider() {
  if (!multiProvider) {
    const chainConfigs = { ...chainMetadata };
    multiProvider = new MultiProvider(chainConfigs);
  }
  return multiProvider;
}

async function main() {
  const multiProvider = getMultiProvider();
  const { key } = await getArgs();
  const signer = new ethers.Wallet(key);
  multiProvider.setSharedSigner(signer);

  const config = buildCctpIsmConfigMap();

  const deployer = new HyperlaneCctpIsmDeployer(multiProvider);
  const cctpIsms = await deployer.deploy(config);
  console.log('cctpIsms: ', cctpIsms);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
