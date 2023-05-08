// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOptimismMessageHook} from "../interfaces/hooks/IOptimismMessageHook.sol";
import {OptimismIsm} from "../isms/native/OptimismIsm.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {IL1CrossDomainMessenger} from "@eth-optimism/contracts/l1/messaging/IL1CrossDomainMessenger.sol";

contract OptimismHook is IOptimismMessageHook {
    uint32 public constant OPTIMISM_DOMAIN_ID = 10;

    IL1CrossDomainMessenger public opMessenger;
    OptimismIsm public opISM;

    uint32 gasLimit;

    constructor(IL1CrossDomainMessenger _opMessenger, uint32 _gasLimit) {
        opMessenger = _opMessenger;
        gasLimit = _gasLimit;
    }

    function postDispatch(uint32 destination, bytes32 messageId)
        external
        override
        returns (uint256)
    {
        require(
            destination == OPTIMISM_DOMAIN_ID,
            "OptimismHook: destination must be Optimism"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (messageId, msg.sender)
        );

        opMessenger.sendMessage(address(0x0), _payload, gasLimit);

        // emit OptimismMessagePublished(payload, nonce, sequence);

        // TODO: fix
        return gasleft();
    }
}
