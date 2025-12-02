// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";

/**
 * @title Hyperlane OPL2ToL1Withdrawal Library
 * @notice Library to calculate the withdrawal hash for OPL2ToL1CcipReadIsm
 * validation
 */
library OPL2ToL1Withdrawal {
    /// @dev Copied from Hashing.sol of Optimism
    function hashWithdrawal(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    _tx.nonce,
                    _tx.sender,
                    _tx.target,
                    _tx.value,
                    _tx.gasLimit,
                    _tx.data
                )
            );
    }

    function encodeData(
        bytes32 _proveMessageId,
        bytes32 _finalizeMessageId
    ) internal pure returns (bytes memory) {
        return abi.encode(_proveMessageId, _finalizeMessageId);
    }

    function proveMessageId(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal pure returns (bytes32) {
        (bytes32 _proveMessageId, ) = abi.decode(_tx.data, (bytes32, bytes32));
        return _proveMessageId;
    }

    function finalizeMessageId(
        IOptimismPortal.WithdrawalTransaction memory _tx
    ) internal pure returns (bytes32) {
        (, bytes32 _finalizeMessageId) = abi.decode(
            _tx.data,
            (bytes32, bytes32)
        );
        return _finalizeMessageId;
    }
}
