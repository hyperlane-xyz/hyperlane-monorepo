// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";

/**
 * @title OPL2ToL1ProveWithdrawalHook
 * @notice Inform an OPL2ToL1ProveWithdrawalIsm that a withdrawal has been executed
 * on L2
 * @dev We expect a CCIP-read ISM executing portal.proveWithdrawal() on destination
 * after 7 days
 */
contract OPL2ToL1ProveWithdrawalHook is AbstractMessageIdAuthHook {
    using TokenMessage for bytes;

    // ============ Constants  ============
    uint32 public constant DOMAIN_ETH_SEPOLIA = 11155111;
    uint32 public constant DOMAIN_ETH_MAINNET = 1;

    // ============ Constructor ============
    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {}

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        return mailbox.quoteDispatch(destinationDomain, ism, message);
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        mailbox.dispatch(destinationDomain, ism, message);
    }
}
