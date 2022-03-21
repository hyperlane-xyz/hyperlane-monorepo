import { ChainName, ProxiedAddress } from '../../types';

export const local: Partial<Record<ChainName, ProxiedAddress>> = {
  celo: {
    "proxy": "0xaC47e91215fb80462139756f43438402998E4A3a",
    "implementation": "0xeF31027350Be2c7439C1b0BE022d49421488b72C",
    "beacon": "0x12Bcb546bC60fF39F1Adfc7cE4605d5Bd6a6A876"
},
  ethereum: {
    "proxy": "0xaC9fCBA56E42d5960f813B9D0387F3D3bC003338",
    "implementation": "0x63fea6E447F120B8Faf85B53cdaD8348e645D80E",
    "beacon": "0xdFdE6B33f13de2CA1A75A6F7169f50541B14f75b"
},
  polygon: {
    "proxy": "0xd9140951d8aE6E5F625a02F5908535e16e3af964",
    "implementation": "0x54B8d8E2455946f2A5B8982283f2359812e815ce",
    "beacon": "0xf090f16dEc8b6D24082Edd25B1C8D26f2bC86128"
}
}
