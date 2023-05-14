// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOptimismMessageHook} from "../interfaces/hooks/IOptimismMessageHook.sol";
import {OptimismIsm} from "../isms/native/OptimismIsm.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";

/**
 * @title OptimismMessageHook
 * @notice Message hook to inform the Optimism ISM of messages published through
 * the native Optimism bridge.
 */
contract OptimismMessageHook is IOptimismMessageHook {
    // Domain of chain on which the optimism ISM is deployed
    uint32 public immutable destinationDomain;
    // Messenger used to send messages from L1 -> L2
    ICrossDomainMessenger public opMessenger;
    // Optimism ISM to verify messages
    OptimismIsm public opISM;
    // Gas limit for sending messages to L2, predefined by Optimism
    uint32 internal constant GAS_LIMIT = 1_920_000;

    constructor(uint32 _destinationDomain, ICrossDomainMessenger _opMessenger) {
        destinationDomain = _destinationDomain;
        opMessenger = _opMessenger;
    }

    function setOptimismISM(address _opISM) external {
        require(
            address(opISM) == address(0),
            "OptimismHook: opISM already set"
        );
        opISM = OptimismIsm(_opISM);
    }

    function postDispatch(uint32 _destination, bytes32 _messageId)
        external
        override
        returns (uint256)
    {
        require(
            _destination == destinationDomain,
            "OptimismHook: invalid destination domain"
        );
        require(
            address(opISM) != address(0),
            "OptimismHook: OptimismIsm not set"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (_messageId, msg.sender)
        );

        opMessenger.sendMessage(address(opISM), _payload, GAS_LIMIT);

        emit OptimismMessagePublished(address(opISM), msg.sender, _messageId);

        return GAS_LIMIT;
    }
}
