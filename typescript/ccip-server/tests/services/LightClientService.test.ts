import { ethers } from 'ethers';
import * as sinon from 'sinon';

import {
  LightClientService,
  ProofStatus,
} from '../../src/services/LightClientService';

describe('LightClientService', () => {
  let lightclientService: LightClientService;
  beforeEach(() => {
    const lightClient = sinon.createStubInstance(ethers.Contract);
    lightclientService = new LightClientService(
      lightClient,
      'STEP_FN_ID',
      'CHAIN_ID',
      'SUCCINCT_PLATFORM_URL',
      'SUCCINCT_API_KEY',
    );
  });

  afterEach(() => {
    sinon.restore();
  });

  test('should set currentProofId, if proof is not ready', async () => {
    sinon.replace(
      lightclientService,
      'postWithAuthorization',
      sinon.fake.resolves({ proof_id: '1' }),
    );
    await lightclientService.requestProof(
      ethers.utils.formatBytes32String('10'),
      10,
    );
    expect(lightclientService.pendingProofId).toBe('1');
  });

  test('should reset currentProofId, if proof is ready', async () => {
    // Set currentProofId
    sinon.replace(
      lightclientService,
      'postWithAuthorization',
      sinon.fake.resolves({ proof_id: '1' }),
    );
    await lightclientService.requestProof(
      ethers.utils.formatBytes32String('10'),
      10n,
    );
    expect(lightclientService.pendingProofId).toBe('1');

    // Try to get the proof again
    sinon.replace(
      lightclientService,
      'get',
      sinon.fake.resolves({ status: ProofStatus.success }),
    );
    await lightclientService.requestProof(
      ethers.utils.formatBytes32String('10'),
      10n,
    );
    expect(lightclientService.pendingProofId).toBeNull();
  });
});
