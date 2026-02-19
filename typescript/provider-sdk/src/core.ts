import {
  Artifact,
  ArtifactNew,
  ArtifactState,
  isArtifactDeployed,
} from './artifact.js';
import { ChainLookup } from './chain.js';
import {
  DeployedHookAddress,
  type DerivedHookConfig,
  HookArtifactConfig,
  type HookConfig,
  hookConfigToArtifact,
} from './hook.js';
import {
  DeployedIsmAddress,
  type DerivedIsmConfig,
  IsmArtifactConfig,
  type IsmConfig,
  ismConfigToArtifact,
} from './ism.js';
import { DeployedMailboxArtifact, MailboxConfig } from './mailbox.js';
import { DeployedValidatorAnnounceArtifact } from './validator-announce.js';

export type CoreModuleType = {
  config: CoreConfig;
  derived: DerivedCoreConfig;
  addresses: DeployedCoreAddresses;
};

export interface CoreConfig {
  owner: string;
  defaultIsm: IsmConfig | string;
  defaultHook: HookConfig | string;
  requiredHook: HookConfig | string;
}

export interface DerivedCoreConfig extends CoreConfig {
  defaultIsm: DerivedIsmConfig;
  defaultHook: DerivedHookConfig;
  requiredHook: DerivedHookConfig;
}

export type DeployedCoreAddresses = {
  staticMerkleRootMultisigIsmFactory: string;
  staticMessageIdMultisigIsmFactory: string;
  staticAggregationIsmFactory: string;
  staticAggregationHookFactory: string;
  domainRoutingIsmFactory: string;
  staticMerkleRootWeightedMultisigIsmFactory: string;
  staticMessageIdWeightedMultisigIsmFactory: string;
  mailbox: string;
  validatorAnnounce: string;
  proxyAdmin: string;
  testRecipient: string;
  timelockController?: string;
  interchainAccountRouter: string;
  merkleTreeHook?: string;
  interchainGasPaymaster?: string;
  protocolFee?: string;
};

/**
 * Converts CoreConfig to MailboxOnChain artifact format.
 * Converts nested ISM and hook configs to artifact format.
 *
 * @param config CoreConfig with ISM/hook configs or addresses
 * @param chainLookup Chain lookup for domain resolution
 * @returns Mailbox artifact ready for deployment
 */
export function coreConfigToArtifact(
  config: CoreConfig,
  chainLookup: ChainLookup,
): ArtifactNew<MailboxConfig> {
  // Convert ISM config to artifact (handles both string addresses and config objects)
  let defaultIsmArtifact: Artifact<IsmArtifactConfig, DeployedIsmAddress>;
  if (typeof config.defaultIsm === 'string') {
    defaultIsmArtifact = {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: config.defaultIsm },
    };
  } else {
    defaultIsmArtifact = ismConfigToArtifact(config.defaultIsm, chainLookup);
  }

  // Convert hook configs to artifacts
  let defaultHookArtifact: Artifact<HookArtifactConfig, DeployedHookAddress>;
  if (typeof config.defaultHook === 'string') {
    defaultHookArtifact = {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: config.defaultHook },
    };
  } else {
    defaultHookArtifact = hookConfigToArtifact(config.defaultHook, chainLookup);
  }

  let requiredHookArtifact: Artifact<HookArtifactConfig, DeployedHookAddress>;
  if (typeof config.requiredHook === 'string') {
    requiredHookArtifact = {
      artifactState: ArtifactState.UNDERIVED,
      deployed: { address: config.requiredHook },
    };
  } else {
    requiredHookArtifact = hookConfigToArtifact(
      config.requiredHook,
      chainLookup,
    );
  }

  return {
    artifactState: ArtifactState.NEW,
    config: {
      owner: config.owner,
      defaultIsm: defaultIsmArtifact,
      defaultHook: defaultHookArtifact,
      requiredHook: requiredHookArtifact,
    },
  };
}

/**
 * Converts CoreWriter result to DeployedCoreAddresses format.
 * Maps deployed ISM and hook types to factory address fields.
 *
 * @param result CoreWriter create() result with mailbox and validator announce artifacts
 * @returns DeployedCoreAddresses with factory addresses mapped
 */
export function coreResultToDeployedAddresses(result: {
  mailbox: DeployedMailboxArtifact;
  validatorAnnounce: DeployedValidatorAnnounceArtifact | null;
}): DeployedCoreAddresses {
  const addresses: DeployedCoreAddresses = {
    mailbox: result.mailbox.deployed.address,
    validatorAnnounce: result.validatorAnnounce?.deployed.address || '',
    staticMerkleRootMultisigIsmFactory: '',
    proxyAdmin: '',
    staticMerkleRootWeightedMultisigIsmFactory: '',
    staticAggregationHookFactory: '',
    staticAggregationIsmFactory: '',
    staticMessageIdMultisigIsmFactory: '',
    staticMessageIdWeightedMultisigIsmFactory: '',
    testRecipient: '',
    interchainAccountRouter: '',
    domainRoutingIsmFactory: '',
  };

  // Map ISM address to factory field based on type
  const ismArtifact = result.mailbox.config.defaultIsm;
  if (isArtifactDeployed(ismArtifact)) {
    const ismAddress = ismArtifact.deployed.address;
    switch (ismArtifact.config.type) {
      case 'merkleRootMultisigIsm':
        addresses.staticMerkleRootMultisigIsmFactory = ismAddress;
        break;
      case 'messageIdMultisigIsm':
        addresses.staticMessageIdMultisigIsmFactory = ismAddress;
        break;
      case 'domainRoutingIsm':
        addresses.domainRoutingIsmFactory = ismAddress;
        break;
    }
  }

  // Map default hook address to factory field
  const defaultHookArtifact = result.mailbox.config.defaultHook;
  if (isArtifactDeployed(defaultHookArtifact)) {
    const hookAddress = defaultHookArtifact.deployed.address;
    switch (defaultHookArtifact.config.type) {
      case 'interchainGasPaymaster':
        addresses.interchainGasPaymaster = hookAddress;
        break;
      case 'merkleTreeHook':
        addresses.merkleTreeHook = hookAddress;
        break;
      case 'protocolFee':
        addresses.protocolFee = hookAddress;
        break;
    }
  }

  // Map required hook address to factory field
  const requiredHookArtifact = result.mailbox.config.requiredHook;
  if (isArtifactDeployed(requiredHookArtifact)) {
    const hookAddress = requiredHookArtifact.deployed.address;
    switch (requiredHookArtifact.config.type) {
      case 'interchainGasPaymaster':
        // Only set if not already set by default hook
        if (!addresses.interchainGasPaymaster) {
          addresses.interchainGasPaymaster = hookAddress;
        }
        break;
      case 'merkleTreeHook':
        // Only set if not already set by default hook
        if (!addresses.merkleTreeHook) {
          addresses.merkleTreeHook = hookAddress;
        }
        break;
      case 'protocolFee':
        if (!addresses.protocolFee) {
          addresses.protocolFee = hookAddress;
        }
        break;
    }
  }

  return addresses;
}
