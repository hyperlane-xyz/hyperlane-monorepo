import { Contract, Signer, providers, utils } from 'ethers';

import {
  Address,
  assert,
  eqAddress,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { EIP1967_IMPLEMENTATION_SLOT } from '../deploy/proxy.js';

import {
  AEVO_USDC_IMPLEMENTATION,
  AEVO_USDC_PROXY,
  aevoTokenCode,
} from './aevoTokenCode.js';

const AEVO_TOKEN_ABI = [
  'function initialize(address owner, string name, string symbol)',
  'function owner() view returns (address)',
  'function setOwner(address newOwner)',
];

export interface DeployedAevoXERC20Token {
  address: Address;
  implementation: Address;
  owner: Address;
}

/**
 * Puts the recorded Aevo USDC token on a node: the runtime code of its proxy
 * and of its implementation is etched at the addresses it has on the aevo
 * chain, the proxy is pointed at the implementation, and the proxy is
 * initialized with `deployer` as its owner.
 *
 * It does so with the `hardhat_*` cheat RPCs, which Hardhat and Anvil answer,
 * so it works on those nodes and never on a real chain. It can run again on a
 * node that keeps its state: the code is etched again, an initialized token is
 * not initialized twice, and a token another account owns is taken back for
 * `deployer`, by impersonating that account.
 */
export async function deployAevoXERC20Token({
  provider,
  deployer,
  name = 'USDC',
  symbol = 'USDC',
}: {
  provider: providers.JsonRpcProvider;
  deployer: Signer;
  name?: string;
  symbol?: string;
}): Promise<DeployedAevoXERC20Token> {
  for (const address of [AEVO_USDC_IMPLEMENTATION, AEVO_USDC_PROXY]) {
    await provider.send('hardhat_setCode', [address, aevoTokenCode(address)]);
  }
  await provider.send('hardhat_setStorageAt', [
    AEVO_USDC_PROXY,
    EIP1967_IMPLEMENTATION_SLOT,
    utils.hexZeroPad(AEVO_USDC_IMPLEMENTATION, 32),
  ]);

  const deployerAddress = await deployer.getAddress();
  const token = new Contract(AEVO_USDC_PROXY, AEVO_TOKEN_ABI, deployer);
  const owner: Address = await token.owner();

  if (isZeroishAddress(owner)) {
    await (await token.initialize(deployerAddress, name, symbol)).wait();
  } else if (!eqAddress(owner, deployerAddress)) {
    await provider.send('hardhat_impersonateAccount', [owner]);
    try {
      await provider.send('hardhat_setBalance', [
        owner,
        utils.hexValue(utils.parseEther('2')),
      ]);
      await (
        await token.connect(provider.getSigner(owner)).setOwner(deployerAddress)
      ).wait();
    } finally {
      await provider.send('hardhat_stopImpersonatingAccount', [owner]);
    }
  }

  const currentOwner: Address = await token.owner();
  assert(
    eqAddress(currentOwner, deployerAddress),
    `Expected ${deployerAddress} to own the Aevo token at ${AEVO_USDC_PROXY}, found ${currentOwner}`,
  );

  return {
    address: AEVO_USDC_PROXY,
    implementation: AEVO_USDC_IMPLEMENTATION,
    owner: deployerAddress,
  };
}
