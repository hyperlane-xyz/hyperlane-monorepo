import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';
import sinon from 'sinon';

import {
  InterchainAccountRouter__factory,
  TimelockController__factory,
} from '@hyperlane-xyz/core';
import {
  InterchainAccount,
  MultiProvider,
  TestChainName,
} from '@hyperlane-xyz/sdk';
import { addressToBytes32 } from '@hyperlane-xyz/utils';

import { GovernTransactionReader } from '../src/tx/govern-transaction-reader.js';

const address = (value: number) =>
  utils.getAddress(utils.hexZeroPad(utils.hexlify(value), 20));
const origin = TestChainName.test1;
const destination = TestChainName.test2;
const originV2 = address(1);
const originV3 = address(2);
const destinationV2 = address(3);
const destinationV3 = address(4);
const legacyRouter = address(5);
const safe = address(6);
const expectedIca = address(7);
const timelock = address(11);
const v2OnlyDestination = TestChainName.test3;
const v2OnlyRouter = address(12);
const iface = InterchainAccountRouter__factory.createInterface();
const callInterface = new utils.Interface([
  'function callRemoteWithOverrides(uint32 _destination, bytes32 _router, bytes32 _ism, tuple(bytes32,uint256,bytes)[] _calls, bytes _hookMetadata) payable returns (bytes32)',
]);

describe('GovernTransactionReader ICA routers', () => {
  let multiProvider: MultiProvider;
  let reader: GovernTransactionReader;
  let getAccount: sinon.SinonStub;

  beforeEach(() => {
    multiProvider = MultiProvider.createTestMultiProvider();
    const chainAddresses = {
      [origin]: {
        interchainAccountRouter: originV2,
        interchainAccountRouterV3: originV3,
      },
      [destination]: {
        interchainAccountRouter: destinationV2,
        interchainAccountRouterV3: destinationV3,
      },
      [v2OnlyDestination]: { interchainAccountRouter: v2OnlyRouter },
      ethereum: { legacyInterchainAccountRouter: legacyRouter },
    };
    reader = new GovernTransactionReader(
      'test',
      multiProvider,
      chainAddresses,
      {},
      {},
      { [origin]: safe },
      { [destination]: expectedIca },
      {},
      { [origin]: timelock },
    );
    const app = InterchainAccount.fromAddressesMap(
      {
        [origin]: chainAddresses[origin],
        [destination]: chainAddresses[destination],
      },
      multiProvider,
    );
    getAccount = sinon.stub(app, 'getAccount').resolves(expectedIca);
    sinon.stub(InterchainAccount, 'fromAddressesMap').returns(app);
  });

  afterEach(() => sinon.restore());

  for (const [localRouter, remoteRouter] of [
    [originV2, destinationV2],
    [originV3, destinationV3],
  ]) {
    it(`recognizes and labels the actual router ${localRouter}`, async () => {
      const tx = {
        to: localRouter,
        value: BigNumber.from(0),
        data: iface.encodeFunctionData('setHook', [address(8)]),
      };
      expect(reader.isIcaTransaction(origin, tx)).to.be.true;
      const result = await reader.read(origin, tx);
      expect(result.to).to.equal(`ICA Router (${origin} ${localRouter})`);
      expect(result.signature).to.equal('setHook(address)');
    });

    for (const singular of [false, true]) {
      it(`validates ${singular ? 'single' : 'batch'} enrollment against the same generation as ${localRouter}`, async () => {
        const domain = multiProvider.getDomainId(destination);
        const data = singular
          ? iface.encodeFunctionData('enrollRemoteRouter', [
              domain,
              addressToBytes32(remoteRouter),
            ])
          : iface.encodeFunctionData('enrollRemoteRouters', [
              [domain],
              [addressToBytes32(remoteRouter)],
            ]);
        const result = await reader.read(origin, {
          to: localRouter,
          value: BigNumber.from(0),
          data,
        });
        expect(result.args[0].insight).to.equal(
          '✅ matches expected router from artifacts',
        );
        expect(reader.errors).to.deep.equal([]);
      });
    }

    it(`derives using the actual source chain/router for ${localRouter}`, async () => {
      const data = callInterface.encodeFunctionData('callRemoteWithOverrides', [
        multiProvider.getDomainId(destination),
        addressToBytes32(remoteRouter),
        constants.HashZero,
        [],
        '0x',
      ]);
      const result = await reader.read(origin, {
        to: localRouter,
        value: BigNumber.from(0),
        data,
      });
      expect(
        getAccount.calledOnceWithExactly(destination, {
          owner: safe,
          origin,
          localRouter,
          routerOverride: addressToBytes32(remoteRouter),
          ismOverride: constants.HashZero,
          userSalt: undefined,
        }),
      ).to.be.true;
      expect(result.args.destinationIca.address).to.equal(expectedIca);
      expect(reader.errors).to.deep.equal([]);
    });
  }

  for (const withHook of [false, true]) {
    it(`preserves the actual salt in a ${withHook ? '7' : '6'}-argument V3 remote call`, async () => {
      const userSalt = utils.hexZeroPad('0x1234', 32);
      const args = [
        multiProvider.getDomainId(destination),
        addressToBytes32(destinationV3),
        constants.HashZero,
        [],
        '0x',
        userSalt,
      ];
      const signature = withHook
        ? 'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32,address)'
        : 'callRemoteWithOverrides(uint32,bytes32,bytes32,(bytes32,uint256,bytes)[],bytes,bytes32)';
      const data = new utils.Interface(iface.fragments).encodeFunctionData(
        signature,
        withHook ? [...args, address(8)] : args,
      );
      getAccount.resolves(address(9));
      await reader.read(origin, {
        to: originV3,
        value: BigNumber.from(0),
        data,
      });
      expect(getAccount.firstCall.args[1].userSalt).to.equal(userSalt);
      expect(reader.errors.map((error) => error.info)).to.include(
        'Incorrect destination ICA in ICA call',
      );
    });
  }

  it('retains the legacy Ethereum router and rejects unrelated targets', () => {
    expect(reader.isIcaTransaction(origin, { to: legacyRouter })).to.be.true;
    expect(reader.isIcaTransaction(origin, { to: address(999) })).to.be.false;
    expect(reader.isIcaTransaction(origin, {})).to.be.false;
  });

  it('keeps configured ICA and ISM policy errors for a recognized V3 remote call', async () => {
    getAccount.resolves(address(9));
    const data = callInterface.encodeFunctionData('callRemoteWithOverrides', [
      multiProvider.getDomainId(destination),
      addressToBytes32(destinationV3),
      addressToBytes32(address(10)),
      [],
      '0x',
    ]);
    await reader.read(origin, { to: originV3, value: BigNumber.from(0), data });
    expect(reader.errors.map((error) => error.info)).to.deep.equal([
      'Incorrect ISM in ICA call, expected zero hash',
      'Incorrect destination ICA in ICA call',
    ]);
  });

  it('keeps a router mismatch error when enrolling V2 on a V3 router', async () => {
    await reader.read(origin, {
      to: originV3,
      value: BigNumber.from(0),
      data: iface.encodeFunctionData('enrollRemoteRouters', [
        [multiProvider.getDomainId(destination)],
        [addressToBytes32(destinationV2)],
      ]),
    });
    expect(reader.errors[0].expected).to.equal(destinationV3);
    expect(reader.errors[0].info).to.equal(
      'Incorrect router address getting enrolled',
    );
  });

  it('derives a timelock-executed remote call from the timelock, not the Safe', async () => {
    const call = callInterface.encodeFunctionData('callRemoteWithOverrides', [
      multiProvider.getDomainId(destination),
      addressToBytes32(destinationV2),
      constants.HashZero,
      [],
      '0x',
    ]);
    await reader.read(origin, {
      to: timelock,
      value: BigNumber.from(0),
      data: TimelockController__factory.createInterface().encodeFunctionData(
        'executeBatch',
        [[originV2], [0], [call], constants.HashZero, constants.HashZero],
      ),
    });
    expect(getAccount.firstCall.args[1].owner).to.equal(timelock);
  });

  it('flags a V3 remote call to a destination without a V3 router', async () => {
    const data = callInterface.encodeFunctionData('callRemoteWithOverrides', [
      multiProvider.getDomainId(v2OnlyDestination),
      addressToBytes32(v2OnlyRouter),
      constants.HashZero,
      [],
      '0x',
    ]);
    await reader.read(origin, { to: originV3, value: BigNumber.from(0), data });
    expect(reader.errors[0].info).to.equal('Incorrect router in ICA call');
  });

  it('fails explicitly when the source chain has no configured governance Safe', async () => {
    delete reader.safes[origin];
    const data = callInterface.encodeFunctionData('callRemoteWithOverrides', [
      multiProvider.getDomainId(destination),
      addressToBytes32(destinationV3),
      constants.HashZero,
      [],
      '0x',
    ]);
    let caught: unknown;
    try {
      await reader.read(origin, {
        to: originV3,
        value: BigNumber.from(0),
        data,
      });
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught)
      .to.be.instanceOf(Error)
      .with.property(
        'message',
        `No governance Safe configured for ICA origin ${origin}`,
      );
    expect(getAccount.called).to.be.false;
  });
});
