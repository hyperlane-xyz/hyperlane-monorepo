import { expect } from 'chai';
import { describe, it } from 'mocha';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { TurnkeyRole, getTurnkeyRolesForProtocol } from '../src/roles.js';

describe('getTurnkeyRolesForProtocol', () => {
  it('returns only Ethereum roles', () => {
    const roles = getTurnkeyRolesForProtocol(ProtocolType.Ethereum);

    expect(roles).to.have.members([
      TurnkeyRole.EvmLegacyDeployer,
      TurnkeyRole.EvmLegacyRebalancer,
      TurnkeyRole.EvmDeployer,
      TurnkeyRole.EvmRebalancer,
      TurnkeyRole.EvmIgpClaimer,
      TurnkeyRole.EvmIgpUpdater,
      TurnkeyRole.EvmWarpFeesOwner,
    ]);
    expect(roles).not.to.include(TurnkeyRole.SealevelDeployer);
  });

  it('returns only Sealevel roles', () => {
    const roles = getTurnkeyRolesForProtocol(ProtocolType.Sealevel);

    expect(roles).to.deep.equal([TurnkeyRole.SealevelDeployer]);
    expect(roles).not.to.include(TurnkeyRole.EvmDeployer);
  });
});
