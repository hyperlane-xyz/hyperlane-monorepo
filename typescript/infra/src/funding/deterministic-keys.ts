import { Wallet, utils } from 'ethers';

import { Contexts } from '../../config/contexts.js';
import { AgentGCPKey } from '../agents/gcp.js';
import { DeployEnvironment } from '../config/environment.js';
import { Role } from '../roles.js';

// Keys that are derived from the deployer key, mainly to have deterministic addresses on every chain
// The order here matters so don't mix it up
export enum DeterministicKeyRoles {
  InterchainAccount,
  TestRecipient,
  Create2Factory,
}

const DeterministicKeyRoleNonces = {
  [DeterministicKeyRoles.InterchainAccount]: 0,
  [DeterministicKeyRoles.TestRecipient]: 0,
  [DeterministicKeyRoles.Create2Factory]: 0,
};

export const getDeterministicKey = async (
  environment: DeployEnvironment,
  deterministicKeyRole: DeterministicKeyRoles,
) => {
  const deployerKey = new AgentGCPKey(
    environment,
    Contexts.Hyperlane,
    Role.Deployer,
  );
  await deployerKey.fetch();
  const seed = utils.HDNode.fromSeed(deployerKey.privateKey);
  const derivedKey = seed.derivePath(
    `m/44'/60'/0'/${deterministicKeyRole}/${DeterministicKeyRoleNonces[deterministicKeyRole]}`,
  );
  return new Wallet(derivedKey.privateKey);
};
