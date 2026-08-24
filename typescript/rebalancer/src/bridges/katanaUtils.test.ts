import { expect } from 'chai';
import { ethers } from 'ethers';

import {
  addressToBytes32,
  buildKatanaEthereumToKatana,
  buildKatanaToEthereumCompose,
  oftInterface,
} from './katanaUtils.js';

const composerInterface = new ethers.utils.Interface([
  'function depositAndSend(uint256 amount,(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd) sendParam,address refundAddress)',
]);

describe('katanaUtils', () => {
  it('builds deterministic ethereum->katana composer artifacts', () => {
    const result = buildKatanaEthereumToKatana({
      vaultAddress: '0x1111111111111111111111111111111111111111',
      composerAddress: '0x2222222222222222222222222222222222222222',
      shareOftAddress: '0x3333333333333333333333333333333333333333',
      underlyingTokenAddress: '0x4444444444444444444444444444444444444444',
      dstEid: 30375,
      recipient: '0x5555555555555555555555555555555555555555',
      amountLD: 12_345_678n,
      shareAmountLD: 12_300_000n,
      minShareAmountLD: 12_000_000n,
      refundAddress: '0x6666666666666666666666666666666666666666',
      extraOptions: '0x01020304',
      composeMsg: '0x',
      oftCmd: '0x',
    });

    expect(result.recipientBytes32).to.equal(
      addressToBytes32('0x5555555555555555555555555555555555555555'),
    );
    expect(result.previewDepositRead.args).to.deep.equal(['12345678']);
    expect(result.assetApproveTx.args).to.deep.equal([
      '0x2222222222222222222222222222222222222222',
      '12345678',
    ]);

    const decodedQuote = oftInterface.decodeFunctionData(
      'quoteSend',
      result.quoteRead.data,
    );
    expect(decodedQuote.sendParam.dstEid).to.equal(30375);
    expect(decodedQuote.sendParam.amountLD.toString()).to.equal('12300000');
    expect(decodedQuote.sendParam.minAmountLD.toString()).to.equal('12000000');
    expect(decodedQuote.sendParam.to).to.equal(
      addressToBytes32('0x5555555555555555555555555555555555555555'),
    );

    const decodedDepositAndSend = composerInterface.decodeFunctionData(
      'depositAndSend',
      result.depositAndSendTx.data,
    );
    expect(decodedDepositAndSend.amount.toString()).to.equal('12345678');
    expect(decodedDepositAndSend.sendParam.amountLD.toString()).to.equal(
      '12300000',
    );
    expect(decodedDepositAndSend.refundAddress).to.equal(
      '0x6666666666666666666666666666666666666666',
    );
  });

  it('builds deterministic katana->ethereum compose redemption artifacts', () => {
    const result = buildKatanaToEthereumCompose({
      vaultAddress: '0x1111111111111111111111111111111111111111',
      composerAddress: '0x2222222222222222222222222222222222222222',
      shareTokenAddress: '0x3333333333333333333333333333333333333333',
      shareOftAddress: '0x4444444444444444444444444444444444444444',
      dstEid: 30101,
      recipient: '0x5555555555555555555555555555555555555555',
      shareAmountLD: 5_000_000n,
      minShareAmountLD: 4_999_999n,
      assetAmountLD: 4_500_000n,
      minAssetAmountLD: 4_400_000n,
      refundAddress: '0x6666666666666666666666666666666666666666',
      extraOptions: '0x01020304',
      receiveExtraOptions: '0x05060708',
      oftCmd: '0x',
    });

    expect(result.composerBytes32).to.equal(
      addressToBytes32('0x2222222222222222222222222222222222222222'),
    );
    expect(result.recipientBytes32).to.equal(
      addressToBytes32('0x5555555555555555555555555555555555555555'),
    );
    expect(result.previewRedeemRead.args).to.deep.equal(['5000000']);

    const decodedQuote = oftInterface.decodeFunctionData(
      'quoteSend',
      result.quoteRead.data,
    );
    expect(decodedQuote.sendParam.dstEid).to.equal(30101);
    expect(decodedQuote.sendParam.amountLD.toString()).to.equal('5000000');
    expect(decodedQuote.sendParam.minAmountLD.toString()).to.equal('4999999');
    expect(decodedQuote.sendParam.to).to.equal(
      addressToBytes32('0x2222222222222222222222222222222222222222'),
    );

    const decodedComposeMsg = ethers.utils.defaultAbiCoder.decode(
      [
        'tuple(uint32 dstEid,bytes32 to,uint256 amountLD,uint256 minAmountLD,bytes extraOptions,bytes composeMsg,bytes oftCmd)',
        'uint256',
      ],
      decodedQuote.sendParam.composeMsg,
    );
    expect(decodedComposeMsg[0].to).to.equal(
      addressToBytes32('0x5555555555555555555555555555555555555555'),
    );
    expect(decodedComposeMsg[0].amountLD.toString()).to.equal('4500000');
    expect(decodedComposeMsg[0].minAmountLD.toString()).to.equal('4400000');
    expect(decodedComposeMsg[1].toString()).to.equal('0');

    const decodedSend = oftInterface.decodeFunctionData(
      'send',
      result.sendTx.data,
    );
    expect(decodedSend.refundAddress).to.equal(
      '0x6666666666666666666666666666666666666666',
    );
    expect(decodedSend.fee.nativeFee.toString()).to.equal('0');
  });
});
