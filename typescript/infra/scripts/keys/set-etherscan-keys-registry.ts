import { getRegistry } from '@hyperlane-xyz/registry/fs';

import { DEFAULT_REGISTRY_URI } from '../../config/registry.js';

async function setEtherscanKeys() {
  // Local registry
  const registry = getRegistry({
    registryUris: [DEFAULT_REGISTRY_URI],
    enableProxy: false,
  });

  const explorerApiKeys = {
    celo: 'IC1UCY8JWIYFWGPCEEE58HKFIFEVN73PVV',
    polygon: 'ZPAHJ5A73MC45WJED98YJX4MKJE1UGN8D1',
    polygonzkevm: 'P8765WMUM4KAM9NPNAY49EACATYC4927HK',
    scroll: '8MU9QJVN429TEYSCMB68NC5MG4VM542CFW',
    base: 'R8CVTG7HDJYD5JDV2GSD5TGQH3J2KJDSSY',
    ethereum: 'CYUPN3Q66JIMRGQWYUDXJKQH4SX8YIYZMW',
    arbitrum: 'QAI5SWBNHJSFAN6KMS9RC5JGFKV2IYD2Z5',
    avalanche: 'NIF3616T2AP6EHYWIHJEKR1HCMA2K7D96X',
    bsc: 'NXSXUUUAUDD5SYGQUIVS9TZTBCEG6X5THY',
    optimism: 'JMYR3W6HHVPQ1HH8T6W8HSZVG88IH3MHRU',
    sepolia: 'CYUPN3Q66JIMRGQWYUDXJKQH4SX8YIYZMW',
    moonbeam: 'DDAT4TGIUSSV8MR489UJ21R34WGA1MM2GG',
    gnosis: '98A32SWJE876CHG95TMFRC5H5SBBX9GHAG',
    fraxtal: 'X3G6FVJU5VEZXVNQFRX52EQ5FEVP8IPR6F',
    linea: 'ZCA9836XUX1XPAACHK4BMMYTIFMHIGU8VN',
    sei: '487e1ac5-03f4-4473-9e73-cee721b782b5',
    taiko: '1CDVSH9KFUVPSFGD1EUFNHD18FUH484IEK',
    cronos: 'TN462TRF5Y4CZA7WDPS7XTF48JT2IKQFUX',
    arbitrumsepolia: 'QAI5SWBNHJSFAN6KMS9RC5JGFKV2IYD2Z5',
    basesepolia: 'R8CVTG7HDJYD5JDV2GSD5TGQH3J2KJDSSY',
    optimismsepolia: 'JMYR3W6HHVPQ1HH8T6W8HSZVG88IH3MHRU',
    sonic: 'V9PP7AFQF5Q6GJSQQ5YS2UBN7GI8QCA443',
    sonicblaze: 'V9PP7AFQF5Q6GJSQQ5YS2UBN7GI8QCA443',
    unichain: 'MUPHYQXB8A6GEEKKYA95N7WENSHYTU1UQQ',
    worldchain: 'BA89EI7MB9Z88UBURAYPRRRUKCQJB96KAE',
    opbnb: 'GK47JUUDX17PHP8XQ947IYTTPHP6FTAQMK',
  };

  for (const [chain, apiKey] of Object.entries(explorerApiKeys)) {
    const metadata = await registry.getChainMetadata(chain);
    if (!metadata) {
      console.log(`metadata not found for chain ${chain}`);
      continue;
    }
    console.log(`Explorer URL: ${metadata.blockExplorers![0].url}`);
    metadata.blockExplorers![0].apiKey = apiKey;
    await registry.updateChain({
      chainName: chain,
      metadata: metadata,
    });
  }
}

setEtherscanKeys().then(console.log).catch(console.error);
