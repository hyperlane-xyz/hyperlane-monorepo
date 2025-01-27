import { NetworkProvider } from '@ton/blueprint';
import { Address, toNano } from '@ton/core';
import { ethers } from 'ethers';

import * as deployedContracts from '../deployedContracts.json';
import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';
import { MultisigIsm } from '../wrappers/MultisigIsm';
import { buildValidatorsDict } from '../wrappers/utils/builders';

export async function run(provider: NetworkProvider) {
  //   const sampleWallet = new ethers.Wallet(process.env.ETH_WALLET_PUBKEY!);

  const hook = provider.open(
    MerkleTreeHook.createFromAddress(
      Address.parse(deployedContracts.merkleTreeHookAddress),
    ),
  );

  console.log('hook address:', hook.address);

  const res = await hook.getTree();
  console.log(res.tree.get(0n)?.toString(16));
  console.log(res.tree.get(1n)?.toString(16));
}
