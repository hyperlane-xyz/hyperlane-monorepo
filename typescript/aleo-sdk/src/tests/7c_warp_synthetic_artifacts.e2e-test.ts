import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';

import { isNullish } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import { fromAleoAddress, getProgramSuffix } from '../utils/helper.js';
import { AleoWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { warpArtifactTestSuite } from './warp-artifact-test-suite.js';

chai.use(chaiAsPromised);

describe('7c. Aleo Warp Synthetic Token Artifact API (e2e)', function () {
  this.timeout(300_000);

  let aleoSigner: AleoSigner;
  let artifactManager: AleoWarpArtifactManager;
  let mailboxAddress: string;
  let savedWarpSuffix: string | undefined;

  before(async () => {
    savedWarpSuffix = process.env['ALEO_WARP_SUFFIX'];
    delete process.env['ALEO_WARP_SUFFIX'];

    aleoSigner = await AleoSigner.connectWithSigner(
      [TEST_ALEO_CHAIN_METADATA.rpcUrl],
      TEST_ALEO_PRIVATE_KEY,
      { metadata: { chainId: 1 } },
    );

    const ismManagerProgramId = await aleoSigner.getIsmManager();

    const mailbox = await aleoSigner.createMailbox({ domainId: 1234 });
    mailboxAddress = mailbox.mailboxAddress;

    const { programId } = fromAleoAddress(mailboxAddress);
    const suffix = getProgramSuffix(programId);
    const hookManagerProgramId = await aleoSigner.getHookManager(suffix);

    const aleoClient = aleoSigner.getAleoClient();
    artifactManager = new AleoWarpArtifactManager(aleoClient, {
      ismManagerAddress: ismManagerProgramId,
      hookManagerAddress: hookManagerProgramId,
    });
  });

  after(() => {
    if (!isNullish(savedWarpSuffix)) {
      process.env['ALEO_WARP_SUFFIX'] = savedWarpSuffix;
    }
  });

  warpArtifactTestSuite(
    () => ({
      aleoSigner,
      providerSdkSigner: aleoSigner,
      artifactManager,
      mailboxAddress,
    }),
    {
      type: AltVM.TokenType.synthetic,
      name: 'synthetic',
      getConfig: () => ({
        type: AltVM.TokenType.synthetic,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
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
    },
  );
});
