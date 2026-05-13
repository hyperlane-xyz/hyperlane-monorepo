import { expect } from 'chai';
import { ethers } from 'ethers';

import { randomAddress } from '../test/testUtils.js';

import { IsmType } from './types.js';
import { blacklistIsmStorageRoot } from './utils.js';

describe('ism utils', () => {
  describe('blacklistIsmStorageRoot', () => {
    const id = (value: string) =>
      ethers.utils.keccak256(ethers.utils.toUtf8Bytes(value));

    it('matches independent of id order or duplicates', async () => {
      const owner = randomAddress();
      const root = await blacklistIsmStorageRoot({
        type: IsmType.BLACKLIST,
        owner,
        blacklistedIds: [id('msg1'), id('msg2')],
      });

      expect(
        await blacklistIsmStorageRoot({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [id('msg2'), id('msg1'), id('msg1')],
        }),
      ).to.equal(root);
    });

    it('changes when ids or owner change', async () => {
      const owner = randomAddress();
      const root = await blacklistIsmStorageRoot({
        type: IsmType.BLACKLIST,
        owner,
        blacklistedIds: [id('msg1'), id('msg2')],
      });

      expect(
        await blacklistIsmStorageRoot({
          type: IsmType.BLACKLIST,
          owner,
          blacklistedIds: [id('msg1'), id('msg2'), id('msg3')],
        }),
      ).to.not.equal(root);
      expect(
        await blacklistIsmStorageRoot({
          type: IsmType.BLACKLIST,
          owner: randomAddress(),
          blacklistedIds: [id('msg1'), id('msg2')],
        }),
      ).to.not.equal(root);
    });
  });
});
