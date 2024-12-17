import { toNano } from '@ton/core';
import { MerkleHookMock } from '../wrappers/MerkleHookMock';
import { compile, NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const merkleHookMock = provider.open(
        MerkleHookMock.createFromConfig(
            {
                index: 0,
            },
            await compile('MerkleHookMock'),
        ),
    );

    await merkleHookMock.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(merkleHookMock.address);
}
