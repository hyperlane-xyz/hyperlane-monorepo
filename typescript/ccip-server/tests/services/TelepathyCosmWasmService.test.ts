import { ethers } from 'ethers';
import { expect } from 'chai';
import sinon from 'sinon';

import { formatMessage } from '@hyperlane-xyz/utils';

import {
  calculateBeaconSlot,
  calculateDispatchedStorageSlot,
  encodeCosmWasmTelepathyMetadata,
  ETHEREUM_GENESIS_TIME,
  rlpEncodeProofNodes,
  SECONDS_PER_SLOT,
  TelepathyCosmWasmService,
} from '../../src/services/TelepathyCosmWasmService.js';

function mockLogger() {
  return {
    info: sinon.stub(),
    warn: sinon.stub(),
    error: sinon.stub(),
    debug: sinon.stub(),
    setBindings: sinon.stub(),
    child: sinon.stub().returnsThis(),
  };
}

describe('TelepathyCosmWasmService', () => {
  afterEach(() => sinon.restore());

  describe('calculateBeaconSlot', () => {
    it('calculates correct slot for timestamp', () => {
      const timestamp = ETHEREUM_GENESIS_TIME + 120n;
      const slot = calculateBeaconSlot(timestamp);
      expect(slot).to.equal(10n);
    });

    it('calculates slot for current mainnet era', () => {
      const timestamp = 1720000000n;
      const expectedSlot =
        (1720000000n - ETHEREUM_GENESIS_TIME) / SECONDS_PER_SLOT;
      expect(calculateBeaconSlot(timestamp)).to.equal(expectedSlot);
    });

    it('throws when timestamp is prior to genesis time', () => {
      expect(() => calculateBeaconSlot(1600000000n)).to.throw(
        'is before beacon chain genesis time',
      );
    });
  });

  describe('calculateDispatchedStorageSlot', () => {
    it('computes keccak256(nonce . slotIndex) for slot 0', () => {
      const nonce = 0;
      const slotIndex = 0;

      const nonceHex = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(nonce).toHexString(),
        32,
      );
      const slotIndexHex = ethers.utils.hexZeroPad(
        ethers.BigNumber.from(slotIndex).toHexString(),
        32,
      );
      const expected = ethers.utils.keccak256(
        ethers.utils.concat([nonceHex, slotIndexHex]),
      );

      expect(calculateDispatchedStorageSlot(nonce, slotIndex)).to.equal(
        expected,
      );
    });

    it('computes keccak256 for non-zero nonce', () => {
      const nonce = 1337;
      const expected = ethers.utils.keccak256(
        ethers.utils.concat([
          ethers.utils.hexZeroPad(
            ethers.BigNumber.from(1337).toHexString(),
            32,
          ),
          ethers.utils.hexZeroPad('0x00', 32),
        ]),
      );
      expect(calculateDispatchedStorageSlot(nonce, 0)).to.equal(expected);
    });
  });

  describe('rlpEncodeProofNodes and encodeCosmWasmTelepathyMetadata', () => {
    const dummyNode1 = '0x12345678';
    const dummyNode2 = '0xabcdef01';
    const dummyStorage1 = '0x99887766';

    it('encodes proof nodes as RLP list', () => {
      const rlp = rlpEncodeProofNodes([dummyNode1, dummyNode2]);
      expect(rlp).to.be.instanceOf(Uint8Array);
      expect(rlp.length).to.be.greaterThan(0);

      const decoded = ethers.utils.RLP.decode(rlp);
      expect(decoded).to.deep.equal([dummyNode1, dummyNode2]);
    });

    it('encodes full CosmWasm Telepathy metadata structure', () => {
      const slot = 987654n;
      const accountProof = [dummyNode1, dummyNode2];
      const storageProof = [dummyStorage1];

      const metadataHex = encodeCosmWasmTelepathyMetadata(
        slot,
        accountProof,
        storageProof,
      );
      expect(metadataHex).to.be.a('string');
      expect(metadataHex.startsWith('0x')).to.be.true;

      const metadataBytes = ethers.utils.arrayify(metadataHex);

      // 8 bytes slot
      const decodedSlot = ethers.BigNumber.from(
        metadataBytes.slice(0, 8),
      ).toBigInt();
      expect(decodedSlot).to.equal(slot);

      // 2 bytes account proof length
      const accountProofLen = ethers.BigNumber.from(
        metadataBytes.slice(8, 10),
      ).toNumber();
      expect(accountProofLen).to.be.greaterThan(0);

      // account proof bytes
      const accountProofBytes = metadataBytes.slice(10, 10 + accountProofLen);
      const decodedAccountProof = ethers.utils.RLP.decode(accountProofBytes);
      expect(decodedAccountProof).to.deep.equal(accountProof);

      // 2 bytes storage proof length
      const offsetStorageLen = 10 + accountProofLen;
      const storageProofLen = ethers.BigNumber.from(
        metadataBytes.slice(offsetStorageLen, offsetStorageLen + 2),
      ).toNumber();
      expect(storageProofLen).to.be.greaterThan(0);

      // storage proof bytes
      const offsetStorage = offsetStorageLen + 2;
      const storageProofBytes = metadataBytes.slice(
        offsetStorage,
        offsetStorage + storageProofLen,
      );
      const decodedStorageProof = ethers.utils.RLP.decode(storageProofBytes);
      expect(decodedStorageProof).to.deep.equal(storageProof);
    });
  });

  describe('TelepathyCosmWasmService execution', () => {
    const sender = '0x' + '11'.repeat(20);
    const recipient = '0x' + '22'.repeat(20);
    const originDomain = 17000;
    const destinationDomain = 1337;
    const body = '0xdeadbeef';
    const message = formatMessage(
      3,
      42,
      originDomain,
      sender,
      destinationDomain,
      recipient,
      body,
    );

    it('fetches eth_getProof and returns CosmWasm formatted metadata', async () => {
      const mockAccountProof = ['0xaaaa', '0xbbbb'];
      const mockStorageProof = ['0xcccc'];

      const mockProvider = {
        getTransactionReceipt: sinon.stub().resolves({
          transactionHash: '0x' + '99'.repeat(32),
          blockNumber: 123456,
        }),
        getBlock: sinon.stub().resolves({
          timestamp: 1720000000,
        }),
        send: sinon
          .stub()
          .withArgs('eth_getProof')
          .resolves({
            accountProof: mockAccountProof,
            storageProof: [{ proof: mockStorageProof }],
          }),
      };

      const multiProvider = {
        getProvider: sinon.stub().returns(mockProvider),
      } as any;

      const service = new TelepathyCosmWasmService({
        serviceName: 'telepathyCosmWasm',
        multiProvider,
      });

      const metadata = await service.getTelepathyProof(
        message,
        '0x' + '99'.repeat(32),
        mockLogger() as any,
      );

      expect(metadata).to.be.a('string');
      expect(metadata.startsWith('0x')).to.be.true;

      const metadataBytes = ethers.utils.arrayify(metadata);
      const expectedSlot = calculateBeaconSlot(1720000000n);
      const decodedSlot = ethers.BigNumber.from(
        metadataBytes.slice(0, 8),
      ).toBigInt();
      expect(decodedSlot).to.equal(expectedSlot);
    });
  });
});
