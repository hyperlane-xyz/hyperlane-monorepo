import { expect } from 'chai';
import { BigNumber, ethers } from 'ethers';

import {
  DomainRoutingHook__factory,
  MovableCollateralRouter__factory,
} from '@hyperlane-xyz/core';
import { TokenStandard } from '@hyperlane-xyz/sdk';
import { readYaml } from '@hyperlane-xyz/utils/fs';

import { GovernTransactionReader } from '../src/tx/govern-transaction-reader.js';

const ETHEREUM = 'ethereum';
const POLYGON_DOMAIN = 137;

const ADDRESSES = {
  hook: '0x1111111111111111111111111111111111111111',
  hookTarget: '0x2222222222222222222222222222222222222222',
  warpRoute: '0x3333333333333333333333333333333333333333',
  multisend: '0x4444444444444444444444444444444444444444',
  mailbox: '0x5555555555555555555555555555555555555555',
  proxyAdmin: '0x6666666666666666666666666666666666666666',
  icaRouter: '0x7777777777777777777777777777777777777777',
};

const domainToChain: Record<number, string> = {
  1: ETHEREUM,
  [POLYGON_DOMAIN]: 'polygon',
};

function createReader() {
  const multiProvider = {
    getNativeToken: async () => ({
      decimals: 18,
      symbol: 'ETH',
    }),
    getProvider: () => ({
      getCode: async () => '0x',
    }),
    getChainName: (domain: number) => {
      const chain = domainToChain[domain];
      if (!chain) throw new Error(`Unknown domain ${domain}`);
      return chain;
    },
    tryGetChainName: (domain: number) => domainToChain[domain],
  };

  return new GovernTransactionReader(
    'mainnet3' as any,
    multiProvider as any,
    {
      [ETHEREUM]: {
        interchainAccountRouter: ADDRESSES.icaRouter,
        legacyInterchainAccountRouter: ADDRESSES.icaRouter,
        mailbox: ADDRESSES.mailbox,
        proxyAdmin: ADDRESSES.proxyAdmin,
      },
    } as any,
    {} as any,
    {},
    {},
    {},
    {},
    {},
  );
}

function registerWarpRoute(reader: GovernTransactionReader) {
  reader.warpRouteIndex[ETHEREUM] = {
    [ADDRESSES.warpRoute.toLowerCase()]: {
      addressOrDenom: ADDRESSES.warpRoute,
      chainName: ETHEREUM,
      decimals: 18,
      name: 'Test Token',
      standard: TokenStandard.EvmHypCollateral,
      symbol: 'TST',
    } as any,
  };
}

function encodeMultiSendTransaction(tx: {
  operation: number;
  to: string;
  value: BigNumber;
  data: string;
}) {
  const operation = ethers.utils.hexZeroPad(
    ethers.utils.hexlify(tx.operation),
    1,
  );
  const to = tx.to.toLowerCase();
  const value = ethers.utils.hexZeroPad(tx.value.toHexString(), 32);
  const dataLength = ethers.utils.hexZeroPad(
    ethers.utils.hexlify(ethers.utils.arrayify(tx.data).length),
    32,
  );
  return `${operation.slice(2)}${to.slice(2)}${value.slice(2)}${dataLength.slice(
    2,
  )}${tx.data.slice(2)}`;
}

function encodeMultiSend(
  txs: Parameters<typeof encodeMultiSendTransaction>[0][],
) {
  const multisendInterface = new ethers.utils.Interface([
    'function multiSend(bytes transactions)',
  ]);
  return multisendInterface.encodeFunctionData('multiSend', [
    `0x${txs.map(encodeMultiSendTransaction).join('')}`,
  ]);
}

describe('GovernTransactionReader', () => {
  it('dispatches through ordered governance decoders', () => {
    const reader = createReader();
    expect(reader.decoderIds).to.deep.equal([
      'ownable',
      'safe',
      'ica',
      'mailbox',
      'timelock',
      'multisend',
      'erc20',
      'warp-module',
      'managed-lockbox',
      'xerc20',
      'fee-contract',
      'known-hyperlane-abi-fallback',
      'proxy-admin',
      'native-token-transfer',
    ]);
  });

  it('matches golden output for selector fallback and overloaded router calls', async () => {
    const reader = createReader();
    registerWarpRoute(reader);

    const routingHookInterface = DomainRoutingHook__factory.createInterface();
    const movableRouterInterface =
      MovableCollateralRouter__factory.createInterface();

    const knownFallback = await reader.read(ETHEREUM, {
      to: ADDRESSES.hook,
      data: routingHookInterface.encodeFunctionData('setHook(uint32,address)', [
        POLYGON_DOMAIN,
        ADDRESSES.hookTarget,
      ]),
      value: BigNumber.from(0),
    });

    const scalarDestinationGas = await reader.read(ETHEREUM, {
      to: ADDRESSES.warpRoute,
      data: movableRouterInterface.encodeFunctionData(
        'setDestinationGas(uint32,uint256)',
        [1, BigNumber.from(68000)],
      ),
      value: BigNumber.from(0),
    });

    const golden = readYaml<Record<string, unknown>>(
      new URL(
        './fixtures/govern-transaction-reader/golden.yaml',
        import.meta.url,
      ).pathname,
    );

    expect({ knownFallback, scalarDestinationGas }).to.deep.equal(golden);
  });

  it('records recoverable nested multisend decode failures as warnings', async () => {
    const reader = createReader();
    registerWarpRoute(reader);
    reader.multiSendDeployments.push(ADDRESSES.multisend);

    const result = await reader.read(ETHEREUM, {
      to: ADDRESSES.multisend,
      data: encodeMultiSend([
        {
          operation: 0,
          to: ADDRESSES.warpRoute,
          value: BigNumber.from(0),
          data: '0xdeadbeef',
        },
      ]),
      value: BigNumber.from(0),
    });

    expect(result.multisends[0].decoded.insight).to.match(/failed to decode/);
    expect(reader.errors).to.deep.equal([]);
    expect(reader.warnings).to.have.lengthOf(1);
    expect(reader.warnings[0].info).to.equal(
      'Could not decode nested multisend call',
    );
  });

  it('does not swallow non-decode programmer errors in nested multisends', async () => {
    const reader = createReader() as any;

    reader.decoders = [
      {
        id: 'buggy-test-decoder',
        priority: 0,
        match: () => true,
        decode: async () => {
          throw new TypeError('programmer bug');
        },
      },
    ];

    try {
      await reader.readMultisendTransaction(ETHEREUM, {
        to: ADDRESSES.multisend,
        data: encodeMultiSend([
          {
            operation: 0,
            to: ADDRESSES.hook,
            value: BigNumber.from(0),
            data: '0xdeadbeef',
          },
        ]),
        value: BigNumber.from(0),
      });
      expect.fail('Expected nested TypeError to be rethrown');
    } catch (error) {
      expect(error).to.be.instanceOf(TypeError);
      expect((error as Error).message).to.equal('programmer bug');
    }
  });
});
