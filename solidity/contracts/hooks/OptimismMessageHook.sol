// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============
import {IOptimismMessageHook} from "../interfaces/hooks/IOptimismMessageHook.sol";
import {OptimismIsm} from "../isms/native/OptimismIsm.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";

contract OptimismMessageHook is IOptimismMessageHook {
    uint32 public constant OPTIMISM_DOMAIN = 10;

    ICrossDomainMessenger public opMessenger;
    OptimismIsm public opISM;

    uint32 internal constant GAS_LIMIT = 1_920_000;

    constructor(ICrossDomainMessenger _opMessenger) {
        opMessenger = _opMessenger;
    }

    function setOptimismISM(address _opISM) external {
        require(
            address(opISM) == address(0),
            "OptimismHook: opISM already set"
        );
        opISM = OptimismIsm(_opISM);
    }

    function postDispatch(uint32 destination, bytes32 messageId)
        external
        override
        returns (uint256)
    {
        require(
            destination == OPTIMISM_DOMAIN,
            "OptimismHook: destination must be Optimism"
        );
        require(
            address(opISM) != address(0),
            "OptimismHook: OptimismIsm not set"
        );

        bytes memory _payload = abi.encodeCall(
            OptimismIsm.receiveFromHook,
            (messageId, address(this))
        );

        opMessenger.sendMessage(address(opISM), _payload, GAS_LIMIT);

        emit OptimismMessagePublished(address(opISM), address(this), messageId);

        // TODO: fix
        return gasleft();
    }
}
