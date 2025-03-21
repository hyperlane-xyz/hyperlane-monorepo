// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {InterchainGasPaymaster} from "../hooks/igp/InterchainGasPaymaster.sol";

/**
 * @title OPL2ToL1ProveWithdrawalHook
 * @notice Inform an OPL2ToL1ProveWithdrawalIsm that a withdrawal has been executed
 * on L2
 * @dev We expect a CCIP-read ISM executing portal.proveWithdrawal() on destination
 * after 7 days
 */
contract OPL2ToL1ProveWithdrawalHook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using TokenMessage for bytes;

    // ============ Constants  ============
    uint32 public constant MIN_GAS_LIMIT = 500_000;

    // FIXME: make it configurable
    InterchainGasPaymaster public constant igp =
        InterchainGasPaymaster(
            address(0x28B02B97a850872C4D33C3E024fab6499ad96564)
        );

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
        return
            mailbox.quoteDispatch(
                destinationDomain,
                ism,
                message,
                StandardHookMetadata.overrideGasLimit(MIN_GAS_LIMIT)
            );
        // + igp.quoteDispatch(metadata, message);
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        // uint256 relayFees1 = igp.quoteDispatch(metadata, message);
        uint256 relayFees2 = mailbox.quoteDispatch(
            destinationDomain,
            ism,
            message,
            StandardHookMetadata.overrideGasLimit(MIN_GAS_LIMIT)
        );

        // igp.postDispatch{value: relayFees1}(metadata, message);
        mailbox.dispatch{value: relayFees2}(
            destinationDomain,
            ism,
            message,
            StandardHookMetadata.overrideGasLimit(MIN_GAS_LIMIT)
        );
    }
}
