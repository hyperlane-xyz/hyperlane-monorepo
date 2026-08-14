import { expect } from 'chai';

import { ProtocolType } from '@hyperlane-xyz/utils';

import { ChainMetadata } from '../metadata/chainMetadataTypes.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { TokenType } from '../token/config.js';
import { WarpRouteDeployConfigMailboxRequired } from '../token/types.js';

import { assertWarpConfigTimelocksSupportedByProtocols } from './warp.js';

const MAILBOX = '0x2222222222222222222222222222222222222222';
const OWNER = '0x3333333333333333333333333333333333333333';

const ethereum: ChainMetadata = {
  chainId: 1,
  domainId: 1,
  name: 'ethereum',
  protocol: ProtocolType.Ethereum,
  rpcUrls: [{ http: 'http://ethereum.example.com' }],
};

const solana: ChainMetadata = {
  chainId: 1399811149,
  domainId: 1399811149,
  name: 'solana',
  protocol: ProtocolType.Sealevel,
  rpcUrls: [{ http: 'http://solana.example.com' }],
};

describe(assertWarpConfigTimelocksSupportedByProtocols.name, () => {
  it('rejects AltVM timelock config before deploy/apply side effects', () => {
    const multiProvider = new MultiProvider({ ethereum, solana });
    const warpDeployConfig: WarpRouteDeployConfigMailboxRequired = {
      ethereum: {
        mailbox: MAILBOX,
        owner: OWNER,
        type: TokenType.native,
      },
      solana: {
        mailbox: MAILBOX,
        owner: OWNER,
        timelock: {
          delay: 1,
          roles: {
            executor: OWNER,
            proposer: OWNER,
          },
        },
        type: TokenType.native,
      },
    };

    expect(() =>
      assertWarpConfigTimelocksSupportedByProtocols({
        multiProvider,
        warpDeployConfig,
      }),
    ).to.throw("Timelock config is not supported on Alt-VM chain 'solana'");
  });
});
