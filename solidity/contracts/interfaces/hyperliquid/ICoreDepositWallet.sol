// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

interface ICoreDepositWallet {
    function deposit(uint256 amount, uint32 destinationDex) external;

    function depositFor(
        address recipient,
        uint256 amount,
        uint32 destinationDex
    ) external;

    function depositWithAuth(
        address from,
        address recipient,
        uint256 amount,
        uint32 destinationDex,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}
