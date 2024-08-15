// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

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

// ============ Internal Imports ============
import {AbstractPostDispatchHook, AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";

/**
 * @title OPL2ToL1Hook
 * @notice Message hook to inform the OPL2ToL1Ism of messages published through
 * the native Optimism bridge.
 * @notice This works only for L2 -> L1 messages and has the 7 day delay as specified by the OptimismPortal contract.
 */
contract OPL2ToL1Hook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;

    // ============ Constants ============

    // precompile contract on L2 for sending messages to L1
    ICrossDomainMessenger public immutable l2Messenger;
    // Immutable quote amount
    uint32 public immutable GAS_QUOTE;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _l2Messenger,
        uint32 _gasQuote
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        GAS_QUOTE = _gasQuote;
        l2Messenger = ICrossDomainMessenger(_l2Messenger);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.OP_L2_TO_L1);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal view override returns (uint256) {
        return GAS_QUOTE;
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        l2Messenger.sendMessage{value: metadata.msgValue(0)}(
            TypeCasts.bytes32ToAddress(ism),
            payload,
            GAS_QUOTE
        );
    }
}
