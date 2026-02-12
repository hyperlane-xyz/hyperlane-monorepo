import { expect } from 'chai';
import { BigNumber, constants, utils } from 'ethers';

import {
  Commands,
  buildSwapAndBridgeTx,
  encodeExecuteCrossChain,
  encodeV3SwapExactIn,
} from './UniversalRouterEncoder.js';

describe('UniversalRouterEncoder', () => {
  const ORIGIN_TOKEN = '0x1111111111111111111111111111111111111111';
  const BRIDGE_TOKEN = '0x2222222222222222222222222222222222222222';
  const DESTINATION_TOKEN = '0x3333333333333333333333333333333333333333';
  const UNIVERSAL_ROUTER = '0x4444444444444444444444444444444444444444';
  const WARP_ROUTE = '0x5555555555555555555555555555555555555555';
  const ICA_ROUTER = '0x6666666666666666666666666666666666666666';
  const REMOTE_ICA_ROUTER = '0x7777777777777777777777777777777777777777';
  const ISM = '0x8888888888888888888888888888888888888888';

  const decodeBridgeToken = (encodedInput: string) =>
    utils.defaultAbiCoder.decode(
      [
        'uint8',
        'bytes32',
        'address',
        'address',
        'uint256',
        'uint256',
        'uint256',
        'uint32',
        'bool',
      ],
      encodedInput,
    );

  const decodeExecuteCrossChain = (encodedInput: string) =>
    utils.defaultAbiCoder.decode(
      [
        'uint32',
        'address',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
        'address',
        'uint256',
        'address',
        'bytes',
      ],
      encodedInput,
    );

  it('encodes V3 exact in input with isUni flag', () => {
    const path = utils.solidityPack(
      ['address', 'uint24', 'address'],
      [ORIGIN_TOKEN, 500, BRIDGE_TOKEN],
    );

    const command = encodeV3SwapExactIn({
      recipient: UNIVERSAL_ROUTER,
      amountIn: BigNumber.from('1000000'),
      amountOutMinimum: BigNumber.from('900000'),
      path,
      payerIsUser: false,
      isUni: true,
    });

    const decoded = utils.defaultAbiCoder.decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool'],
      command.encodedInput,
    );

    expect(command.commandType).to.equal(Commands.V3_SWAP_EXACT_IN);
    expect(decoded[0]).to.equal(UNIVERSAL_ROUTER);
    expect(decoded[1].toString()).to.equal('1000000');
    expect(decoded[2].toString()).to.equal('900000');
    expect(decoded[3]).to.equal(path);
    expect(decoded[4]).to.equal(false);
    expect(decoded[5]).to.equal(true);
  });

  it('encodes execute cross-chain hook as address', () => {
    const command = encodeExecuteCrossChain({
      domain: 8453,
      icaRouter: ICA_ROUTER,
      remoteRouter: REMOTE_ICA_ROUTER,
      ism: ISM,
      commitment: utils.hexZeroPad('0x12', 32),
      msgFee: BigNumber.from('123'),
      token: BRIDGE_TOKEN,
      tokenFee: BigNumber.from('45'),
      hook: UNIVERSAL_ROUTER,
      hookMetadata: '0x1234',
    });

    const decoded = utils.defaultAbiCoder.decode(
      [
        'uint32',
        'address',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
        'address',
        'uint256',
        'address',
        'bytes',
      ],
      command.encodedInput,
    );

    expect(command.commandType).to.equal(Commands.EXECUTE_CROSS_CHAIN);
    expect(decoded[8]).to.equal(UNIVERSAL_ROUTER);
  });

  it('encodes zero-ish ISM as bytes32 zero', () => {
    const command = encodeExecuteCrossChain({
      domain: 8453,
      icaRouter: ICA_ROUTER,
      remoteRouter: REMOTE_ICA_ROUTER,
      ism: constants.AddressZero,
      commitment: utils.hexZeroPad('0x34', 32),
      msgFee: BigNumber.from('1'),
      token: BRIDGE_TOKEN,
      tokenFee: BigNumber.from('0'),
      hook: UNIVERSAL_ROUTER,
      hookMetadata: '0x',
    });

    const decoded = utils.defaultAbiCoder.decode(
      [
        'uint32',
        'address',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint256',
        'address',
        'uint256',
        'address',
        'bytes',
      ],
      command.encodedInput,
    );

    expect(decoded[3]).to.equal(constants.HashZero);
  });

  it('calculates total value for native swap + bridge + cross-chain', () => {
    const amount = BigNumber.from('1000000000000000000');
    const tx = buildSwapAndBridgeTx({
      originToken: ORIGIN_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount,
      recipient: UNIVERSAL_ROUTER,
      originDomain: 42161,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      icaRouterAddress: ICA_ROUTER,
      remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
      ismAddress: ISM,
      commitment: utils.hexZeroPad('0x34', 32),
      slippage: 0,
      isNativeOrigin: true,
      expectedSwapOutput: BigNumber.from('1000'),
      bridgeMsgFee: BigNumber.from('200'),
      bridgeTokenFee: BigNumber.from('10'),
      crossChainMsgFee: BigNumber.from('300'),
    });

    expect(tx.commands).to.equal('0x0b001213');
    expect(tx.inputs).to.have.length(4);
    expect(tx.value.toString()).to.equal(amount.add(500).toString());
  });

  it('defaults omitted ISM to bytes32 zero without throwing', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: ORIGIN_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 42161,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      icaRouterAddress: ICA_ROUTER,
      remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
      commitment: utils.hexZeroPad('0xab', 32),
      slippage: 0,
      expectedSwapOutput: BigNumber.from('2000'),
    });

    const decodedCrossChain = decodeExecuteCrossChain(tx.inputs[2]);
    expect(decodedCrossChain[3]).to.equal(constants.HashZero);
  });

  it('sizes no-swap bridge approval as amount plus token fee', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: BRIDGE_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 42161,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      slippage: 0,
      bridgeMsgFee: BigNumber.from('25'),
      bridgeTokenFee: BigNumber.from('7'),
    });

    expect(tx.commands).to.equal('0x12');
    expect(tx.inputs).to.have.length(1);

    const decodedBridge = decodeBridgeToken(tx.inputs[0]);
    expect(decodedBridge[4].toString()).to.equal('1000');
    expect(decodedBridge[6].toString()).to.equal('1007');
    expect(decodedBridge[8]).to.equal(true);
  });

  it('omits cross-chain command when includeCrossChainCommand is false', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: ORIGIN_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 42161,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      icaRouterAddress: ICA_ROUTER,
      remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
      commitment: utils.hexZeroPad('0x99', 32),
      slippage: 0,
      expectedSwapOutput: BigNumber.from('2000'),
      includeCrossChainCommand: false,
    });

    expect(tx.commands).to.equal('0x0012');
    expect(tx.inputs).to.have.length(2);
  });

  it('throws when includeCrossChainCommand is true without commitment', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 42161,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        icaRouterAddress: ICA_ROUTER,
        remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
        slippage: 0,
        expectedSwapOutput: BigNumber.from('2000'),
      }),
    ).to.throw('includeCrossChainCommand requires a non-empty commitment');
  });

  it('throws when cross-chain commitment is not bytes32', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 42161,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        icaRouterAddress: ICA_ROUTER,
        remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
        commitment: '0x1234',
        slippage: 0,
        expectedSwapOutput: BigNumber.from('2000'),
      }),
    ).to.throw('commitment must be a bytes32 hex string');
  });

  it('encodes swap path with custom poolParam and velodrome flavor', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: ORIGIN_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 10,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      slippage: 0,
      expectedSwapOutput: BigNumber.from('1000'),
      poolParam: 200,
      dexFlavor: 'velodrome-slipstream',
      includeCrossChainCommand: false,
    });

    const decodedSwap = utils.defaultAbiCoder.decode(
      ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool'],
      tx.inputs[0],
    );

    const expectedPath = utils.solidityPack(
      ['address', 'uint24', 'address'],
      [ORIGIN_TOKEN, 200, BRIDGE_TOKEN],
    );

    expect(decodedSwap[3]).to.equal(expectedPath);
    expect(decodedSwap[5]).to.equal(false);
  });

  it('throws for non-uint24 poolParam', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 10,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        slippage: 0,
        expectedSwapOutput: BigNumber.from('1000'),
        poolParam: 16_777_216,
      }),
    ).to.throw('poolParam must be a uint24 integer');
  });

  it('reserves cross-chain token fee from swap output', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: ORIGIN_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 10,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      icaRouterAddress: ICA_ROUTER,
      remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
      ismAddress: ISM,
      commitment: utils.hexZeroPad('0x88', 32),
      slippage: 0,
      expectedSwapOutput: BigNumber.from('5000'),
      bridgeTokenFee: BigNumber.from('125'),
      crossChainTokenFee: BigNumber.from('25'),
    });

    const decodedBridge = decodeBridgeToken(tx.inputs[1]);
    const decodedCrossChain = decodeExecuteCrossChain(tx.inputs[2]);

    // 5000 output - 125 bridge fee - 25 cross-chain fee
    expect(decodedBridge[4].toString()).to.equal('4850');
    // bridge token pull reserves the extra 25 for EXECUTE_CROSS_CHAIN
    expect(decodedBridge[6].toString()).to.equal('4975');
    expect(decodedCrossChain[7].toString()).to.equal('25');
  });

  it('adds cross-chain token fee on top of no-swap bridge approval', () => {
    const tx = buildSwapAndBridgeTx({
      originToken: BRIDGE_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      destinationToken: DESTINATION_TOKEN,
      amount: BigNumber.from('1000'),
      recipient: UNIVERSAL_ROUTER,
      originDomain: 10,
      destinationDomain: 8453,
      warpRouteAddress: WARP_ROUTE,
      universalRouterAddress: UNIVERSAL_ROUTER,
      icaRouterAddress: ICA_ROUTER,
      remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
      ismAddress: ISM,
      commitment: utils.hexZeroPad('0x77', 32),
      slippage: 0,
      bridgeTokenFee: BigNumber.from('7'),
      crossChainTokenFee: BigNumber.from('3'),
    });

    const decodedBridge = decodeBridgeToken(tx.inputs[0]);
    const decodedCrossChain = decodeExecuteCrossChain(tx.inputs[1]);

    expect(decodedBridge[4].toString()).to.equal('1000');
    // amount + bridge fee + cross-chain token fee reserve
    expect(decodedBridge[6].toString()).to.equal('1010');
    expect(decodedCrossChain[7].toString()).to.equal('3');
  });

  it('throws when cross-chain token fee exhausts swap output', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 10,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        icaRouterAddress: ICA_ROUTER,
        remoteIcaRouterAddress: REMOTE_ICA_ROUTER,
        commitment: utils.hexZeroPad('0x66', 32),
        slippage: 0,
        expectedSwapOutput: BigNumber.from('100'),
        bridgeTokenFee: BigNumber.from('90'),
        crossChainTokenFee: BigNumber.from('10'),
      }),
    ).to.throw(
      'expectedSwapOutput after slippage is insufficient to cover bridge and cross-chain token fees',
    );
  });

  it('throws when cross-chain token fee is provided while cross-chain command is disabled', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 10,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        slippage: 0,
        expectedSwapOutput: BigNumber.from('1200'),
        bridgeTokenFee: BigNumber.from('5'),
        crossChainTokenFee: BigNumber.from('5'),
        includeCrossChainCommand: false,
      }),
    ).to.throw(
      'crossChainTokenFee requires includeCrossChainCommand to be true',
    );
  });

  it('throws for invalid slippage bounds', () => {
    expect(() =>
      buildSwapAndBridgeTx({
        originToken: ORIGIN_TOKEN,
        bridgeToken: BRIDGE_TOKEN,
        destinationToken: DESTINATION_TOKEN,
        amount: BigNumber.from('1000'),
        recipient: UNIVERSAL_ROUTER,
        originDomain: 10,
        destinationDomain: 8453,
        warpRouteAddress: WARP_ROUTE,
        universalRouterAddress: UNIVERSAL_ROUTER,
        slippage: 1,
      }),
    ).to.throw('slippage must be >= 0 and < 1');
  });
});
