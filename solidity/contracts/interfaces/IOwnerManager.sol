// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// source: https://github.com/safe-global/safe-smart-account/blob/d9fdda990c3ff5279edfea03c1fd377abcb39b38/contracts/interfaces/IOwnerManager.sol
interface IOwnerManager {
    /**
     * @notice Returns the number of required confirmations for a Safe transaction aka the threshold.
     * @return Threshold number.
     */
    function getThreshold() external view returns (uint256);
}
