import { ethers, helpers } from 'hardhat';
import { BytesLike } from 'ethers';
import { expect } from 'chai';

import { toBytes32 } from '@abacus-network/abacus-sol/test/lib/utils';
import { formatTokenId } from '../lib/bridge';
import {
  TokenIdentifier,
  TransferAction,
  DetailsAction,
  Message,
  RequestDetailsAction,
} from '../lib/types';
import { TestBridgeMessage__factory, TestBridgeMessage } from '../../typechain';

const {
  BridgeMessageTypes,
  serializeMessage,
  serializeDetailsAction,
  serializeTransferAction,
  serializeRequestDetailsAction,
} = helpers.bridge;

const stringToBytes32 = (s: string): string => {
  const str = Buffer.from(s.slice(0, 32), 'utf-8');
  const result = Buffer.alloc(32);
  str.copy(result);

  return '0x' + result.toString('hex');
};

describe('BridgeMessage', async () => {
  let bridgeMessage: TestBridgeMessage,
    transferBytes: BytesLike,
    detailsBytes: BytesLike,
    requestDetailsBytes: BytesLike,
    transferMessageBytes: BytesLike,
    detailsMessageBytes: BytesLike,
    requestDetailsMessageBytes: BytesLike,
    transferAction: TransferAction,
    detailsAction: DetailsAction,
    testTokenId: TokenIdentifier,
    deployerAddress: string,
    tokenIdBytes: BytesLike;

  before(async () => {
    const [deployer] = await ethers.getSigners();
    deployerAddress = await deployer.getAddress();
    const deployerId = toBytes32(deployerAddress).toLowerCase();
    const TOKEN_VALUE = 0xffff;

    // tokenId
    testTokenId = {
      domain: 1,
      id: '0x' + '11'.repeat(32),
    };
    tokenIdBytes = formatTokenId(
      testTokenId.domain as number,
      testTokenId.id as string,
    );

    // transfer action/message
    transferAction = {
      type: BridgeMessageTypes.TRANSFER,
      recipient: deployerId,
      amount: TOKEN_VALUE,
    };
    transferBytes = serializeTransferAction(transferAction);
    const transferMessage: Message = {
      tokenId: testTokenId,
      action: transferAction,
    };
    transferMessageBytes = serializeMessage(transferMessage);

    // details action/message
    detailsAction = {
      type: BridgeMessageTypes.DETAILS,
      name: stringToBytes32('TEST TOKEN'),
      symbol: stringToBytes32('TEST'),
      decimals: 8,
    };
    detailsBytes = serializeDetailsAction(detailsAction);
    const detailsMessage: Message = {
      tokenId: testTokenId,
      action: detailsAction,
    };
    detailsMessageBytes = serializeMessage(detailsMessage);

    // requestDetails action/message
    const requestDetailsAction: RequestDetailsAction = {
      type: BridgeMessageTypes.REQUEST_DETAILS,
    };
    requestDetailsBytes = serializeRequestDetailsAction(requestDetailsAction);
    const requestDetailsMessage: Message = {
      tokenId: testTokenId,
      action: {
        type: BridgeMessageTypes.REQUEST_DETAILS,
      },
    };
    requestDetailsMessageBytes = serializeMessage(requestDetailsMessage);

    const [signer] = await ethers.getSigners();

    const bridgeMessageFactory = new TestBridgeMessage__factory(signer);
    bridgeMessage = await bridgeMessageFactory.deploy();
  });

  it('validates actions', async () => {
    const invalidAction = '0x00';

    // transfer message is valid
    let isAction = await bridgeMessage.testIsValidAction(
      transferBytes,
      BridgeMessageTypes.TRANSFER,
    );
    expect(isAction).to.be.true;
    // details message is valid
    isAction = await bridgeMessage.testIsValidAction(
      detailsBytes,
      BridgeMessageTypes.DETAILS,
    );
    expect(isAction).to.be.true;
    // request details message is valid
    isAction = await bridgeMessage.testIsValidAction(
      requestDetailsBytes,
      BridgeMessageTypes.REQUEST_DETAILS,
    );
    expect(isAction).to.be.true;
    // not a valid message type
    isAction = await bridgeMessage.testIsValidAction(
      transferBytes,
      BridgeMessageTypes.INVALID,
    );
    expect(isAction).to.be.false;
    // not a valid action type
    isAction = await bridgeMessage.testIsValidAction(
      invalidAction,
      BridgeMessageTypes.TRANSFER,
    );
    expect(isAction).to.be.false;
  });

  it('validates message length', async () => {
    const invalidMessageLen = '0x' + '03'.repeat(38);
    // valid transfer message
    let isValidLen = await bridgeMessage.testIsValidMessageLength(
      transferMessageBytes,
    );
    expect(isValidLen).to.be.true;
    // valid details message
    isValidLen = await bridgeMessage.testIsValidMessageLength(
      detailsMessageBytes,
    );
    expect(isValidLen).to.be.true;
    // valid requestDetails message
    isValidLen = await bridgeMessage.testIsValidMessageLength(
      requestDetailsMessageBytes,
    );
    expect(isValidLen).to.be.true;
    // invalid message length
    isValidLen = await bridgeMessage.testIsValidMessageLength(
      invalidMessageLen,
    );
    expect(isValidLen).to.be.false;
    // TODO: check that message length matches type?
  });

  it('formats message', async () => {
    // formats message
    const newMessage = await bridgeMessage.testFormatMessage(
      tokenIdBytes,
      transferBytes,
      BridgeMessageTypes.TOKEN_ID,
      BridgeMessageTypes.TRANSFER,
    );
    expect(newMessage).to.equal(transferMessageBytes);
    // reverts with bad tokenId
    await expect(
      bridgeMessage.testFormatMessage(
        tokenIdBytes,
        transferBytes,
        BridgeMessageTypes.INVALID,
        BridgeMessageTypes.TRANSFER,
      ),
    ).to.be.reverted;
    // reverts with bad action
    await expect(
      bridgeMessage.testFormatMessage(
        tokenIdBytes,
        transferBytes,
        BridgeMessageTypes.TOKEN_ID,
        BridgeMessageTypes.INVALID,
      ),
    ).to.be.revertedWith('!action');
  });

  it('returns correct message type', async () => {
    // transfer message
    let type = await bridgeMessage.testMessageType(transferMessageBytes);
    expect(type).to.equal(BridgeMessageTypes.TRANSFER);
    // details message
    type = await bridgeMessage.testMessageType(detailsMessageBytes);
    expect(type).to.equal(BridgeMessageTypes.DETAILS);
    // request details message
    type = await bridgeMessage.testMessageType(requestDetailsMessageBytes);
    expect(type).to.equal(BridgeMessageTypes.REQUEST_DETAILS);
  });

  it('checks message type', async () => {
    // transfer message
    let isTransfer = await bridgeMessage.testIsTransfer(transferBytes);
    expect(isTransfer).to.be.true;
    isTransfer = await bridgeMessage.testIsTransfer(detailsBytes);
    expect(isTransfer).to.be.false;
    isTransfer = await bridgeMessage.testIsTransfer(requestDetailsBytes);
    expect(isTransfer).to.be.false;

    let isDetails = await bridgeMessage.testIsDetails(detailsBytes);
    expect(isDetails).to.be.true;
    isDetails = await bridgeMessage.testIsDetails(transferBytes);
    expect(isDetails).to.be.false;
    isDetails = await bridgeMessage.testIsDetails(requestDetailsBytes);
    expect(isDetails).to.be.false;

    let isRequestDetails = await bridgeMessage.testIsRequestDetails(
      requestDetailsBytes,
    );
    expect(isRequestDetails).to.be.true;
    isRequestDetails = await bridgeMessage.testIsRequestDetails(detailsBytes);
    expect(isRequestDetails).to.be.false;
    isRequestDetails = await bridgeMessage.testIsRequestDetails(transferBytes);
    expect(isRequestDetails).to.be.false;
  });

  it('fails for wrong action type', async () => {
    const invalidType = '0x00';
    const badTransfer: BytesLike = ethers.utils.hexConcat([
      invalidType,
      ethers.utils.hexDataSlice(transferBytes, 1),
    ]);
    const badDetails: BytesLike = ethers.utils.hexConcat([
      invalidType,
      ethers.utils.hexDataSlice(detailsBytes, 1),
    ]);
    const badRequest: BytesLike = ethers.utils.hexConcat([
      invalidType,
      ethers.utils.hexDataSlice(requestDetailsBytes, 1),
    ]);

    const isTransfer = await bridgeMessage.testIsTransfer(badTransfer);
    expect(isTransfer).to.be.false;
    const isDetails = await bridgeMessage.testIsDetails(badDetails);
    expect(isDetails).to.be.false;
    const isRequest = await bridgeMessage.testIsRequestDetails(badRequest);
    expect(isRequest).to.be.false;
  });

  it('formats transfer action', async () => {
    const { recipient, amount } = transferAction;
    const newTransfer = await bridgeMessage.testFormatTransfer(
      recipient,
      amount,
    );
    expect(newTransfer).to.equal(transferBytes);
  });

  it('formats details action', async () => {
    const { name, symbol, decimals } = detailsAction;
    const newDetails = await bridgeMessage.testFormatDetails(
      name,
      symbol,
      decimals,
    );
    expect(newDetails).to.equal(detailsBytes);
  });

  it('formats request details action', async () => {
    const newDetails = await bridgeMessage.testFormatRequestDetails();
    expect(newDetails).to.equal(requestDetailsBytes);
  });

  it('formats token id', async () => {
    const newTokenId = await bridgeMessage.testFormatTokenId(
      testTokenId.domain,
      testTokenId.id,
    );
    expect(newTokenId).to.equal(tokenIdBytes);
  });

  it('returns elements of a token id', async () => {
    const evmId = '0x' + (testTokenId.id as string).slice(26);
    const [domain, id, newEvmId] = await bridgeMessage.testSplitTokenId(
      tokenIdBytes,
    );
    expect(domain).to.equal(testTokenId.domain);
    expect(id).to.equal(testTokenId.id);
    expect(newEvmId).to.equal(evmId);

    await bridgeMessage.testSplitTokenId(transferMessageBytes);
  });

  it('returns elements of a transfer action', async () => {
    const evmRecipient = deployerAddress;

    const [type, recipient, newEvmRecipient, amount] =
      await bridgeMessage.testSplitTransfer(transferBytes);
    expect(type).to.equal(BridgeMessageTypes.TRANSFER);
    expect(recipient).to.equal(transferAction.recipient);
    expect(newEvmRecipient).to.equal(evmRecipient);
    expect(amount).to.equal(transferAction.amount);
  });

  it('returns elements of a details action', async () => {
    const [type, name, symbol, decimals] = await bridgeMessage.testSplitDetails(
      detailsBytes,
    );
    expect(type).to.equal(BridgeMessageTypes.DETAILS);
    expect(name).to.equal(detailsAction.name);
    expect(symbol).to.equal(detailsAction.symbol);
    expect(decimals).to.equal(detailsAction.decimals);
  });

  it('returns elements of a message', async () => {
    const [newTokenId, action] = await bridgeMessage.testSplitMessage(
      transferMessageBytes,
    );
    expect(newTokenId).to.equal(tokenIdBytes);
    expect(action).to.equal(transferBytes);
  });

  it('fails if message type is not valid', async () => {
    const revertMsg = 'Validity assertion failed';

    await expect(
      bridgeMessage.testMustBeTransfer(detailsBytes),
    ).to.be.revertedWith(revertMsg);
    await expect(
      bridgeMessage.testMustBeDetails(transferBytes),
    ).to.be.revertedWith(revertMsg);
    await expect(
      bridgeMessage.testMustBeRequestDetails(transferBytes),
    ).to.be.revertedWith(revertMsg);
    await expect(
      bridgeMessage.testMustBeTokenId(transferBytes),
    ).to.be.revertedWith(revertMsg);
    await expect(
      bridgeMessage.testMustBeMessage(transferBytes),
    ).to.be.revertedWith(revertMsg);
  });
});
