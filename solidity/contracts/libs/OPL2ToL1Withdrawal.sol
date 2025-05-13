// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";
import {ICrossDomainMessenger, IL2ToL1MessagePasser} from "../interfaces/optimism/ICrossDomainMessenger.sol";

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
}
