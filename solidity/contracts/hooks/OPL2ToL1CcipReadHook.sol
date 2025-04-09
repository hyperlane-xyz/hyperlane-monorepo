// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IMailbox} from "../interfaces/IMailbox.sol";
import {TokenMessage} from "../token/libs/TokenMessage.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";

/**
 * @title OPL2ToL1CcipReadHook
 * @notice Inform an OPL2ToL1ProveWithdrawalIsm that a withdrawal has been initiated on L2
 * @dev We expect a single CCIP-read ISM executing portal.proveWithdrawal() and portal.finalizeWithdrawal() on L1 after 7 days. This is due to the fact that OP Stack expect the proof submitter and the finalizer to be the same caller.
 */
contract OPL2ToL1CcipReadHook is AbstractPostDispatchHook {
    using Message for bytes;
    using TypeCasts for address;
    using StandardHookMetadata for bytes;

    // ============ Constants  ============
    uint32 public constant PROVE_WITHDRAWAL_GAS_LIMIT = 500_000;

    IMailbox public immutable mailbox;
    bytes32 public immutable ccipReadIsm;
    IPostDispatchHook public immutable childHook;

    // ============ Constructor ============
    constructor(address _mailbox, address _ccipReadIsm, address _childHook) {
        mailbox = IMailbox(_mailbox);
        childHook = IPostDispatchHook(_childHook);
        ccipReadIsm = _ccipReadIsm.addressToBytes32();
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.OP_L2_TO_L1);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        return
            mailbox.quoteDispatch(
                message.destination(),
                ccipReadIsm,
                _getMessageBody(message),
                _getMessageMetadata(),
                childHook
            );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        // Default hook will take care of IGP payments
        mailbox.dispatch{value: msg.value}(
            message.destination(),
            ccipReadIsm,
            _getMessageBody(message),
            _getMessageMetadata(),
            childHook
        );
    }

    function _getMessageMetadata() internal view returns (bytes memory) {
        return
            StandardHookMetadata.overrideGasLimit(PROVE_WITHDRAWAL_GAS_LIMIT);
    }

    function _getMessageBody(
        bytes calldata message
    ) internal view returns (bytes memory) {
        // Body will contain the withdrawal hash already
        return abi.encode(message.id(), TokenMessage.metadata(message.body()));
    }
}
