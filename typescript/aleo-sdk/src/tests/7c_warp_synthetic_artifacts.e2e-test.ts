import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import { AleoSigner } from '../clients/signer.js';
import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import { fromAleoAddress, getProgramSuffix } from '../utils/helper.js';
import { AleoWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import {
  type WarpTestSuiteContext,
  warpArtifactTestSuite,
} from './warp-artifact-test-suite.js';

chai.use(chaiAsPromised);

describe('7c. Aleo Warp Synthetic Token Artifact API (e2e)', function () {
  this.timeout(300_000);

  const ctx = {} as WarpTestSuiteContext;

  before(async () => {
    delete process.env['ALEO_WARP_SUFFIX'];

    const aleoSigner = (await AleoSigner.connectWithSigner(
      [TEST_ALEO_CHAIN_METADATA.rpcUrl],
      TEST_ALEO_PRIVATE_KEY,
      { metadata: { chainId: 1 } },
    )) as AleoSigner;

    ctx.aleoSigner = aleoSigner;
    ctx.providerSdkSigner = aleoSigner;

    const ismManagerProgramId = await aleoSigner.getIsmManager();

    const mailbox = await aleoSigner.createMailbox({ domainId: 1234 });
    ctx.mailboxAddress = mailbox.mailboxAddress;

    const { programId } = fromAleoAddress(ctx.mailboxAddress);
    const suffix = getProgramSuffix(programId);
    const hookManagerProgramId = await aleoSigner.getHookManager(suffix);

    const aleoClient = (aleoSigner as any).aleoClient;
    ctx.artifactManager = new AleoWarpArtifactManager(aleoClient, {
      ismManagerAddress: ismManagerProgramId,
      hookManagerAddress: hookManagerProgramId,
    });
  });

  warpArtifactTestSuite(ctx, {
    type: AltVM.TokenType.synthetic,
    name: 'synthetic',
    getConfig: () => ({
      type: AltVM.TokenType.synthetic,
      owner: ctx.aleoSigner.getSignerAddress(),
      mailbox: ctx.mailboxAddress,
      name: 'Synthetic Token',
      symbol: 'SYNTH',
      decimals: 18,
      remoteRouters: {},
      destinationGas: {},
    }),
    expectedFields: {
      name: 'Synthetic Token',
      symbol: 'SYNTH',
      decimals: 18,
    },
  });
});
