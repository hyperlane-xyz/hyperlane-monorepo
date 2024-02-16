import { expect } from 'chai';
import fs from 'fs';
import path from 'path';
import { parse } from 'yaml';

import { chainMetadata } from '../consts/chainMetadata';
import { Chains } from '../consts/chains';
import { MultiProtocolProvider } from '../providers/MultiProtocolProvider';
import { Token } from '../token/Token';

import { WarpCore } from './WarpCore';

describe('WarpCore', () => {
  const multiProvider = new MultiProtocolProvider();
  let warpCore: WarpCore;

  it('Constructs', () => {
    const fromArgs = new WarpCore(multiProvider, [
      Token.FromChainMetadataNativeToken(chainMetadata[Chains.ethereum]),
    ]);
    const exampleConfig = parse(
      fs.readFileSync(
        path.join(__dirname, './example-warp-core-config.yaml'),
        'utf-8',
      ),
    );
    const fromConfig = WarpCore.FromConfig(multiProvider, exampleConfig);
    expect(!!fromArgs).to.be.true;
    expect(!!fromConfig).to.be.true;

    warpCore = fromConfig;
  });

  it('Finds tokens', () => {
    expect(warpCore.findToken('TODO', Chains.ethereum)).to.be.instanceOf(Token);
  });

  it('Gets transfer gas quote', () => {
    //TODO
  });

  it('Checks for approval', () => {
    //TODO
  });

  it('Checks for destination collateral', () => {
    //TODO
  });

  it('Validates transfers', () => {
    // const result = warpCore.validateTransfer()
    //TODO
  });

  it('Gets transfer remote txs', () => {
    //TODO
  });

  it('Finds tokens', () => {
    expect(warpCore.findToken('TODO', Chains.ethereum)).to.be.instanceOf(Token);
  });
});
