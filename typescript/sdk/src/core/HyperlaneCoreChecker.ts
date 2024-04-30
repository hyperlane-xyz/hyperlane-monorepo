import { ethers, utils as ethersUtils } from 'ethers';

import { assert, eqAddress } from '@hyperlane-xyz/utils';

import { BytecodeHash } from '../consts/bytecode.js';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker.js';
import { proxyImplementation } from '../deploy/proxy.js';
import { HyperlaneIsmFactory } from '../ism/HyperlaneIsmFactory.js';
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
  ) {
    super(multiProvider, app, configMap);
  }

  async checkChain(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    // skip chains that are configured to be removed
    if (config.remove) {
      return;
    }

    await this.checkDomainOwnership(chain);
    await this.checkProxiedContracts(chain);
    await this.checkMailbox(chain);
    await this.checkBytecodes(chain);
    await this.checkValidatorAnnounce(chain);
    if (config.upgrade) {
      await this.checkUpgrade(chain, config.upgrade);
    }
  }

  async checkDomainOwnership(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    return this.checkOwnership(chain, config.owner, config.ownerOverrides);
  }

  async checkMailbox(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox;
    const localDomain = await mailbox.localDomain();
    assert(localDomain === this.multiProvider.getDomainId(chain));

    const actualIsm = await mailbox.defaultIsm();

    const config = this.configMap[chain];
    const matches = await moduleMatchesConfig(
      chain,
      actualIsm,
      config.defaultIsm,
      this.ismFactory.multiProvider,
      this.ismFactory.getContracts(chain),
    );
    if (!matches) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        subType: MailboxViolationType.DefaultIsm,
        contract: mailbox,
        chain,
        actual: actualIsm,
        expected: config.defaultIsm,
      };
      this.addViolation(violation);
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
