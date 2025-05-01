import { ethers, utils as ethersUtils } from 'ethers';

import { Ownable__factory } from '@hyperlane-xyz/core';
import { assert, eqAddress, rootLogger } from '@hyperlane-xyz/utils';

import { BytecodeHash } from '../consts/bytecode.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { proxyImplementation } from '../deploy/proxy.js';
import { OwnerViolation, ViolationType } from '../deploy/types.js';
import { EvmIsmReader } from '../ism/EvmIsmReader.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
import { DerivedIsmConfig } from '../ism/types.js';
import { collectValidators, moduleMatchesConfig } from '../ism/utils.js';
import { MultiProvider } from '../providers/MultiProvider.js';
import { ChainMap, ChainName } from '../types.js';

import { HyperlaneCore } from './HyperlaneCore.js';
import {
  CoreConfig,
  CoreViolationType,
  MailboxViolation,
  MailboxViolationType,
  ValidatorAnnounceViolation,
} from './types.js';

export class HyperlaneCoreChecker extends HyperlaneAppChecker<
  HyperlaneCore,
  CoreConfig
> {
  constructor(
    multiProvider: MultiProvider,
    app: HyperlaneCore,
    configMap: ChainMap<CoreConfig>,
    readonly ismFactory: HyperlaneIsmFactory,
    readonly chainAddresses: ChainMap<Record<string, string>>,
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];

    if (!config) {
      rootLogger.warn(`No config for chain ${chain}`);
      return;
    }

    // skip chains that are configured to be removed
    if (config.remove) {
      return;
    }

    await this.checkProxiedContracts(
      chain,
      config.owner,
      config.ownerOverrides,
    );
    await this.checkMailbox(chain);
    await this.checkBytecodes(chain);
    await this.checkValidatorAnnounce(chain);
    if (config.upgrade) {
      await this.checkUpgrade(chain, config.upgrade);
    }
    await this.checkDomainOwnership(chain);
  }

  async checkDomainOwnership(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    return this.checkOwnership(chain, config.owner, config.ownerOverrides);
  }

  async checkHook(
    chain: ChainName,
    hookName: string,
    hookAddress: string,
    expectedHookOwner: string,
  ): Promise<void> {
    const hook = Ownable__factory.connect(
      hookAddress,
      this.multiProvider.getProvider(chain),
    );
    const hookOwner = await hook.owner();

    if (!eqAddress(hookOwner, expectedHookOwner)) {
      const violation: OwnerViolation = {
        type: ViolationType.Owner,
        chain,
        name: hookName,
        actual: hookOwner,
        expected: expectedHookOwner,
        contract: hook,
      };
      this.addViolation(violation);
    }
  }

  async checkMailbox(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox;
    const localDomain = await mailbox.localDomain();
    assert(
      localDomain === this.multiProvider.getDomainId(chain),
      `local domain ${localDomain} does not match expected domain ${this.multiProvider.getDomainId(
        chain,
      )} for ${chain}`,
    );

    const config = this.configMap[chain];
    const expectedHookOwner = this.getOwner(
      config.owner,
      'fallbackRoutingHook',
      config.ownerOverrides,
    );

    await this.checkHook(
      chain,
      'defaultHook',
      await mailbox.defaultHook(),
      expectedHookOwner,
    );
    await this.checkHook(
      chain,
      'requiredHook',
      await mailbox.requiredHook(),
      expectedHookOwner,
    );

    const actualIsmAddress = await mailbox.defaultIsm();
    const matches = await moduleMatchesConfig(
      chain,
      actualIsmAddress,
      config.defaultIsm,
      this.ismFactory.multiProvider,
      this.ismFactory.getContracts(chain),
    );

    if (!matches) {
      const registryIsmAddress =
        this.chainAddresses[chain].interchainSecurityModule;
      const registryIsmMatches = await moduleMatchesConfig(
        chain,
        registryIsmAddress,
        config.defaultIsm,
        this.ismFactory.multiProvider,
        this.ismFactory.getContracts(chain),
      );

      if (registryIsmMatches) {
        // if the ISM in registry matches the expected config, then we can assume
        // that the mailbox should be using that ISM instead of the current one
        // and we should report just an address violation
        const violation: MailboxViolation = {
          type: CoreViolationType.Mailbox,
          subType: MailboxViolationType.DefaultIsm,
          contract: mailbox,
          chain,
          actual: actualIsmAddress,
          expected: registryIsmAddress,
        };
        this.addViolation(violation);
      } else {
        const ismReader = new EvmIsmReader(
          this.ismFactory.multiProvider,
          chain,
        );
        let actualConfig: string | DerivedIsmConfig =
          ethers.constants.AddressZero;
        if (actualIsmAddress !== ethers.constants.AddressZero) {
          actualConfig = await ismReader.deriveIsmConfig(actualIsmAddress);
        }

        // If the config doesn't match either onchain or the registry
        // then we have a full config violation, which the governor will need to
        // fix by deploying a new ISM
        const violation: MailboxViolation = {
          type: CoreViolationType.Mailbox,
          subType: MailboxViolationType.DefaultIsm,
          contract: mailbox,
          chain,
          actual: actualConfig,
          expected: config.defaultIsm,
        };
        this.addViolation(violation);
      }
    }
  }

  async checkBytecodes(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox;
    const localDomain = await mailbox.localDomain();
    const implementation = await proxyImplementation(
      this.multiProvider.getProvider(chain),
      mailbox.address,
    );

    if (implementation === ethers.constants.AddressZero) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        subType: MailboxViolationType.NotProxied,
        contract: mailbox,
        chain,
        actual: implementation,
        expected: 'non-zero address',
      };
      this.addViolation(violation);
    } else {
      await this.checkBytecode(
        chain,
        'Mailbox implementation',
        implementation,
        [
          BytecodeHash.V3_MAILBOX_BYTECODE_HASH,
          BytecodeHash.OPT_V3_MAILBOX_BYTECODE_HASH,
        ],
        (bytecode) =>
          // This is obviously super janky but basically we are searching
          //  for the occurrences of localDomain in the bytecode and remove
          //  that to compare, but some coincidental occurrences of
          // localDomain in the bytecode should be not be removed which
          // are just done via an offset guard
          bytecode
            .replaceAll(
              ethersUtils.defaultAbiCoder
                .encode(['uint32'], [localDomain])
                .slice(2),
              (match, offset) => (offset > 8000 ? match : ''),
            )
            // We persist the block number in the bytecode now too, so we have to strip it
            .replaceAll(
              /(00000000000000000000000000000000000000000000000000000000[a-f0-9]{0,22})81565/g,
              (match, _offset) => (match.length % 2 === 0 ? '' : '0'),
            )
            .replaceAll(
              /(0000000000000000000000000000000000000000000000000000[a-f0-9]{0,22})6118123373/g,
              (match, _offset) => (match.length % 2 === 0 ? '' : '0'),
            )
            .replaceAll(
              /(f167f00000000000000000000000000000000000000000000000000000[a-f0-9]{0,22})338989898/g,
              (match, _offset) => (match.length % 2 === 0 ? '' : '0'),
            ),
      );
    }

    await this.checkProxy(chain, 'Mailbox proxy', contracts.mailbox.address);

    await this.checkBytecode(
      chain,
      'ProxyAdmin',
      contracts.proxyAdmin.address,
      [
        BytecodeHash.PROXY_ADMIN_BYTECODE_HASH,
        BytecodeHash.V2_PROXY_ADMIN_BYTECODE_HASH,
      ],
    );
  }

  async checkValidatorAnnounce(chain: ChainName): Promise<void> {
    const validators = new Set<string>();
    const remotes = Object.keys(this.configMap).filter((c) => c !== chain);
    const remoteOriginValidators = remotes.map((remote) =>
      collectValidators(chain, this.configMap[remote].defaultIsm),
    );
    remoteOriginValidators.map((set) => {
      [...set].map((v) => validators.add(v));
    });

    const validatorAnnounce = this.app.getContracts(chain).validatorAnnounce;
    const announcedValidators =
      await validatorAnnounce.getAnnouncedValidators();
    [...validators].forEach((validator) => {
      const matches = announcedValidators.filter((x) =>
        eqAddress(x, validator),
      );
      if (matches.length == 0) {
        const violation: ValidatorAnnounceViolation = {
          type: CoreViolationType.ValidatorAnnounce,
          chain,
          validator,
          actual: false,
          expected: true,
        };
        this.addViolation(violation);
      }
    });
  }
}
