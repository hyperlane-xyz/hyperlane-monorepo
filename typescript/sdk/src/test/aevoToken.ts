import { Contract, Signer, providers, utils } from 'ethers';

import {
  Address,
  assert,
  eqAddress,
  formatError,
  isZeroishAddress,
} from '@hyperlane-xyz/utils';

import { EIP1967_IMPLEMENTATION_SLOT } from '../deploy/proxy.js';

import {
  AEVO_ACCOUNTS,
  AEVO_ACCOUNTS_STAND_IN_CODE,
  AEVO_USDC_IMPLEMENTATION,
  AEVO_USDC_PROXY,
  aevoTokenCode,
} from './aevoTokenCode.js';

const AEVO_TOKEN_ABI = [
  'function initialize(address owner, string name, string symbol)',
  'function owner() view returns (address)',
  'function setOwner(address newOwner)',
];

// What the previous owner of the token is funded with, when it holds less, to
// pay for handing the token over.
const PREVIOUS_OWNER_FUNDS = utils.parseEther('2');

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
 * The contract the token deposits to when it mints, at the address it has on
 * the aevo chain, is not the real one: the node gets a stand-in there, which
 * accepts the deposit of a mint and credits nothing, so what the real contract
 * credits is not modelled. It is installed only where that address holds no
 * code, so a fork of the real chain, or a node that holds something there,
 * keeps what it has.
 *
 * It does so with the `hardhat_*` cheat RPCs, which Hardhat and Anvil answer,
 * so it works on those nodes and never on a real chain, on the node `deployer`
 * is connected to. It can run again on a node that keeps its state: the code of
 * the token is etched again, the stand-in is not, an initialized token is not
 * initialized twice, and a token another account owns is taken back for
 * `deployer`, by impersonating that account. That account gets the funds to pay
 * for it only when it holds too little, and has the balance it had afterwards.
 */
export async function deployAevoXERC20Token({
  deployer,
  name = 'USDC',
  symbol = 'USDC',
}: {
  deployer: Signer;
  name?: string;
  symbol?: string;
}): Promise<DeployedAevoXERC20Token> {
  const provider = deployer.provider;
  assert(
    provider instanceof providers.JsonRpcProvider,
    'Expected the deployer to be connected to the JSON-RPC provider of the node that gets the Aevo token',
  );

  for (const address of [AEVO_USDC_IMPLEMENTATION, AEVO_USDC_PROXY]) {
    await provider.send('hardhat_setCode', [address, aevoTokenCode(address)]);
  }
  await provider.send('hardhat_setStorageAt', [
    AEVO_USDC_PROXY,
    EIP1967_IMPLEMENTATION_SLOT,
    utils.hexZeroPad(AEVO_USDC_IMPLEMENTATION, 32),
  ]);
  if ((await provider.getCode(AEVO_ACCOUNTS)) === '0x') {
    await provider.send('hardhat_setCode', [
      AEVO_ACCOUNTS,
      AEVO_ACCOUNTS_STAND_IN_CODE,
    ]);
  }

  const deployerAddress = await deployer.getAddress();
  const token = new Contract(AEVO_USDC_PROXY, AEVO_TOKEN_ABI, deployer);
  const owner: Address = await token.owner();

  if (isZeroishAddress(owner)) {
    await (await token.initialize(deployerAddress, name, symbol)).wait();
  } else if (!eqAddress(owner, deployerAddress)) {
    const balance = await provider.getBalance(owner);
    await provider.send('hardhat_impersonateAccount', [owner]);
    const failures: unknown[] = [];
    try {
      if (balance.lt(PREVIOUS_OWNER_FUNDS)) {
        await provider.send('hardhat_setBalance', [
          owner,
          utils.hexValue(PREVIOUS_OWNER_FUNDS),
        ]);
      }
      await (
        await token.connect(provider.getSigner(owner)).setOwner(deployerAddress)
      ).wait();
    } catch (error: unknown) {
      failures.push(error);
    }
    // Both steps that undo it run whether or not the hand-over worked and
    // whether or not the other failed, and every failure is reported.
    const undone = await Promise.allSettled([
      provider.send('hardhat_setBalance', [owner, utils.hexValue(balance)]),
      provider.send('hardhat_stopImpersonatingAccount', [owner]),
    ]);
    for (const result of undone) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new Error(
        `Failed to take the Aevo token back from ${owner}: ${failures.map((failure) => formatError(failure)).join('; ')}`,
      );
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
