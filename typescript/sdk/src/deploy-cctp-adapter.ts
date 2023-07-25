import { ethers } from 'ethers';
import yargs from 'yargs';

import { types, utils } from '@hyperlane-xyz/utils';

import {
  ChainMap, // ChainName,
  Chains,
  MultiProvider,
  chainMetadata,
} from '../src';

import { hyperlaneContractAddresses } from './consts/environments';
import {
  AdapterType,
  CctpAdapterConfig,
  CctpAdapterDeployer,
} from './middleware/liquidity-layer-v2/CctpAdapterDeployer';

const circleDomainMapping = [
  { hyperlaneDomain: chainMetadata[Chains.goerli].chainId, circleDomain: 0 },
  { hyperlaneDomain: chainMetadata[Chains.fuji].chainId, circleDomain: 1 },
];

function buildCctpAdapterConfigMap(owner: types.Address) {
  const config: ChainMap<CctpAdapterConfig> = {};
  config[Chains.goerli] = {
    type: AdapterType.CCTP,
    tokenMessengerAddress: '0xd0c3da58f55358142b8d3e06c1c30c5c6114efe8',
    token: '0x07865c6e87b9f70255377e024ace6630c1eaa37f',
    tokenSymbol: 'USDC',
    gasAmount: 500000,
    circleDomainMapping: circleDomainMapping,
    mailbox: hyperlaneContractAddresses.goerli.mailbox,
    interchainGasPaymaster:
      hyperlaneContractAddresses.goerli.defaultIsmInterchainGasPaymaster,
    interchainSecurityModule: '0x8EE099c620Fe635F86a4b97f3707359495022F37',
    owner: owner,
  };
  config[Chains.fuji] = {
    type: AdapterType.CCTP,
    tokenMessengerAddress: '0xeb08f243e5d3fcff26a9e38ae5520a669f4019d0',
    token: '0x5425890298aed601595a70ab815c96711a31bc65',
    tokenSymbol: 'USDC',
    gasAmount: 500000,
    circleDomainMapping: circleDomainMapping,
    mailbox: hyperlaneContractAddresses.fuji.mailbox,
    interchainGasPaymaster:
      hyperlaneContractAddresses.fuji.defaultIsmInterchainGasPaymaster,
    interchainSecurityModule: '0xE4922FfD478E385a4111a75c5DaA173763a778a1',
    owner: owner,
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

  const config = buildCctpAdapterConfigMap(signer.address);

  const deployer = new CctpAdapterDeployer(multiProvider);
  const cctpAdapters = await deployer.deploy(config);
  console.log('cctpAdapters: ', cctpAdapters);
}

main()
  .then()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
