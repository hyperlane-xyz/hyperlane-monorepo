import { deserializeUnchecked } from 'borsh';
import { expect } from 'chai';

import { SealevelAccountDataWrapper } from '../../sealevel/serialization';
import {
  SealevelHyperlaneTokenData,
  SealevelHyperlaneTokenDataSchema,
} from '../../sealevel/tokenSerialization';

// Copied from the warp token router program on Solana devnet
const RAW_ACCOUNT_INFO =
  '01ff3a280e8466d26bc4e1a5d3d17e73f7b307c082156dd0ffbf8c5f9ae75506d6f14aed87b9d3a2bb5effdbdcd1af363555ff8b6c1311a93c495e6bc722284d2574fb061201834a2fa1c8f03eb3abdb50add98888fc64ae395cf2808372c6955bb30a70a9ba00000200000061000000a009010000000000c2570100e0ab000000000000020000006100000000000000000000000000000031b5234a896fbc4bc5555bad0783c220911b9ef59cfdbcef06ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a9e92839550965ffd4d64acaaf46d45df7318e5b4f57c90c487d60625d829b837b256d8b6f7c1f678a52ef123ddc35c248fcc1e1895e5b8c6d5e6dd381f8090a48fffe00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

const OWNER_PUB_KEY = '9qW26hiULf6bNApZpKBfxUqmbWHj1G43Skw7vFC1nmWH';

describe('SealevelRouterAdapter', () => {
  describe('account info', () => {
    it('correctly deserializes router account info', () => {
      const rawData = Buffer.from(RAW_ACCOUNT_INFO, 'hex');
      const wrappedData = deserializeUnchecked(
        SealevelHyperlaneTokenDataSchema,
        SealevelAccountDataWrapper,
        rawData,
      );
      expect(wrappedData.initialized).to.eql(1);
      const data = wrappedData.data as SealevelHyperlaneTokenData;
      expect(data.decimals).to.eql(6);
      expect(data.owner_pub_key?.toBase58()).to.eql(OWNER_PUB_KEY);
      expect(data.remote_router_pubkeys.size).to.eql(2);
    });
  });
});
