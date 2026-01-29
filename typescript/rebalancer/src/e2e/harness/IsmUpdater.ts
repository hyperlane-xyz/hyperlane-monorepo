import { ethers, providers } from 'ethers';

import {
  HypERC20Collateral__factory,
  TrustedRelayerIsm__factory,
} from '@hyperlane-xyz/core';
import type { MultiProvider } from '@hyperlane-xyz/sdk';

export async function deployTrustedRelayerIsm(
  provider: providers.JsonRpcProvider,
  mailboxAddress: string,
  relayerAddress: string,
): Promise<string> {
  const signer = provider.getSigner();
  const factory = new TrustedRelayerIsm__factory(signer);
  const ism = await factory.deploy(mailboxAddress, relayerAddress);
  await ism.deployed();
  return ism.address;
}

export async function updateRouterIsm(
  provider: providers.JsonRpcProvider,
  routerAddress: string,
  newIsmAddress: string,
): Promise<void> {
  const signer = provider.getSigner();
  const router = HypERC20Collateral__factory.connect(routerAddress, signer);
  const tx = await router.setInterchainSecurityModule(newIsmAddress);
  await tx.wait();
}

export async function setupTrustedRelayerIsmForRoute(
  multiProvider: MultiProvider,
  chains: readonly string[],
  routersByChain: Record<string, string>,
  mailboxesByChain: Record<string, string>,
  relayerAddress: string,
): Promise<Record<string, string>> {
  const ismAddresses: Record<string, string> = {};

  for (const chain of chains) {
    const provider = multiProvider.getProvider(
      chain,
    ) as providers.JsonRpcProvider;
    const signer = multiProvider.getSigner(chain);

    await provider.send('anvil_setBalance', [
      await signer.getAddress(),
      ethers.utils.parseEther('100').toHexString(),
    ]);

    const mailboxAddress = mailboxesByChain[chain];
    if (!mailboxAddress) {
      throw new Error(`Mailbox address not found for chain ${chain}`);
    }

    const ismAddress = await deployTrustedRelayerIsm(
      provider,
      mailboxAddress,
      relayerAddress,
    );
    ismAddresses[chain] = ismAddress;

    const routerAddress = routersByChain[chain];
    const router = HypERC20Collateral__factory.connect(routerAddress, provider);
    const owner = await router.owner();

    await provider.send('anvil_impersonateAccount', [owner]);
    const ownerSigner = provider.getSigner(owner);
    await provider.send('anvil_setBalance', [
      owner,
      ethers.utils.parseEther('10').toHexString(),
    ]);

    const routerAsOwner = router.connect(ownerSigner);
    const tx = await routerAsOwner.setInterchainSecurityModule(ismAddress);
    await tx.wait();

    await provider.send('anvil_stopImpersonatingAccount', [owner]);
  }

  return ismAddresses;
}
