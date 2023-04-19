import { utils as ethersUtils } from 'ethers';

import { utils } from '@hyperlane-xyz/utils';

import { BytecodeHash } from '../consts/bytecode';
import { HyperlaneAppChecker } from '../deploy/HyperlaneAppChecker';
import { proxyImplementation } from '../deploy/proxy';
import {
  HyperlaneIsmFactory,
  collectValidators,
} from '../ism/HyperlaneIsmFactory';
import { MultiProvider } from '../providers/MultiProvider';
import { ChainMap, ChainName } from '../types';

import { HyperlaneCore } from './HyperlaneCore';
import {
  CoreConfig,
  CoreViolationType,
  MailboxViolation,
  MailboxViolationType,
  ValidatorAnnounceViolation,
} from './types';

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
  }

  async checkDomainOwnership(chain: ChainName): Promise<void> {
    const config = this.configMap[chain];
    if (config.owner) {
      return this.checkOwnership(chain, config.owner);
    }
  }

  async checkMailbox(chain: ChainName): Promise<void> {
    const contracts = this.app.getContracts(chain);
    const mailbox = contracts.mailbox;
    const localDomain = await mailbox.localDomain();
    utils.assert(localDomain === this.multiProvider.getDomainId(chain));

    const actualIsm = await mailbox.defaultIsm();
    const config = this.configMap[chain];
    /*
    TODO: Add this back in once the new ISM factories are adopted
    const matches = await moduleMatches(
      chain,
      actualIsm,
      config.defaultIsm,
      this.ismFactory.multiProvider,
      this.ismFactory.getContracts(chain),
    );
    */
    const matches = true;
    if (!matches) {
      const violation: MailboxViolation = {
        type: CoreViolationType.Mailbox,
        mailboxType: MailboxViolationType.DefaultIsm,
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

    await this.checkBytecode(
      chain,
      'Mailbox implementation',
      implementation,
      [
        BytecodeHash.MAILBOX_WITHOUT_LOCAL_DOMAIN_BYTE_CODE_HASH,
        BytecodeHash.MAILBOX_WITHOUT_LOCAL_DOMAIN_NONZERO_PAUSE_BYTE_CODE_HASH,
      ],
      (bytecode) =>
        // This is obviously super janky but basically we are searching
        //  for the ocurrences of localDomain in the bytecode and remove
        //  that to compare, but some coincidental ocurrences of
        // localDomain in the bytecode should be not be removed which
        // are just done via an offset guard
        bytecode.replaceAll(
          ethersUtils.defaultAbiCoder
            .encode(['uint32'], [localDomain])
            .slice(2),
          (match, offset) => (offset > 8000 ? match : ''),
        ),
    );

    await this.checkBytecode(
      chain,
      'Mailbox proxy',
      contracts.mailbox.address,
      [BytecodeHash.TRANSPARENT_PROXY_BYTECODE_HASH],
    );
    await this.checkBytecode(
      chain,
      'ProxyAdmin',
      contracts.proxyAdmin.address,
      [BytecodeHash.PROXY_ADMIN_BYTECODE_HASH],
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
        utils.eqAddress(x, validator),
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
