import { getProofs } from '../../src/functions/getProofs';
import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

chai.use(chaiAsPromised);

describe('functions tests', () => {
  describe('getProofs', () => {
    it('should return the proofs from api', async () => {
      const proofs = await getProofs(
        '0xc005dc82818d67af737725bd4bf75435d065d239',
        ['0x4374c903375ef1c6c66e6a9dc57b72742c6311d6569fb6fe2903a2172f8c31ff'],
        '0x1221E88'
      );

      expect(proofs).to.not.eq(null);
    });
  });
});
