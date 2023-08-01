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
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMessageHook} from "../../interfaces/hooks/IMessageHook.sol";
import {IMessageDispatcher} from "./interfaces/IMessageDispatcher.sol";
import {ERC5164ISM} from "../../isms/hook/ERC5164ISM.sol";

// ============ External Imports ============

import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title 5164MessageHook
 * @notice Message hook to inform the 5164 ISM of messages published through
 * any of the 5164 adapters.
 */
contract ERC5164MessageHook is IMessageHook {
    using TypeCasts for address;
    // ============ Constants ============

    // Domain of chain on which the ERC5164ISM is deployed
    uint32 public immutable destinationDomain;
    // Dispatcher used to send messages
    IMessageDispatcher public immutable dispatcher;
    // address for ERC5164ISM to verify messages
    address public immutable ism;

    // ============ Constructor ============

    constructor(
        uint32 _destinationDomain,
        address _dispatcher,
        address _ism
    ) {
        require(
            _destinationDomain != 0,
            "ERC5164Hook: invalid destination domain"
        );
        require(_ism != address(0), "ERC5164Hook: invalid ISM");
        destinationDomain = _destinationDomain;

        require(
            Address.isContract(_dispatcher),
            "ERC5164Hook: invalid dispatcher"
        );
        dispatcher = IMessageDispatcher(_dispatcher);
        ism = _ism;
    }

    // ============ External Functions ============

    /**
     * @notice Hook to inform the ERC5164ISM of messages published through.
     * @dev anyone can call this function, that's why we need to send msg.sender
     * @param _destinationDomain The destination domain of the message.
     * @param _messageId The message ID.
     * @return gasOverhead The gas overhead for the function call on destination.
     */
    function postDispatch(uint32 _destinationDomain, bytes32 _messageId)
        public
        payable
        override
        returns (uint256)
    {
        require(msg.value == 0, "ERC5164Hook: no value allowed");
        require(
            _destinationDomain == destinationDomain,
            "ERC5164Hook: invalid destination domain"
        );

        bytes memory _payload = abi.encodeCall(
            ERC5164ISM.verifyMessageId,
            (msg.sender.addressToBytes32(), _messageId)
        );

        dispatcher.dispatchMessage(_destinationDomain, ism, _payload);

        // EIP-5164 doesn't specify a gas overhead
        return 0;
    }
}
