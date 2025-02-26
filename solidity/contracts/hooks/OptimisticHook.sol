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
import {AbstractMessageIdAuthHook} from "./libs/AbstractMessageIdAuthHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {InterchainAccountRouter} from "../middleware/InterchainAccountRouter.sol";

// ============ External Imports ============
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title Optimistic Hook
 */
contract OptimisticHook is AbstractMessageIdAuthHook {
    using TypeCasts for bytes32;

    InterchainAccountRouter public immutable interchainAccountRouter;

    // ============ Constructor ============
    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _interchainAccountRouter
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        require(
            Address.isContract(_interchainAccountRouter),
            "OptimisticHook: invalid interchain account router"
        );
        interchainAccountRouter = InterchainAccountRouter(
            _interchainAccountRouter
        );
    }

    // ============ Internal functions ============
    function _quoteDispatch(
        bytes calldata,
        bytes calldata
    ) internal view override returns (uint256) {
        return interchainAccountRouter.quoteGasPayment(destinationDomain);
    }

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata /*metadata*/,
        bytes memory payload
    ) internal override {
        interchainAccountRouter.callRemote{value: msg.value}(
            destinationDomain,
            ism.bytes32ToAddress(),
            uint256(0),
            payload
        );
    }
}
