import * as ethers from 'ethers';
import { Contract, ContractFactory, Provider, Wallet } from 'zksync-ethers';

import { TestMerkle__factory } from '@hyperlane-xyz/core';

describe('MultiProtocolApp', async () => {
  const provider = new Provider('http://127.0.0.1:8011');

  const deployerWallet = new Wallet(
    '0x3d3cbc973389cb26f657686445bcc75662b415b656078503592ac8c1abb8810e',
    provider,
  );

  const factory = new ContractFactory(
    TestMerkle__factory.abi,
    TestMerkle__factory.bytecode,
    deployerWallet,
    'create2',
  );

  let token = (await factory.deploy({
    customData: { salt: ethers.utils.hexlify(ethers.utils.randomBytes(32)) },
  })) as Contract;

  const tokenAddress = token.address;
  console.log(`Contract address: ${tokenAddress}`);
});
