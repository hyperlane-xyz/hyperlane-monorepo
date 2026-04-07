// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.24;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

import {TransientStorage} from "./TransientStorage.sol";

/**
 * @title ReentrancyGuardTransient
 * @notice Reentrancy guard using EIP-1153 transient storage.
 * @dev Drop-in replacement for OpenZeppelin's ReentrancyGuard that avoids
 *      the cold SLOAD/SSTORE cost by using transient storage instead.
 *      The guard is automatically cleared at the end of each transaction.
 */
abstract contract ReentrancyGuardTransient {
    using TransientStorage for bytes32;

    bytes32 private constant _REENTRANCY_SLOT =
        keccak256("hyperlane.reentrancyGuard");

    error ReentrancyGuardReentrantCall();

    modifier nonReentrant() {
        if (_REENTRANCY_SLOT.loadBool()) revert ReentrancyGuardReentrantCall();
        _REENTRANCY_SLOT.set();
        _;
        _REENTRANCY_SLOT.clear();
    }
}
