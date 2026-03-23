import { expect } from 'chai';

import { ArtifactState } from '@hyperlane-xyz/provider-sdk/artifact';
import { MailboxOnChain } from '@hyperlane-xyz/provider-sdk/mailbox';
import { RawValidatorAnnounceConfig } from '@hyperlane-xyz/provider-sdk/validator-announce';
import { assert } from '@hyperlane-xyz/utils';

import { RadixSigner } from '../clients/signer.js';
import { RadixMailboxArtifactManager } from '../mailbox/mailbox-artifact-manager.js';
import {
  DEFAULT_E2E_TEST_TIMEOUT,
  TEST_RADIX_BURN_ADDRESS,
  TEST_RADIX_DEPLOYER_ADDRESS,
  TEST_RADIX_PRIVATE_KEY,
} from '../testing/constants.js';
import { RadixValidatorAnnounceArtifactManager } from '../validator-announce/validator-announce-artifact-manager.js';

import { DEPLOYED_TEST_CHAIN_METADATA } from './e2e-test.setup.js';

describe('Radix ValidatorAnnounce (e2e)', function () {
  this.timeout(DEFAULT_E2E_TEST_TIMEOUT);

  let radixSigner: RadixSigner;
  let artifactManager: RadixValidatorAnnounceArtifactManager;
  let mailboxArtifactManager: RadixMailboxArtifactManager;

  // Will be set after creating a test mailbox
  let testMailboxAddress: string;

  const TEST_DOMAIN_ID = 999998;

  before(async () => {
    const rpcUrls =
      DEPLOYED_TEST_CHAIN_METADATA.rpcUrls?.map((url) => url.http) ?? [];
    assert(rpcUrls.length > 0, 'Expected at least 1 rpc url for the tests');

    radixSigner = (await RadixSigner.connectWithSigner(
      rpcUrls,
      TEST_RADIX_PRIVATE_KEY,
      {
        metadata: {
          chainId: DEPLOYED_TEST_CHAIN_METADATA.chainId,
          gatewayUrls: DEPLOYED_TEST_CHAIN_METADATA.gatewayUrls,
          packageAddress: DEPLOYED_TEST_CHAIN_METADATA.packageAddress,
        },
      },
    )) as RadixSigner;

    const gateway = (radixSigner as any).gateway;
    const base = (radixSigner as any).base;
    artifactManager = new RadixValidatorAnnounceArtifactManager(gateway, base);
    mailboxArtifactManager = new RadixMailboxArtifactManager(
      gateway,
      base,
      TEST_DOMAIN_ID,
    );

    // Create a test mailbox for validator announce to reference
    const mailboxConfig: MailboxOnChain = {
      owner: TEST_RADIX_DEPLOYER_ADDRESS,
      defaultIsm: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: TEST_RADIX_BURN_ADDRESS },
      },
      defaultHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: TEST_RADIX_BURN_ADDRESS },
      },
      requiredHook: {
        artifactState: ArtifactState.UNDERIVED,
        deployed: { address: TEST_RADIX_BURN_ADDRESS },
      },
    };

    const mailboxWriter = mailboxArtifactManager.createWriter(
      'mailbox',
      radixSigner,
    );
    const [deployedMailbox] = await mailboxWriter.create({
      config: mailboxConfig,
    });
    testMailboxAddress = deployedMailbox.deployed.address;
  });

  describe('ValidatorAnnounce Artifact Operations', () => {
    it('should create a validator announce contract', async () => {
      const config: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const writer = artifactManager.createWriter(
        'validatorAnnounce',
        radixSigner,
      );
      const [result, receipts] = await writer.create({ config });

      expect(result.artifactState).to.equal(ArtifactState.DEPLOYED);
      expect(result.config.mailboxAddress).to.equal(testMailboxAddress);
      expect(result.deployed.address).to.be.a('string').and.not.be.empty;
      expect(receipts).to.be.an('array').with.length(1);
    });

    it('should read a validator announce configuration from chain', async () => {
      const config: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const writer = artifactManager.createWriter(
        'validatorAnnounce',
        radixSigner,
      );
      const [deployedValidatorAnnounce] = await writer.create({ config });

      const reader = artifactManager.createReader('validatorAnnounce');
      const readValidatorAnnounce = await reader.read(
        deployedValidatorAnnounce.deployed.address,
      );

      expect(readValidatorAnnounce.artifactState).to.equal(
        ArtifactState.DEPLOYED,
      );
      expect(readValidatorAnnounce.config.mailboxAddress).to.equal(
        testMailboxAddress,
      );
      expect(readValidatorAnnounce.deployed.address).to.equal(
        deployedValidatorAnnounce.deployed.address,
      );
    });

    it('should return no transactions when calling update (immutable)', async () => {
      const config: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const writer = artifactManager.createWriter(
        'validatorAnnounce',
        radixSigner,
      );
      const [deployedValidatorAnnounce] = await writer.create({ config });

      // ValidatorAnnounce is immutable - update should return empty array
      const txs = await writer.update(deployedValidatorAnnounce);
      expect(txs).to.be.an('array').with.length(0);
    });

    it('should use readValidatorAnnounce convenience method', async () => {
      const config: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const writer = artifactManager.createWriter(
        'validatorAnnounce',
        radixSigner,
      );
      const [deployedValidatorAnnounce] = await writer.create({ config });

      // Use the convenience method
      const readValidatorAnnounce = await artifactManager.readValidatorAnnounce(
        deployedValidatorAnnounce.deployed.address,
      );

      expect(readValidatorAnnounce.artifactState).to.equal(
        ArtifactState.DEPLOYED,
      );
      expect(readValidatorAnnounce.config.mailboxAddress).to.equal(
        testMailboxAddress,
      );
      expect(readValidatorAnnounce.deployed.address).to.equal(
        deployedValidatorAnnounce.deployed.address,
      );
    });

    it('should create validator announce with same mailbox address', async () => {
      const config1: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const config2: RawValidatorAnnounceConfig = {
        mailboxAddress: testMailboxAddress,
      };

      const writer = artifactManager.createWriter(
        'validatorAnnounce',
        radixSigner,
      );

      const [result1] = await writer.create({ config: config1 });
      const [result2] = await writer.create({ config: config2 });

      // Different validator announce instances should have different addresses
      expect(result1.deployed.address).to.not.equal(result2.deployed.address);

      // But both should have the same mailbox address
      expect(result1.config.mailboxAddress).to.equal(
        result2.config.mailboxAddress,
      );
    });
  });
});
