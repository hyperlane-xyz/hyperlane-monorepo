// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMailbox} from "../../interfaces/IMailbox.sol";
import {PackageVersioned} from "../../PackageVersioned.sol";
import {OPL2ToL1Withdrawal} from "../../libs/OPL2ToL1Withdrawal.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {IOptimismPortal} from "../../interfaces/optimism/IOptimismPortal.sol";
import {IOptimismPortal2} from "../../interfaces/optimism/IOptimismPortal2.sol";
import {IInterchainSecurityModule, ISpecifiesInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";

/**
 * @notice Prove and finalize a OP stack withdrawal on L1
 * @dev Proving and finalizing had been merged into a single
 * ISM because OP Stack expects the prover and the finalizer to
 * be the same caller
 */
contract OPL2ToL1CcipReadIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule,
    PackageVersioned
{
    using Message for bytes;
    using TypeCasts for address;

    // CCIP-read gateways URLs
    string[] public urls;
    // mailbox on L1
    IMailbox public immutable mailbox;
    // the OP Portal contract on L1
    IOptimismPortal public immutable opPortal;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        uint256 indexed value,
        bytes message
    );

    constructor(string[] memory _urls, address _opPortal, address _mailbox) {
        require(_urls.length > 0, "URLs array is empty");
        urls = _urls;
        mailbox = IMailbox(_mailbox);
        opPortal = IOptimismPortal(_opPortal);
    }

    function getOffchainVerifyInfo(
        bytes calldata _message
    ) external view override {
        bytes memory ccipReadCallData = _areWeMessageRecipient(_message)
            ? abi.encodeWithSignature("getWithdrawalProof(bytes)", _message)
            : abi.encodeWithSignature(
                "getFinalizeWithdrawalTx(bytes)",
                _message
            );

        revert OffchainLookup(
            address(this),
            urls,
            ccipReadCallData,
            OPL2ToL1CcipReadIsm.process.selector,
            _message
        );
    }

    /// @dev called by the relayer when the off-chain data is ready
    function process(
        bytes calldata _metadata,
        bytes calldata _message
    ) external {
        mailbox.process(_metadata, _message);
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        if (_areWeMessageRecipient(_message)) {
            _proveWithdrawal(_metadata, _message);
        } else {
            _finalizeWithdrawal(_metadata, _message);
        }

        return true;
    }

    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _messageBody
    ) external payable {
        emit ReceivedMessage(_origin, _sender, msg.value, _messageBody);
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    function _areWeMessageRecipient(
        bytes calldata _message
    ) internal view returns (bool) {
        return _message.recipientAddress() == address(this);
    }

    function _proveWithdrawal(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) internal {
        (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        ) = abi.decode(
                _metadata,
                (
                    IOptimismPortal.WithdrawalTransaction,
                    uint256,
                    IOptimismPortal.OutputRootProof,
                    bytes[]
                )
            );

        bytes32 withdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(_tx);

        // Proving only if the withdrawal wasn't
        // proven already by this contract
        if (!_isWithdrawalProvenAlready(withdrawalHash)) {
            opPortal.proveWithdrawalTransaction(
                _tx,
                _disputeGameIndex,
                _outputRootProof,
                _withdrawalProof
            );
        }
    }

    /// @dev we handle the access to the provenWithdrawal mapping
    /// for OptimismPortal version 1 and version 2
    function _isWithdrawalProvenAlready(
        bytes32 _withdrawalHash
    ) internal view returns (bool) {
        try opPortal.provenWithdrawals(_withdrawalHash) returns (
            IOptimismPortal.ProvenWithdrawal memory provenWithdrawal
        ) {
            return provenWithdrawal.timestamp > 0;
        } catch {
            IOptimismPortal2.ProvenWithdrawal
                memory provenWithdrawal = IOptimismPortal2(address(opPortal))
                    .provenWithdrawals(_withdrawalHash, address(this));
            return provenWithdrawal.timestamp > 0;
        }
    }

    function _finalizeWithdrawal(
        bytes calldata _metadata,
        bytes calldata /* _message */
    ) internal {
        IOptimismPortal.WithdrawalTransaction memory _tx = abi.decode(
            _metadata,
            (IOptimismPortal.WithdrawalTransaction)
        );

        bytes32 withdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(_tx);

        if (!opPortal.finalizedWithdrawals(withdrawalHash)) {
            opPortal.finalizeWithdrawalTransaction(_tx);
        }
    }
}
