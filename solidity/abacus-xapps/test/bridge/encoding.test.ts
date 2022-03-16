import { ethers } from 'hardhat';
import { TestEncoding__factory } from '../../typechain';

describe('Encoding', async () => {
  it('encodes', async () => {
    const [signer] = await ethers.getSigners();
    const factory = new TestEncoding__factory(signer);
    const instance = await factory.deploy();

    await instance.test();
  });
});
