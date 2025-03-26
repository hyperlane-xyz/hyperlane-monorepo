// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {InterchainGasPaymaster} from "../hooks/igp/InterchainGasPaymaster.sol";

/**
 * @title OPL2ToL1CcipReadHook
 * @notice Inform an OPL2ToL1ProveWithdrawalIsm that a withdrawal has been initiated
 * on L2
 * @dev We expect a CCIP-read ISM executing portal.proveWithdrawal() on destination
 * after 7 days
 */
contract OPL2ToL1CcipReadHook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using TokenMessage for bytes;

    // ============ Constants  ============
    uint32 public constant MIN_GAS_LIMIT = 500_000;

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
        return mailbox.quoteDispatch(destinationDomain, ism, message, metadata);
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        mailbox.dispatch{value: msg.value}(
            destinationDomain,
            ism,
            message,
            metadata
        );
    }
}
