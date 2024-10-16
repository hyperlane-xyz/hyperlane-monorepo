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
import {IL2toL2CrossDomainMessenger} from "../interfaces/optimism/IL2toL2CrossDomainMessenger.sol";

/**
 * @title SuperchainHook
 * @notice Message hook to send messages to L2 using the native Superchain interop.
 */
contract SuperchainHook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    // ============ Constants ============

    // precompile contract on L2 for sending messages to L2
    IL2toL2CrossDomainMessenger public immutable messenger;
    // Immutable quote amount
    uint32 public immutable GAS_QUOTE;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _messenger,
        uint32 _gasQuote
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        GAS_QUOTE = _gasQuote;
        messenger = IL2toL2CrossDomainMessenger(_messenger);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.SUPERCHAIN);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal view override returns (uint256) {
        // TODO: Request from a IGP as a child hook like https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/9093369186993468571b5d411e712ddd9a30c98c/solidity/contracts/hooks/ArbL2ToL1Hook.sol#L85
        return GAS_QUOTE;
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes memory payload
    ) internal override {
        require(
            msg.value >= metadata.msgValue(0) + GAS_QUOTE,
            "SuperchainHook: insufficient msg.value"
        );
        messenger.sendMessage(
            destinationDomain,
            TypeCasts.bytes32ToAddress(ism),
            payload
        );
    }
}
