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

interface OpL2toL1Service {
    function getWithdrawalProof(
        bytes calldata _message
    )
        external
        view
        returns (
            IOptimismPortal.WithdrawalTransaction memory _tx,
            uint256 _disputeGameIndex,
            IOptimismPortal.OutputRootProof memory _outputRootProof,
            bytes[] memory _withdrawalProof
        );
    function getFinalizeWithdrawalTx(
        bytes calldata _message
    ) external view returns (IOptimismPortal.WithdrawalTransaction memory _tx);
}

/**
 * @notice Prove and finalize a OP stack withdrawal on L1
 * @dev Proving and finalizing had been merged into a single
 * ISM because OP Stack expects the prover and the finalizer to
 * be the same caller
 */
contract OPL2ToL1CcipReadIsm is
    AbstractCcipReadIsm,
    IMessageRecipient,
    ISpecifiesInterchainSecurityModule
{
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant OP_PORTAL_VERSION_1 = 1;
    uint32 internal constant OP_PORTAL_VERSION_2 = 2;

    // OP Portal version
    uint32 immutable opPortalVersion;

    // the OP Portal contract on L1
    IOptimismPortal public immutable opPortal;

    event ReceivedMessage(
        uint32 indexed origin,
        bytes32 indexed sender,
        uint256 indexed value,
        bytes message
    );

    constructor(
        string[] memory _urls,
        address _opPortal,
        uint32 _opPortalVersion
    ) {
        require(
            _opPortalVersion == OP_PORTAL_VERSION_1 ||
                _opPortalVersion == OP_PORTAL_VERSION_2,
            "Unsupported OP portal version"
        );
        opPortalVersion = _opPortalVersion;
        opPortal = IOptimismPortal(_opPortal);
        _transferOwnership(msg.sender);
        setUrls(_urls);
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view override returns (bytes memory) {
        return
            _areWeMessageRecipient(_message)
                ? abi.encodeCall(OpL2toL1Service.getWithdrawalProof, (_message))
                : abi.encodeCall(
                    OpL2toL1Service.getFinalizeWithdrawalTx,
                    (_message)
                );
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
        if (opPortalVersion == OP_PORTAL_VERSION_1) {
            IOptimismPortal.ProvenWithdrawal memory provenWithdrawal = opPortal
                .provenWithdrawals(_withdrawalHash);
            return provenWithdrawal.timestamp > 0;
        } else if (opPortalVersion == OP_PORTAL_VERSION_2) {
            IOptimismPortal2.ProvenWithdrawal
                memory provenWithdrawal = IOptimismPortal2(address(opPortal))
                    .provenWithdrawals(_withdrawalHash, address(this));
            return provenWithdrawal.timestamp > 0;
        }

        // Can't reach here because contract can't be
        // created with other versions values
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
