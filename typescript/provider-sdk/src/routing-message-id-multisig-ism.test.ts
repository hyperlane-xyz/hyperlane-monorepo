import { expect } from 'chai';

import { ZERO_ADDRESS_HEX_32 } from '@hyperlane-xyz/utils';

import { IsmType as AltVMIsmType } from './altvm.js';
import { ArtifactState } from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  DeployedIsmArtifact,
  DomainMultisigConfig,
  IsmArtifactConfig,
  IsmConfig,
  IsmType,
  RoutingMessageIdMultisigIsmArtifactConfig,
  STATIC_ISM_TYPES,
  altVMIsmTypeToProviderSdkType,
  ismArtifactToDerivedConfig,
  ismConfigToArtifact,
  mergeIsmArtifacts,
  shouldDeployNewIsm,
} from './ism.js';

const chainLookup: ChainLookup = {
  getChainMetadata: () => {
    throw new Error('not needed');
  },
  getDomainId: (chain) => {
    if (chain === 'solanamainnet') return 1399811149;
    if (chain === 'ethereum') return 1;
    if (chain === 'polygon') return 137;
    return null;
  },
  getChainName: (domainId: number) => {
    if (domainId === 1399811149) return 'solanamainnet';
    if (domainId === 1) return 'ethereum';
    if (domainId === 137) return 'polygon';
    return null;
  },
  getKnownChainNames: () => ['solanamainnet', 'ethereum', 'polygon'],
  getKnownDomainIds: () => new Set([1399811149, 1, 137]),
};

const OWNER = 'Vote111111111111111111111111111111111111111';
const PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const OTHER_PROGRAM_ADDRESS = 'Vote111111111111111111111111111111111111111';
const V1 = '0x1111111111111111111111111111111111111111';
const V2 = '0x2222222222222222222222222222222222222222';
const DOMAIN_1: DomainMultisigConfig = { validators: [V1, V2], threshold: 2 };

function artifactConfig(
  domains: RoutingMessageIdMultisigIsmArtifactConfig['domains'],
  owner: string = OWNER,
): RoutingMessageIdMultisigIsmArtifactConfig {
  return { type: IsmType.ROUTING_MESSAGE_ID_MULTISIG, owner, domains };
}

function deployedArtifact(
  config: RoutingMessageIdMultisigIsmArtifactConfig,
): DeployedIsmArtifact {
  return {
    artifactState: ArtifactState.DEPLOYED,
    config,
    deployed: { address: PROGRAM_ADDRESS },
  };
}

describe('routingMessageIdMultisigIsm', () => {
  it('is mutable, so it is not a static ISM type', () => {
    expect(STATIC_ISM_TYPES).to.not.include(
      IsmType.ROUTING_MESSAGE_ID_MULTISIG,
    );
  });

  it('maps the AltVM ISM type to the provider-sdk type', () => {
    expect(
      altVMIsmTypeToProviderSdkType(AltVMIsmType.ROUTING_MESSAGE_ID_MULTISIG),
    ).to.equal('routingMessageIdMultisigIsm');
  });

  describe('config <-> artifact conversion', () => {
    const config: IsmConfig = {
      type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
      owner: OWNER,
      domains: {
        ethereum: { validators: [V1, V2], threshold: 2 },
        polygon: { validators: [V1], threshold: 1 },
      },
    };

    it('converts chain names to domain ids', () => {
      expect(ismConfigToArtifact(config, chainLookup)).to.deep.equal({
        artifactState: ArtifactState.NEW,
        config: {
          type: 'routingMessageIdMultisigIsm',
          owner: OWNER,
          domains: {
            1: { validators: [V1, V2], threshold: 2 },
            137: { validators: [V1], threshold: 1 },
          },
        },
      });
    });

    it('throws on an unknown chain when converting to an artifact', () => {
      expect(() =>
        ismConfigToArtifact(
          {
            type: IsmType.ROUTING_MESSAGE_ID_MULTISIG,
            owner: OWNER,
            domains: {
              ethereum: { validators: [V1], threshold: 1 },
              unknownchain: { validators: [V2], threshold: 1 },
            },
          },
          chainLookup,
        ),
      ).to.throw('Unknown chain unknownchain in routingMessageIdMultisigIsm');
    });

    it('round-trips through the derived config', () => {
      const artifact = ismConfigToArtifact(config, chainLookup);
      const derived = ismArtifactToDerivedConfig(
        {
          artifactState: ArtifactState.DEPLOYED,
          config: artifact.config,
          deployed: { address: PROGRAM_ADDRESS },
        },
        chainLookup,
      );

      expect(derived).to.deep.equal({ ...config, address: PROGRAM_ADDRESS });
    });

    it('skips unknown domains when deriving a config', () => {
      const derived = ismArtifactToDerivedConfig(
        deployedArtifact(
          artifactConfig({
            1: { validators: [V1], threshold: 1 },
            999999: { validators: [V2], threshold: 1 },
          }),
        ),
        chainLookup,
      );

      expect(derived).to.deep.equal({
        type: 'routingMessageIdMultisigIsm',
        owner: OWNER,
        domains: { ethereum: { validators: [V1], threshold: 1 } },
        address: PROGRAM_ADDRESS,
      });
    });
  });

  describe('shouldDeployNewIsm', () => {
    interface Case {
      name: string;
      actual: IsmArtifactConfig;
      expected: IsmArtifactConfig;
      deploy: boolean;
    }
    const current = artifactConfig({
      1: DOMAIN_1,
      137: { validators: [V1], threshold: 1 },
    });
    const renounced = artifactConfig(current.domains, ZERO_ADDRESS_HEX_32);
    const cases: Case[] = [
      {
        name: 'is false for an identical config',
        actual: current,
        expected: current,
        deploy: false,
      },
      {
        name: 'is false when a domain is added',
        actual: current,
        expected: artifactConfig({
          ...current.domains,
          5: { validators: [V2], threshold: 1 },
        }),
        deploy: false,
      },
      {
        name: "is false when a domain's validators and threshold change",
        actual: current,
        expected: artifactConfig({
          1: { validators: [V2], threshold: 1 },
          137: { validators: [V1], threshold: 1 },
        }),
        deploy: false,
      },
      {
        name: 'is false when only the owner changes',
        actual: current,
        expected: artifactConfig(current.domains, PROGRAM_ADDRESS),
        deploy: false,
      },
      {
        name: 'is true when an on-chain domain is missing from the expected config',
        actual: current,
        expected: artifactConfig({ 1: DOMAIN_1 }),
        deploy: true,
      },
      {
        name: 'is false for an unchanged renounced ISM',
        actual: renounced,
        expected: renounced,
        deploy: false,
      },
      {
        name: 'is false for a renounced ISM whose domains differ only by validator order and case',
        actual: renounced,
        expected: artifactConfig(
          {
            1: {
              validators: [V2.toUpperCase().replace('0X', '0x'), V1],
              threshold: 2,
            },
            137: { validators: [V1], threshold: 1 },
          },
          ZERO_ADDRESS_HEX_32,
        ),
        deploy: false,
      },
      {
        name: 'is true for a renounced ISM when a domain changes',
        actual: renounced,
        expected: artifactConfig(
          { ...renounced.domains, 1: { validators: [V2], threshold: 1 } },
          ZERO_ADDRESS_HEX_32,
        ),
        deploy: true,
      },
      {
        name: 'is true for a renounced ISM when a domain is added',
        actual: renounced,
        expected: artifactConfig(
          { ...renounced.domains, 5: { validators: [V2], threshold: 1 } },
          ZERO_ADDRESS_HEX_32,
        ),
        deploy: true,
      },
      {
        name: 'is true for a renounced ISM when a non-empty owner is expected',
        actual: renounced,
        expected: artifactConfig(renounced.domains, OWNER),
        deploy: true,
      },
      {
        name: 'is false for a renounced ISM when an empty owner is expected',
        actual: renounced,
        expected: artifactConfig(renounced.domains, ''),
        deploy: false,
      },
    ];
    for (const c of cases) {
      it(c.name, () => {
        expect(shouldDeployNewIsm(c.actual, c.expected)).to.equal(c.deploy);
      });
    }
  });

  describe('mergeIsmArtifacts', () => {
    const current = artifactConfig({
      1: DOMAIN_1,
      137: { validators: [V1], threshold: 1 },
    });

    it('deploys a new ISM when an on-chain domain is dropped', () => {
      const expected = artifactConfig({ 1: DOMAIN_1 });
      const merged = mergeIsmArtifacts(deployedArtifact(current), {
        artifactState: ArtifactState.NEW,
        config: expected,
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.NEW,
        config: expected,
      });
    });

    it('keeps the deployed ISM with the expected config when domains only change or grow', () => {
      const expected = artifactConfig({
        1: { validators: [V2], threshold: 1 },
        137: { validators: [V1], threshold: 1 },
        5: { validators: [V2], threshold: 1 },
      });
      const merged = mergeIsmArtifacts(deployedArtifact(current), {
        artifactState: ArtifactState.NEW,
        config: expected,
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: PROGRAM_ADDRESS },
      });
    });

    it('deploys a new ISM when the current ISM is renounced and a domain changes', () => {
      const renounced = artifactConfig(current.domains, ZERO_ADDRESS_HEX_32);
      const expected = artifactConfig(
        { ...current.domains, 1: { validators: [V2], threshold: 1 } },
        ZERO_ADDRESS_HEX_32,
      );
      const merged = mergeIsmArtifacts(deployedArtifact(renounced), {
        artifactState: ArtifactState.NEW,
        config: expected,
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.NEW,
        config: expected,
      });
    });

    it('keeps the renounced ISM when nothing changed', () => {
      const renounced = artifactConfig(current.domains, ZERO_ADDRESS_HEX_32);
      const merged = mergeIsmArtifacts(deployedArtifact(renounced), {
        artifactState: ArtifactState.NEW,
        config: renounced,
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.DEPLOYED,
        config: renounced,
        deployed: { address: PROGRAM_ADDRESS },
      });
    });

    it('keeps an explicitly deployed ISM at a different address when the current ISM is renounced', () => {
      const renounced = artifactConfig(current.domains, ZERO_ADDRESS_HEX_32);
      const expected = artifactConfig({ 1: DOMAIN_1 });
      const merged = mergeIsmArtifacts(deployedArtifact(renounced), {
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: OTHER_PROGRAM_ADDRESS },
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: OTHER_PROGRAM_ADDRESS },
      });
    });

    it('keeps an explicitly deployed ISM at a different address instead of deploying a new one', () => {
      const expected = artifactConfig({ 1: DOMAIN_1 });
      const merged = mergeIsmArtifacts(deployedArtifact(current), {
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: OTHER_PROGRAM_ADDRESS },
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: OTHER_PROGRAM_ADDRESS },
      });
    });

    it('deploys a new ISM when the explicitly deployed target is the current ISM and drops a domain', () => {
      const expected = artifactConfig({ 1: DOMAIN_1 });
      const merged = mergeIsmArtifacts(deployedArtifact(current), {
        artifactState: ArtifactState.DEPLOYED,
        config: expected,
        deployed: { address: PROGRAM_ADDRESS },
      });

      expect(merged).to.deep.equal({
        artifactState: ArtifactState.NEW,
        config: expected,
      });
    });
  });
});
