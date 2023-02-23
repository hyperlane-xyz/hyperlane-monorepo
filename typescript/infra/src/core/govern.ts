import { Provider } from '@ethersproject/providers';
import { prompts } from 'prompts';

import { InterchainGasPaymaster, Ownable__factory } from '@hyperlane-xyz/core';
import {
  ChainMap,
  ChainName,
  ChainNameToDomainId,
  CoreContracts,
  CoreViolationType,
  EnrolledValidatorsViolation,
  HyperlaneCoreChecker,
  IgpBeneficiaryViolation,
  IgpGasOraclesViolation,
  IgpViolation,
  IgpViolationType,
  MultisigIsmViolation,
  MultisigIsmViolationType,
  OwnerViolation,
  ProxyViolation,
  ViolationType,
  objMap,
} from '@hyperlane-xyz/sdk';
import { ProxyKind } from '@hyperlane-xyz/sdk/dist/proxy';
import { types, utils } from '@hyperlane-xyz/utils';
import {
  bytes32ToAddress,
  eqAddress,
} from '@hyperlane-xyz/utils/dist/src/utils';

import { getCoreVerificationDirectory } from '../../scripts/utils';
import { canProposeSafeTransactions } from '../utils/safe';
import { readJSON } from '../utils/utils';

import {
  ManualMultiSend,
  MultiSend,
  SafeMultiSend,
  SignerMultiSend,
} from './multisend';

enum SubmissionType {
  MANUAL = 'MANUAL',
  SIGNER = 'SIGNER',
  SAFE = 'SAFE',
}

type AnnotatedCallData = types.CallData & {
  submissionType?: SubmissionType;
  description: string;
  // When true, instead of estimating gas when inferring submission type,
  // the submission type that is the owner of the contract is used.
  // This is useful if a call depends upon a prior call's state change, so
  // estimating gas will fail
  onlyCheckOwnership?: boolean;
};

const PROXY_ADMIN_STORAGE_KEY =
  '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103';

export class HyperlaneCoreGovernor<Chain extends ChainName> {
  readonly checker: HyperlaneCoreChecker<Chain>;
  private calls: ChainMap<Chain, AnnotatedCallData[]>;
  private canPropose: ChainMap<Chain, Map<string, boolean>>;

  constructor(checker: HyperlaneCoreChecker<Chain>) {
    this.checker = checker;
    this.calls = objMap(this.checker.app.contractsMap, () => []);
    this.canPropose = objMap(this.checker.app.contractsMap, () => new Map());
  }

  async govern() {
    // 1. Produce calls from checker violations.
    await this.mapViolationsToCalls();

    // 2. For each call, infer how it should be submitted on-chain.
    await this.inferCallSubmissionTypes();

    // 3. Prompt the user to confirm that the count, description,
    // and submission methods look correct before submitting.
    for (const chain of Object.keys(this.calls) as Chain[]) {
      await this.sendCalls(chain);
    }
  }

  protected async sendCalls(chain: Chain) {
    const calls = this.calls[chain];
    console.log(`\nFound ${calls.length} transactions for ${chain}`);
    const filterCalls = (submissionType: SubmissionType) =>
      calls.filter((call) => call.submissionType == submissionType);
    const summarizeCalls = async (
      submissionType: SubmissionType,
      calls: AnnotatedCallData[],
    ): Promise<boolean> => {
      if (calls.length > 0) {
        console.log(
          `> ${calls.length} calls will be submitted via ${submissionType}`,
        );
        calls.map((c) => console.log(`> > ${c.description} (data: ${c.data})`));
        const response = prompts.confirm({
          type: 'confirm',
          name: 'value',
          message: 'Can you confirm?',
          initial: false,
        });
        return response as unknown as boolean;
      }
      return false;
    };

    const sendCallsForType = async (
      submissionType: SubmissionType,
      multiSend: MultiSend,
    ) => {
      const calls = filterCalls(submissionType);
      if (calls.length > 0) {
        // @ts-ignore
        console.log('Using multisend', multiSend.connection.provider);
        const confirmed = await summarizeCalls(submissionType, calls);
        if (confirmed) {
          console.log(`Submitting calls on ${chain} via ${submissionType}`);
          await multiSend.sendTransactions(
            calls.map((call) => ({ to: call.to, data: call.data })),
          );
        } else {
          console.log(
            `Skipping submission of calls on ${chain} via ${submissionType}`,
          );
        }
      }
    };

    const connection = this.checker.multiProvider.getChainConnection(chain);

    await sendCallsForType(
      SubmissionType.SIGNER,
      new SignerMultiSend(connection),
    );
    const owner = this.checker.configMap[chain!].owner!;
    await sendCallsForType(
      SubmissionType.SAFE,
      new SafeMultiSend(connection, chain, owner),
    );
    await sendCallsForType(SubmissionType.MANUAL, new ManualMultiSend(chain));
  }

  protected pushCall(chain: Chain, call: AnnotatedCallData) {
    this.calls[chain].push(call);
  }

  protected async mapViolationsToCalls() {
    for (const violation of this.checker.violations) {
      switch (violation.type) {
        case CoreViolationType.MultisigIsm: {
          this.handleMultisigIsmViolation(violation as MultisigIsmViolation);
          break;
        }
        case ViolationType.Owner: {
          this.handleOwnerViolation(violation as OwnerViolation);
          break;
        }
        case ProxyKind.Transparent: {
          await this.handleProxyViolation(violation as ProxyViolation);
          break;
        }
        case CoreViolationType.InterchainGasPaymaster: {
          this.handleIgpViolation(violation as IgpViolation);
          break;
        }
        case ViolationType.BytecodeMismatch:
        case CoreViolationType.ValidatorAnnounce:
          console.log(`Unsupported violation type ${violation.type}, skipping`);
          break;
        default:
          throw new Error(`Unsupported violation type ${violation.type}`);
      }
    }
  }

  async handleProxyViolation(violation: ProxyViolation) {
    const chain = violation.chain as Chain;
    const contracts: CoreContracts = this.checker.app.contractsMap[chain];
    // '0x'-prefixed hex if set
    // let initData: string | undefined;
    console.log(
      '\n\n\n\n\n\n------\nhandling proxy violation for chain',
      chain,
    );
    switch (violation.data.name) {
      case 'InterchainGasPaymaster':
        // We don't init - ideally we would call `setGasOracles`, but because
        // that function is `onlyOwner` and the msg.sender would be the ProxyAdmin
        // contract, this doesn't work. Instead we call `setGasOracles` afterward
        // when handling the IgpGasOraclesViolation
        // initData = undefined;
        const igp = contracts.interchainGasPaymaster;
        const canonicalProxyAdmin = contracts.proxyAdmin;
        const ownable = Ownable__factory.connect(
          igp.address,
          this.checker.multiProvider.getChainProvider(chain),
        );
        const actualOwner = await ownable.owner();
        const expectedOwner = this.checker.configMap[chain].owner;
        if (!eqAddress(actualOwner, this.checker.configMap[chain].owner)) {
          console.warn(
            `Found InterchainGasPaymaster proxy violation where the owner is incorrect. Actual: ${actualOwner}, expected: ${expectedOwner}`,
          );

          const provider = this.checker.multiProvider.getChainProvider(chain);
          const verificationDir = getCoreVerificationDirectory('mainnet2');
          const verificationFile = 'verification.json';
          const verification = readJSON(verificationDir, verificationFile);
          const igpAdmin = bytes32ToAddress(
            await provider.getStorageAt(igp.address, PROXY_ADMIN_STORAGE_KEY),
          );
          const deployerOwnedProxyAdmin: string | undefined = verification[
            chain
          ]?.find((v: any) => v.name === 'DeployerOwnedProxyAdmin')?.address;

          if (
            deployerOwnedProxyAdmin !== undefined &&
            eqAddress(actualOwner, deployerOwnedProxyAdmin)
          ) {
            console.log(
              'Incorrectly set IGP owner is the deployer owned proxy admin',
              deployerOwnedProxyAdmin,
            );
            // Confirm that the IGP's admin is correctly set to the canonical proxy admin
            if (!eqAddress(igpAdmin, canonicalProxyAdmin.address)) {
              throw Error(
                `IGP admin ${igpAdmin} !== canonical proxy admin ${canonicalProxyAdmin.address}`,
              );
            }
            // We want to first transfer ownership of the deployer owned proxy admin
            // to the owner multisig
            const ownerOfDeployerOwnedProxyAdmin =
              await Ownable__factory.connect(
                deployerOwnedProxyAdmin,
                provider,
              ).owner();
            const deployer = await this.checker.multiProvider
              .getChainSigner(chain)
              .getAddress();
            if (!eqAddress(ownerOfDeployerOwnedProxyAdmin, deployer)) {
              throw Error(
                `ownerOfDeployerOwnedProxyAdmin ${ownerOfDeployerOwnedProxyAdmin} !== deployer ${deployer}`,
              );
            }
            // Transfer ownership of the deployer owned proxy admin to the owner
            // This should be done by the deployer / signer
            this.pushCall(chain, {
              to: deployerOwnedProxyAdmin,
              data: ownable.interface.encodeFunctionData('transferOwnership', [
                expectedOwner,
              ]),
              description: `Transferring ownership of deployerOwnedProxyAdmin ${deployerOwnedProxyAdmin} from deployer ${deployer} to expectedOwner ${expectedOwner}`,
              submissionType: SubmissionType.SIGNER,
            });

            // Now change IGP's proxy admin away from canonicalProxyAdmin to deployerOwnedProxyAdmin
            this.pushCall(chain, {
              to: canonicalProxyAdmin.address,
              data: canonicalProxyAdmin.interface.encodeFunctionData(
                'changeProxyAdmin',
                [igp.address, deployerOwnedProxyAdmin],
              ),
              description: `Changing proxy admin for IGP ${igp.address} from canonicalProxyAdmin ${canonicalProxyAdmin.address} to deployerOwnedProxyAdmin ${deployerOwnedProxyAdmin}`,
              submissionType: SubmissionType.SAFE,
            });

            // Now make the upgradeAndCall using the deployerOwnedProxyAdmin to change to the new implementation
            // and to transfer ownership to the expectedOwner
            const upgradeAndCallData =
              contracts.proxyAdmin.interface.encodeFunctionData(
                'upgradeAndCall',
                [
                  violation.data.proxyAddresses.proxy,
                  violation.data.proxyAddresses.implementation,
                  ownable.interface.encodeFunctionData('transferOwnership', [
                    expectedOwner,
                  ]),
                ],
              );
            this.pushCall(chain, {
              to: deployerOwnedProxyAdmin,
              data: upgradeAndCallData,
              description: `Upgrading ${violation.data.proxyAddresses.proxy} to ${violation.data.proxyAddresses.implementation}, also transferring ownership. Full data: ${upgradeAndCallData}`,
              submissionType: SubmissionType.SAFE,
            });

            // And finally change proxy admin away from deployerOwnedProxyAdmin back to the canonicalProxyAdmin
            this.pushCall(chain, {
              to: deployerOwnedProxyAdmin,
              data: canonicalProxyAdmin.interface.encodeFunctionData(
                'changeProxyAdmin',
                [igp.address, canonicalProxyAdmin.address],
              ),
              description: `Changing proxy admin for IGP ${igp.address} from deployerOwnedProxyAdmin ${deployerOwnedProxyAdmin} to canonicalProxyAdmin ${canonicalProxyAdmin.address}`,
              submissionType: SubmissionType.SAFE,
            });
          } else if (eqAddress(actualOwner, canonicalProxyAdmin.address)) {
            // For the gnosis case, where the owner is actually the canonical proxy admin
            console.log(
              `actualOwner ${actualOwner} == canonicalProxyAdmin ${canonicalProxyAdmin.address}, will upgrade and transfer ownership`,
            );
            const upgradeAndCallData =
              contracts.proxyAdmin.interface.encodeFunctionData(
                'upgradeAndCall',
                [
                  violation.data.proxyAddresses.proxy,
                  violation.data.proxyAddresses.implementation,
                  ownable.interface.encodeFunctionData('transferOwnership', [
                    expectedOwner,
                  ]),
                ],
              );
            this.pushCall(chain, {
              to: contracts.proxyAdmin.address,
              data: upgradeAndCallData,
              description: `Upgrade ${violation.data.proxyAddresses.proxy} to ${violation.data.proxyAddresses.implementation}, data: ${upgradeAndCallData}`,
              submissionType: SubmissionType.SAFE,
            });
          } else {
            throw Error('Unhandled case where the owner is wrong');
          }
        }
        break;
      default:
        throw new Error(`Unsupported proxy violation ${violation.data.name}`);
    }

    // const data = initData
    //   ? contracts.proxyAdmin.interface.encodeFunctionData('upgradeAndCall', [
    //       violation.data.proxyAddresses.proxy,
    //       violation.data.proxyAddresses.implementation,
    //       initData,
    //     ])
    //   : contracts.proxyAdmin.interface.encodeFunctionData('upgrade', [
    //       violation.data.proxyAddresses.proxy,
    //       violation.data.proxyAddresses.implementation,
    //     ]);

    // this.pushCall(chain, {
    //   to: contracts.proxyAdmin.address,
    //   data,
    //   description: `Upgrade ${violation.data.proxyAddresses.proxy} to ${violation.data.proxyAddresses.implementation}, data: ${data}`,
    // });
  }

  protected async inferCallSubmissionTypes() {
    for (const chain of Object.keys(this.calls) as Chain[]) {
      for (const call of this.calls[chain]) {
        console.log('Inferring submission type for chain', chain, 'call', call);
        if (call.submissionType == undefined) {
          console.log('Submission type undefined, inferring...');
          const submissionType = await this.inferCallSubmissionType(
            chain,
            call,
          );
          call.submissionType = submissionType;
        } else {
          console.log('Submission type defined');
        }
      }
    }
  }

  protected async inferCallSubmissionType(
    chain: Chain,
    call: AnnotatedCallData,
  ): Promise<SubmissionType> {
    const connection = this.checker.multiProvider.getChainConnection(chain);
    const signer = this.checker.multiProvider.getChainSigner(chain);
    const signerAddress = await signer.getAddress();

    const getContractOwner = async (): Promise<types.Address> => {
      const ownable = Ownable__factory.connect(call.to, signer);
      return ownable.owner();
    };

    const canUseSubmissionType = async (
      provider: Provider,
      submitterAddress: types.Address,
    ): Promise<boolean> => {
      // If onlyCheckOwnership is true, just check if the contract's owner
      // is the submitter address.
      if (call.onlyCheckOwnership) {
        console.log(
          'onlyCheckOwnership is true, checking ownership',
          call,
          submitterAddress,
          await getContractOwner(),
        );
        // Ignore because the owner is incorrectly set :|
        // if (eqAddress(submitterAddress, await getContractOwner())) {
        return true;
        // }
      } else {
        // Otherwise, check if the call will succeed with the submitter's address.
        try {
          await provider.estimateGas({
            ...call,
            from: submitterAddress,
          });
          return true;
        } catch (e) {
          console.log(
            'onlyCheckOwnership is false, got error for call',
            call,
            e,
          );
        } // eslint-disable-line no-empty
      }
      return false;
    };

    // Skipping for Mainnet -  we want to use safe

    // if (await canUseSubmissionType(connection.provider, signerAddress)) {
    //   return SubmissionType.SIGNER;
    // }

    // 2. Check if the call will succeed via Gnosis Safe.
    const safeAddress = this.checker.configMap[chain!].owner;
    if (!safeAddress) throw new Error(`Owner address not found for ${chain}`);
    // 2a. Confirm that the signer is a Safe owner or delegate.
    // This should implicitly check whether or not the owner is a gnosis
    // safe.
    if (!this.canPropose[chain].has(safeAddress)) {
      this.canPropose[chain].set(
        safeAddress,
        await canProposeSafeTransactions(
          signerAddress,
          chain,
          connection,
          safeAddress,
        ),
      );
    }

    // 2b. Check if calling from the owner/safeAddress will succeed.
    if (
      this.canPropose[chain].get(safeAddress) &&
      (await canUseSubmissionType(connection.provider, safeAddress))
    ) {
      return SubmissionType.SAFE;
    }

    return SubmissionType.MANUAL;
  }

  // pushes calls which reconcile actual and expected sets on chain
  protected pushSetReconcilationCalls<T>(reconcile: {
    chain: ChainName;
    actual: Set<T>;
    expected: Set<T>;
    add: (elem: T) => AnnotatedCallData;
    remove: (elem: T) => AnnotatedCallData;
  }) {
    // add expected - actual elements
    utils
      .difference(reconcile.expected, reconcile.actual)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.add(elem)),
      );

    // remote actual - expected elements
    utils
      .difference(reconcile.actual, reconcile.expected)
      .forEach((elem) =>
        this.pushCall(reconcile.chain as Chain, reconcile.remove(elem)),
      );
  }

  handleMultisigIsmViolation(violation: MultisigIsmViolation) {
    const multisigIsm = violation.contract;
    const remoteDomainId = ChainNameToDomainId[violation.remote];
    switch (violation.subType) {
      case MultisigIsmViolationType.EnrolledValidators: {
        const baseDescription = `as ${violation.remote} validator on ${violation.chain}`;
        this.pushSetReconcilationCalls({
          ...(violation as EnrolledValidatorsViolation),
          add: (validator) => ({
            to: multisigIsm.address,
            data: multisigIsm.interface.encodeFunctionData('enrollValidator', [
              remoteDomainId,
              validator,
            ]),
            description: `Enroll ${validator} ${baseDescription}`,
          }),
          remove: (validator) => ({
            to: multisigIsm.address,
            data: multisigIsm.interface.encodeFunctionData(
              'unenrollValidator',
              [remoteDomainId, validator],
            ),
            description: `Unenroll ${validator} ${baseDescription}`,
          }),
        });
        break;
      }
      case MultisigIsmViolationType.Threshold: {
        this.pushCall(violation.chain as Chain, {
          to: multisigIsm.address,
          data: multisigIsm.interface.encodeFunctionData('setThreshold', [
            remoteDomainId,
            violation.expected,
          ]),
          description: `Set threshold to ${violation.expected} for ${violation.remote} on ${violation.chain}`,
        });
        break;
      }
      default:
        throw new Error(
          `Unsupported multisig module violation subtype ${violation.subType}`,
        );
    }
  }

  handleOwnerViolation(violation: OwnerViolation) {
    this.pushCall(violation.chain as Chain, {
      to: violation.contract.address,
      data: violation.contract.interface.encodeFunctionData(
        'transferOwnership',
        [violation.expected],
      ),
      description: `Transfer ownership of ${violation.contract.address} to ${violation.expected}`,
    });
  }

  handleIgpViolation(violation: IgpViolation) {
    switch (violation.subType) {
      case IgpViolationType.Beneficiary: {
        const beneficiaryViolation = violation as IgpBeneficiaryViolation;
        this.pushCall(beneficiaryViolation.chain as Chain, {
          to: beneficiaryViolation.contract.address,
          data: beneficiaryViolation.contract.interface.encodeFunctionData(
            'setBeneficiary',
            [beneficiaryViolation.expected],
          ),
          description: `Set IGP beneficiary to ${beneficiaryViolation.expected}`,
          onlyCheckOwnership: true,
        });
        break;
      }
      case IgpViolationType.GasOracles: {
        const gasOraclesViolation = violation as IgpGasOraclesViolation;

        const configs: InterchainGasPaymaster.GasOracleConfigStruct[] = [];
        for (const [remote, expected] of Object.entries(
          gasOraclesViolation.expected,
        )) {
          const remoteId = ChainNameToDomainId[remote];

          configs.push({
            remoteDomain: remoteId,
            gasOracle: expected,
          });
        }

        this.pushCall(gasOraclesViolation.chain as Chain, {
          to: gasOraclesViolation.contract.address,
          data: gasOraclesViolation.contract.interface.encodeFunctionData(
            'setGasOracles',
            [configs],
          ),
          description: `Setting ${Object.keys(gasOraclesViolation.expected)
            .map((remoteStr) => {
              const remote = remoteStr as ChainName;
              const remoteId = ChainNameToDomainId[remote];
              const expected = gasOraclesViolation.expected[remote];
              return `gas oracle for ${remote} (domain ID ${remoteId}) to ${expected}`;
            })
            .join(', ')}`,
          // We expect this to be ran when the IGP implementation is being set
          // in a prior call. This means that any attempts to estimate gas will
          // be unsuccessful, so for now we settle for only checking ownership.
          // TODO: once the IGP contract upgrade has been performed, consider removing this
          onlyCheckOwnership: true,
        });
        break;
      }
      default:
        throw new Error(`Unsupported IgpViolationType: ${violation.subType}`);
    }
  }
}
