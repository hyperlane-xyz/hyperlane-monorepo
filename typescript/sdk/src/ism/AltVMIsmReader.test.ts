import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';
import Sinon from 'sinon';

import { AltVM } from '@hyperlane-xyz/utils';

import { MultiProtocolProvider } from '../providers/MultiProtocolProvider.js';
import { MockProvider } from '../test/AltVMMockProvider.js';

import { AltVMIsmReader } from './AltVMIsmReader.js';
import { IsmType } from './types.js';

chai.use(chaiAsPromised);
const expect = chai.expect;

/*

TEST CASES - AltVMIsmReader tests

* derive ISM config

*/

describe('AltVMIsmReader', () => {
  let provider: AltVM.IProvider<any>;
  let ismReader: AltVMIsmReader;

  const multiProvider = MultiProtocolProvider.createTestMultiProtocolProvider<{
    mailbox?: string;
  }>();

  beforeEach(async () => {
    provider = await MockProvider.connect();

    ismReader = new AltVMIsmReader(multiProvider, provider);
  });

  it('derive message id multisig ISM', async () => {
    // ARRANGE
    const ismAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';

    const ism = {
      address: ismAddress,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    const ismTypeStub = Sinon.stub(provider, 'getIsmType').resolves(
      AltVM.IsmType.MESSAGE_ID_MULTISIG,
    );

    const getIsmStub = Sinon.stub(provider, 'getMessageIdMultisigIsm').resolves(
      ism,
    );

    // ACT
    const ismConfig = await ismReader.deriveIsmConfig(ismAddress);

    // ASSERT
    expect(ismConfig).to.deep.equal({
      type: IsmType.MESSAGE_ID_MULTISIG,
      ...ism,
    });

    expect(
      ismTypeStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
    expect(
      getIsmStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
  });

  it('derive merkle root multisig ISM', async () => {
    // ARRANGE
    const ismAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';

    const ism = {
      address: ismAddress,
      validators: ['0xe699ceCa237DD38e8f2Fa308D7d1a2BeCFC5493E'],
      threshold: 1,
    };

    const ismTypeStub = Sinon.stub(provider, 'getIsmType').resolves(
      AltVM.IsmType.MERKLE_ROOT_MULTISIG,
    );

    const getIsmStub = Sinon.stub(
      provider,
      'getMerkleRootMultisigIsm',
    ).resolves(ism);

    // ACT
    const ismConfig = await ismReader.deriveIsmConfig(ismAddress);

    // ASSERT
    expect(ismConfig).to.deep.equal({
      type: IsmType.MERKLE_ROOT_MULTISIG,
      ...ism,
    });

    expect(
      ismTypeStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
    expect(
      getIsmStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
  });

  it('derive noop ISM', async () => {
    // ARRANGE
    const ismAddress =
      '0x726f757465725f69736d00000000000000000000000000050000000000000000';

    const ism = {
      address: ismAddress,
    };

    const ismTypeStub = Sinon.stub(provider, 'getIsmType').resolves(
      AltVM.IsmType.TEST_ISM,
    );

    const getIsmStub = Sinon.stub(provider, 'getNoopIsm').resolves(ism);

    // ACT
    const ismConfig = await ismReader.deriveIsmConfig(ismAddress);

    // ASSERT
    expect(ismConfig).to.deep.equal({
      type: IsmType.TEST_ISM,
      ...ism,
    });

    expect(
      ismTypeStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
    expect(
      getIsmStub.calledOnceWith({
        ismAddress,
      }),
    ).to.be.true;
  });
});
