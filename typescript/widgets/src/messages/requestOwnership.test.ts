import { expect } from 'chai';
import { mock } from 'node:test';
import { createElement } from 'react';
import { act, create, ReactTestRenderer } from 'react-test-renderer';
import { providers } from 'ethers';

import { MultiProvider, testChainMetadata } from '@hyperlane-xyz/sdk';
import { protocolToDefaultProviderBuilder } from '@hyperlane-xyz/sdk/providers/defaultProviderBuilderMaps';
import { ProviderType } from '@hyperlane-xyz/sdk/providers/ProviderType';
import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainConnectionType } from '../chains/types.js';
import { useConnectionHealthTest } from '../utils/useChainConnectionTest.js';
import { MessageStage, MessageStatus, PartialMessage } from './types.js';
import { useMessage } from './useMessage.js';
import { useMessageStage } from './useMessageStage.js';

describe('widget request identity', () => {
  let renderer: ReactTestRenderer | undefined;
  beforeEach(() => {
    mock.timers.enable({ apis: ['setInterval'] });
  });
  afterEach(async () => {
    await act(async () => {
      renderer?.unmount();
    });
    renderer = undefined;
    mock.restoreAll();
    mock.timers.reset();
  });

  it('fetches a new message after the previous message was delivered', async () => {
    let latest: ReturnType<typeof useMessage> | undefined;
    const urls: string[] = [];
    mock.method(globalThis, 'fetch', async (input) => {
      urls.push(String(input));
      return Response.json({
        result: [
          {
            id: urls.length === 1 ? 'first' : 'second',
            status: MessageStatus.Delivered,
          },
        ],
      });
    });
    function Probe(props: { messageId: string }) {
      latest = useMessage({
        ...props,
        explorerApiUrl: 'https://explorer.invalid',
        retryInterval: 100,
      });
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Probe, { messageId: 'first' }));
    });
    expect(latest?.data?.id).to.equal('first');
    await act(async () => {
      mock.timers.tick(1000);
    });
    expect(urls).to.have.length(1);
    await act(async () => {
      renderer?.update(createElement(Probe, { messageId: 'second' }));
    });
    expect(latest?.data?.id).to.equal('second');
    expect(urls[1]).to.contain('id=second');
  });

  it('does not reuse a previous message validated stage or an old response', async () => {
    let latest: ReturnType<typeof useMessageStage> | undefined;
    let release: (response: Response) => void = () => {
      throw new Error('Request not started');
    };
    let requests = 0;
    mock.method(globalThis, 'fetch', async () => {
      requests++;
      if (requests === 1) return Response.json({ nonce: 10 });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const multiProvider = MultiProvider.createTestMultiProvider();
    const first: PartialMessage = {
      status: MessageStatus.Pending,
      nonce: 1,
      originChainId: Number(testChainMetadata.test1.chainId),
      originDomainId: multiProvider.getDomainId('test1'),
      destinationChainId: Number(testChainMetadata.test2.chainId),
      destinationDomainId: multiProvider.getDomainId('test2'),
      origin: { blockNumber: 10, timestamp: 1000 },
    };
    function Probe(props: { message: PartialMessage }) {
      latest = useMessageStage({
        message: props.message,
        multiProvider,
        retryInterval: 100,
      });
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Probe, { message: first }));
    });
    expect(latest?.stage).to.equal(MessageStage.Validated);
    await act(async () => {
      renderer?.update(
        createElement(Probe, { message: { ...first, nonce: 20 } }),
      );
    });
    expect(requests).to.equal(2);
    expect(latest?.stage).to.equal(MessageStage.Sent);
    expect(latest?.isLoading).to.equal(true);
    await act(async () => {
      release(Response.json({ nonce: 30 }));
    });
    expect(latest?.stage).to.equal(MessageStage.Validated);
    expect(latest?.isLoading).to.equal(false);
  });

  it('resets health on endpoint changes and ignores the old endpoint completion', async () => {
    let latest: boolean | undefined;
    let finishOld: (height: number) => void = () => {
      throw new Error('Old health request not started');
    };
    const oldProvider = new providers.JsonRpcProvider();
    const newProvider = new providers.JsonRpcProvider();
    mock.method(
      oldProvider,
      'getBlockNumber',
      () =>
        new Promise<number>((resolve) => {
          finishOld = resolve;
        }),
    );
    mock.method(newProvider, 'getBlockNumber', async () => 5);
    let created = 0;
    mock.method(
      protocolToDefaultProviderBuilder,
      ProtocolType.Ethereum,
      () => ({
        type: ProviderType.EthersV5,
        provider: created++ === 0 ? oldProvider : newProvider,
      }),
    );
    function Probe(props: { index: number }) {
      latest = useConnectionHealthTest(
        testChainMetadata.test1,
        props.index,
        ChainConnectionType.RPC,
      );
      return null;
    }
    await act(async () => {
      renderer = create(createElement(Probe, { index: 0 }));
    });
    expect(latest).to.equal(undefined);
    await act(async () => {
      renderer?.update(createElement(Probe, { index: 1 }));
    });
    expect(latest).to.equal(true);
    await act(async () => {
      finishOld(0);
    });
    expect(latest).to.equal(true);
  });
});
