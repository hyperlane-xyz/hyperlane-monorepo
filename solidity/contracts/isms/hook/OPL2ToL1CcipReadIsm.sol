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
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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
abstract contract OPL2ToL1CcipReadIsm is AbstractCcipReadIsm {
    using Message for bytes;
    using TypeCasts for address;

    // the OP Portal contract on L1
    IOptimismPortal public immutable opPortal;

    constructor(address _opPortal) {
        require(
            Address.isContract(_opPortal),
            "OPL2ToL1CcipReadIsm: invalid opPortal"
        );
        opPortal = IOptimismPortal(_opPortal);
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal view override returns (bytes memory) {
        return
            _isProve(_message)
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
        if (_isProve(_message)) {
            _proveWithdrawal(_metadata);
        } else {
            _finalizeWithdrawal(_metadata);
        }

        return true;
    }

    function _isProve(
        bytes calldata _message
    ) internal view virtual returns (bool);

    function _proveWithdrawal(bytes calldata _metadata) internal {
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

    function _isWithdrawalProvenAlready(
        bytes32 _withdrawalHash
    ) internal view virtual returns (bool);

    function _finalizeWithdrawal(bytes calldata _metadata) internal {
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

abstract contract OPL2ToL1V1CcipReadIsm is OPL2ToL1CcipReadIsm {
    function _isWithdrawalProvenAlready(
        bytes32 _withdrawalHash
    ) internal view override returns (bool) {
        IOptimismPortal.ProvenWithdrawal memory provenWithdrawal = opPortal
            .provenWithdrawals(_withdrawalHash);
        return provenWithdrawal.timestamp > 0;
    }
}

abstract contract OPL2ToL1V2CcipReadIsm is OPL2ToL1CcipReadIsm {
    function _isWithdrawalProvenAlready(
        bytes32 _withdrawalHash
    ) internal view override returns (bool) {
        IOptimismPortal2.ProvenWithdrawal
            memory provenWithdrawal = IOptimismPortal2(address(opPortal))
                .provenWithdrawals(_withdrawalHash, address(this));
        return provenWithdrawal.timestamp > 0;
    }
}
