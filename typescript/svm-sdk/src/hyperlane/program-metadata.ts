/**
 * Auto-generated SHA-256 hashes and byte lengths for the compiled .so binaries
 * embedded by this package.
 * DO NOT EDIT — regenerate with:
 *   pnpm -C typescript/svm-sdk program:build
 *   pnpm -C typescript/svm-sdk program:generate
 */

export const HYPERLANE_SVM_PROGRAM_METADATA = {
  mailbox: {
    byteLength: 176640,
    sha256: '6a2d1c5dc57c4ec07fd6537540fe118630afe669274dbdfc58e1e0dfac4e79dc',
  },
  igp: {
    byteLength: 359120,
    sha256: '5f15b28868cda88e274ca6785986152a7394e5d7f125ee8dba50cda2b243d982',
  },
  multisigIsm: {
    byteLength: 165976,
    sha256: '738e9764d7db278c11953aa19ef86ae583715eda67e79d8db2d0c25b2534afbc',
  },
  testIsm: {
    byteLength: 94600,
    sha256: 'ec963b4f0128deb0209f35dbf42d330dd86c12550e45d2520a2dc49671d8ec9f',
  },
  compositeIsm: {
    byteLength: 263904,
    sha256: 'da4eeb5126d483644af955057f27d1c4e586eb9467f6be72042814766865f5b4',
  },
  validatorAnnounce: {
    byteLength: 130008,
    sha256: 'c4cb36856993e192613875a72da4a1cfa4e7b9ce74ddd3c1368b599346a34a53',
  },
  tokenSynthetic: {
    byteLength: 402856,
    sha256: '2ca96fb5e6d4ec0ae93a2fa84c0dd8444d7e8cb029b055fb5a207ab854edb846',
  },
  tokenNative: {
    byteLength: 378040,
    sha256: '66a9b15cb7bc7212ebc5b9ae968473e5b776e8424d0f81d17106c072d983bd40',
  },
  tokenCollateral: {
    byteLength: 405000,
    sha256: 'a4c330b5a507676f584d39af7e1b2e30843387261f7ac859f2d226067ec5d771',
  },
  tokenCrossCollateral: {
    byteLength: 525384,
    sha256: '26853708e8e50c11ade3a9b8b71182ef0cfceb26622f4ae4816c6fabb8462905',
  },
  tokenFee: {
    byteLength: 349344,
    sha256: '8df709b58ded33fc780ca49c5b1dd37017ed45e427ad1955d708dcd982c6723e',
  },
} as const;

export type HyperlaneSvmProgramMetadataKey =
  keyof typeof HYPERLANE_SVM_PROGRAM_METADATA;
