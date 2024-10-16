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
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractMessageIdAuthorizedIsm} from "./AbstractMessageIdAuthorizedIsm.sol";

// ============ External Imports ============

import {IL2toL2CrossDomainMessenger} from "../../interfaces/optimism/IL2toL2CrossDomainMessenger.sol";
import {ICrossL2Inbox} from "../../interfaces/optimism/ICrossL2Inbox.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title SuperchainISM
 * @notice Uses the native Optimism bridge to verify interchain messages from L2 to L1.
 */
contract SuperchainISM is AbstractMessageIdAuthorizedIsm {
    using TypeCasts for address;
    using Message for bytes;

    // ============ Constants ============

    // module type for the ISM
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.SUPERCHAIN);
    // L2toL2CrossDomainMessenger contract
    IL2toL2CrossDomainMessenger immutable messenger;

    // ============ Constructor ============

    constructor(address _messenger) {
        messenger = IL2toL2CrossDomainMessenger(_messenger);
        require(
            Address.isContract(_messenger),
            "SuperchainISM: invalid L2toL2CrossDomainMessenger contract"
        );
    }

    // ============ External Functions ============

    /// @inheritdoc IInterchainSecurityModule
    function verify(
        bytes calldata metadata,
        bytes calldata message
    ) external override returns (bool) {
        bool verified = isVerified(message);
        if (!verified) {
            _verifyWithMessenger(metadata, message);
            require(isVerified(message), "SuperchainIsm: message not verified");
        }
        return true;
    }

    // ============ Internal function ============

    /**
     * @notice Verify message directly using the portal.finalizeWithdrawal function.
     * @dev This is a fallback in case the message is not verified by the stateful verify function first.
     */
    function _verifyWithMessenger(
        bytes calldata metadata,
        bytes memory
    ) internal {
        (ICrossL2Inbox.Identifier memory _id, bytes memory _sentMessage) = abi
            .decode(metadata, (ICrossL2Inbox.Identifier, bytes));
        messenger.relayMessage(_id, _sentMessage);
    }

    /// @inheritdoc AbstractMessageIdAuthorizedIsm
    function _isAuthorized() internal view override returns (bool) {
        return
            msg.sender == address(messenger) &&
            messenger.crossDomainMessageSender() ==
            TypeCasts.bytes32ToAddress(authorizedHook);
    }
}
