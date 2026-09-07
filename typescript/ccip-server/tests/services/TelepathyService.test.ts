import { expect } from 'chai';
import { ethers } from 'ethers';

import { TelepathyService } from '../../src/services/TelepathyService.js';

describe('TelepathyService', () => {
  const service = new TelepathyService({ serviceName: 'telepathy' });

  it('calculateBeaconSlot accurately converts timestamps', () => {
    const genesisTime = 1606824120; // Eth mainnet genesis
    expect(service.calculateBeaconSlot(genesisTime)).to.equal(0);
    expect(service.calculateBeaconSlot(genesisTime + 12)).to.equal(1);
    expect(service.calculateBeaconSlot(genesisTime + 1200)).to.equal(100);
    expect(service.calculateBeaconSlot(genesisTime - 10)).to.equal(0);
  });

  it('getMessageStorageKey derives deterministic storage slot', () => {
    const msgId = ethers.utils.hexZeroPad('0x1234', 32);
    const key1 = service.getMessageStorageKey(msgId);
    expect(key1).to.exist;
    expect(key1.startsWith('0x')).to.be.true;
    expect(key1.length).to.equal(66);

    const keyWithIndex = service.getMessageStorageKey(msgId, 5);
    expect(keyWithIndex).to.exist;
    expect(keyWithIndex.startsWith('0x')).to.be.true;
    expect(keyWithIndex.length).to.equal(66);
    expect(keyWithIndex).to.not.equal(key1);
  });

  it('router mounts all required CCIP-read and REST routes', () => {
    const routes = service.router.stack.map((layer: any) => ({
      path: layer.route?.path,
      methods: layer.route?.methods,
    }));

    const paths = routes.map((r: any) => r.path).filter(Boolean);
    expect(paths).to.include('/getProof/:sender/:callData.json');
    expect(paths).to.include('/getProof');
    expect(paths).to.include('/fetchProof/:messageId');
    expect(paths).to.include('/fetchProof');
    expect(paths).to.include('/getProofForMessage');
  });
});
