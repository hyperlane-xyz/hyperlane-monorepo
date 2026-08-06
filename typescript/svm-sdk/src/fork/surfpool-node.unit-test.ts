import { expect } from 'chai';
import { describe, it } from 'mocha';

import {
  SURFPOOL_DATASOURCE_RPC_URL_ENV,
  SolanaCluster,
  type SurfpoolNodeConfig,
  SurfpoolDatasourceMode,
  buildSurfpoolArgs,
  buildSurfpoolDatasourceEnv,
} from './surfpool-node.js';

const FORK_URL = 'https://user:secret@rpc.example/mainnet';

function baseConfig(): SurfpoolNodeConfig {
  return {
    datasource: { mode: SurfpoolDatasourceMode.Fork, rpcUrl: FORK_URL },
    rpcPort: 8899,
  };
}

describe('buildSurfpoolArgs', () => {
  it('keeps the fork datasource URL out of the argv', () => {
    const config = baseConfig();
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.not.include('--rpc-url');
    expect(args.some((arg) => arg.includes(FORK_URL))).to.equal(false);
    expect(args).to.include('--port');
    expect(args).to.include('8899');
  });

  it('passes network datasources via --network', () => {
    const config: SurfpoolNodeConfig = {
      datasource: {
        mode: SurfpoolDatasourceMode.Network,
        network: SolanaCluster.Mainnet,
      },
      rpcPort: 8899,
    };
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.include('--network');
    expect(args).to.include(SolanaCluster.Mainnet);
  });

  it('passes offline datasources via --offline', () => {
    const config: SurfpoolNodeConfig = {
      datasource: { mode: SurfpoolDatasourceMode.Offline },
      rpcPort: 8899,
    };
    const args = buildSurfpoolArgs(config, config.datasource, '127.0.0.1');

    expect(args).to.include('--offline');
  });
});

describe('buildSurfpoolDatasourceEnv', () => {
  it('exposes the fork datasource URL via the datasource env var', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Fork,
      rpcUrl: FORK_URL,
    });

    expect(env).to.deep.equal({
      [SURFPOOL_DATASOURCE_RPC_URL_ENV]: FORK_URL,
    });
  });

  it('returns an empty env for network datasources', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Network,
      network: SolanaCluster.Mainnet,
    });

    expect(env).to.deep.equal({});
  });

  it('returns an empty env for offline datasources', () => {
    const env = buildSurfpoolDatasourceEnv({
      mode: SurfpoolDatasourceMode.Offline,
    });

    expect(env).to.deep.equal({});
  });
});
