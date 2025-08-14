// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IStaticDelegateCallable {
    /**
     * @notice Make a delegatecall from this contract to a given target contract with a particular data (always reverts with a return data).
     * @param target address of the contract to make a delegatecall to
     * @param data data to make a delegatecall with
     * @dev It allows to use this contract's storage on-chain.
     */
    function staticDelegateCall(address target, bytes calldata data) external;
}
