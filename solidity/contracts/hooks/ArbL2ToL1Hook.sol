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
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {AbstractMessageIdAuthorizedIsm} from "../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";

/**
 * @title ArbL2ToL1Hook
 * @notice Message hook to inform the ArbL2ToL1iSM of messages published through
 * the native Arbitrum bridge.
 * @notice This works only for L2 -> L1 messages and has the 7 day delay as specified by the ArbSys contract.
 */
contract ArbL2ToL1Hook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    // ============ Constants ============

    // precompile contract on L2 for sending messages to L1
    ArbSys public immutable arbSys;
    // child hook to call first
    IPostDispatchHook public immutable childHook;

    // ============ Constructor ============

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _arbSys,
        address _childHook
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        arbSys = ArbSys(_arbSys);
        childHook = AbstractPostDispatchHook(_childHook);
    }

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.ARB_L2_TO_L1);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view override returns (uint256) {
        return
            metadata.msgValue(0) + childHook.quoteDispatch(metadata, message);
    }

    // ============ Internal functions ============

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (message.id(), metadata.msgValue(0))
        );

        childHook.postDispatch{
            value: childHook.quoteDispatch(metadata, message)
        }(metadata, message);
        arbSys.sendTxToL1{value: metadata.msgValue(0)}(
            TypeCasts.bytes32ToAddress(ism),
            payload
        );
    }
}
