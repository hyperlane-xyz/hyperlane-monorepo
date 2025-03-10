import { NetworkProvider } from '@ton/blueprint';
import { Address } from '@ton/core';

import { loadDeployedContracts } from '../scripts/utils';
import { MerkleTreeHook } from '../wrappers/MerkleTreeHook';

export async function run(provider: NetworkProvider) {
  const deployedContracts = loadDeployedContracts(
    Number(process.env.ORIGIN_DOMAIN) ?? 777001,
  );
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
