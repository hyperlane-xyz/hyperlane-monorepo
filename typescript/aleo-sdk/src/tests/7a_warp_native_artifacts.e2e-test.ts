import chai from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { AltVM } from '@hyperlane-xyz/provider-sdk';
import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import type { DeployedRawWarpArtifact } from '@hyperlane-xyz/provider-sdk/warp';

import { isNullish } from '@hyperlane-xyz/utils';

import { AleoSigner } from '../clients/signer.js';
import { AleoHookArtifactManager } from '../hook/hook-artifact-manager.js';
import { AleoIsmArtifactManager } from '../ism/ism-artifact-manager.js';
import { AleoMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  TEST_ALEO_CHAIN_METADATA,
  TEST_ALEO_PRIVATE_KEY,
} from '../testing/constants.js';
import {
  ALEO_NULL_ADDRESS,
  fromAleoAddress,
  getProgramSuffix,
} from '../utils/helper.js';
import { AleoNetworkId } from '../utils/types.js';
import { AleoWarpArtifactManager } from '../warp/warp-artifact-manager.js';

import { warpArtifactTestSuite } from './warp-artifact-test-suite.js';

chai.use(chaiAsPromised);

describe('7a. Aleo Warp Native Token Artifact API (e2e)', function () {
  this.timeout(300_000);

  let aleoSigner: AleoSigner;
  let artifactManager: AleoWarpArtifactManager;
  let ismArtifactManager: AleoIsmArtifactManager;
  let hookArtifactManager: AleoHookArtifactManager;
  let mailboxAddress: string;
  let savedWarpSuffix: string | undefined;
  let preDeployedNativeToken: DeployedRawWarpArtifact;

  before(async () => {
    savedWarpSuffix = process.env['ALEO_WARP_SUFFIX'];
    delete process.env['ALEO_WARP_SUFFIX'];

    const domainId = 1234;
    aleoSigner = await AleoSigner.connectWithSigner(
      TEST_ALEO_CHAIN_METADATA,
      TEST_ALEO_PRIVATE_KEY,
    );

    const aleoClient = aleoSigner.getAleoClient();

    const ismManagerProgramId = await aleoSigner.getIsmManager();

    // Create ISM for mailbox
    ismArtifactManager = new AleoIsmArtifactManager(aleoClient);
    const ismWriter = ismArtifactManager.createWriter(
      AltVM.IsmType.TEST_ISM,
      aleoSigner,
    );
    const [ism] = await ismWriter.create({
      config: { type: AltVM.IsmType.TEST_ISM },
    });

    // Create mailbox using artifact manager
    const mailboxArtifactManager = new AleoMailboxArtifactManager(
      { domainId, aleoNetworkId: AleoNetworkId.TESTNET },
      aleoClient,
    );
    const mailboxWriter = mailboxArtifactManager.createWriter(
      'mailbox',
      aleoSigner,
    );
    const [deployedMailbox] = await mailboxWriter.create({
      config: {
        owner: aleoSigner.getSignerAddress(),
        defaultIsm: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ism.deployed.address },
        },
        defaultHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
        requiredHook: {
          artifactState: ArtifactState.UNDERIVED,
          deployed: { address: ALEO_NULL_ADDRESS },
        },
      },
    });
    mailboxAddress = deployedMailbox.deployed.address;

    const { programId } = fromAleoAddress(mailboxAddress);
    const suffix = getProgramSuffix(programId);
    const hookManagerProgramId = await aleoSigner.getHookManager(suffix);

    hookArtifactManager = new AleoHookArtifactManager(
      aleoClient,
      mailboxAddress,
    );

    artifactManager = new AleoWarpArtifactManager(aleoClient, {
      ismManagerAddress: ismManagerProgramId,
      hookManagerAddress: hookManagerProgramId,
    });

    // Deploy native token once — it always uses the fixed program name
    // test_hyp_warp_token_credits.aleo, so all tests share it.
    const nativeWriter = artifactManager.createWriter(
      AltVM.TokenType.native,
      aleoSigner,
    );
    [preDeployedNativeToken] = await nativeWriter.create({
      config: {
        type: AltVM.TokenType.native,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      },
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
      ismArtifactManager,
      hookArtifactManager,
      mailboxAddress,
      preDeployedToken: preDeployedNativeToken,
    }),
    {
      type: AltVM.TokenType.native,
      name: 'native',
      getConfig: () => ({
        type: AltVM.TokenType.native,
        owner: aleoSigner.getSignerAddress(),
        mailbox: mailboxAddress,
        remoteRouters: {},
        destinationGas: {},
      }),
    },
  );
});
