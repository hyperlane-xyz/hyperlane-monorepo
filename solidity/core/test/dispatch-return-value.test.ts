import { ethers } from 'hardhat';
import { expect } from 'chai';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';

import {
  TestDispatchCaller__factory,
  TestDispatchNoReturnValue__factory,
  TestDispatchWithReturnValue__factory,
} from '../types';

// Tests backward compatibility of adding a return value to `dispatch`
describe.only('Dispatch return value backward compatibility', async () => {
  let signer: SignerWithAddress;
  const ONE = ethers.BigNumber.from('1');
  const ZERO_BYTES32 =
    '0x0000000000000000000000000000000000000000000000000000000000000000';

  before(async () => {
    [signer] = await ethers.getSigners();
  });

  it('Tests backward compaitibility of adding a return value to dispatch', async () => {
    const dispatchNoReturnValueFactory = new TestDispatchNoReturnValue__factory(
      signer,
    );
    const dispatchWithReturnValueFactory =
      new TestDispatchWithReturnValue__factory(signer);
    const testDispatchCallerFactory = new TestDispatchCaller__factory(signer);

    const dispatchNoReturnValue = await dispatchNoReturnValueFactory.deploy();
    const dispatchCaller = await testDispatchCallerFactory.deploy(
      dispatchNoReturnValue.address,
    );

    expect(
      async () =>
        await dispatchCaller.callDispatch(ONE, ZERO_BYTES32, ZERO_BYTES32),
    ).to.not.throw();

    const dispatchWithReturnValue =
      await dispatchWithReturnValueFactory.deploy();
    await dispatchCaller.setDispatcher(dispatchWithReturnValue.address);

    expect(
      async () =>
        await dispatchCaller.callDispatch(ONE, ZERO_BYTES32, ZERO_BYTES32),
    ).to.not.throw();
  });
});
