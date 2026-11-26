import { ContractFactory, Signer } from 'ethers';

import { IAccessManager, IAccessManager__factory } from '@hyperlane-xyz/core';
import { Address } from '@hyperlane-xyz/utils';

import AccessManagerArtifact from './fixtures/AccessManager.json' with { type: 'json' };

/**
 * Deploys an OpenZeppelin v5 AccessManager from the build artifact fixture, as
 * `@hyperlane-xyz/core` does not ship one.
 */
export async function deployTestAccessManager(
  signer: Signer,
  initialAdmin: Address,
): Promise<IAccessManager> {
  const factory = new ContractFactory(
    AccessManagerArtifact.abi,
    AccessManagerArtifact.bytecode,
    signer,
  );
  const contract = await factory.deploy(initialAdmin);
  await contract.deployed();
  return IAccessManager__factory.connect(contract.address, signer);
}
