import { NetworkProvider, compile } from '@ton/blueprint';
import { toNano } from '@ton/core';

import { ProtocolFeeHook } from '../wrappers/ProtocolFeeHook';

export async function run(provider: NetworkProvider) {
  const protocolFeeHook = provider.open(
    ProtocolFeeHook.createFromConfig(
      {
        protocolFee: 10000n,
        maxProtocolFee: 10000000000n,
        beneficiary: provider.sender().address!,
        owner: provider.sender().address!,
      },
      await compile('ProtocolFeeHook'),
    ),
  );

  await protocolFeeHook.sendDeploy(provider.sender(), toNano('0.05'));

  await provider.waitForDeploy(protocolFeeHook.address);
}
