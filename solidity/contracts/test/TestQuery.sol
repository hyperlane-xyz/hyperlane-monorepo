// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {InterchainQueryRouter} from "../middleware/InterchainQueryRouter.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {CallLib} from "../libs/Call.sol";

contract TestQuery {
    InterchainQueryRouter public router;

    event Owner(uint256, address);

    constructor(address _router) {
        router = InterchainQueryRouter(_router);
    }

    /**
     * @dev Fetches owner of InterchainQueryRouter on provided domain and passes along with provided secret to `this.receiveRouterOwner`
     */
    function queryRouterOwner(uint32 domain, uint256 secret) external {
        address target = TypeCasts.bytes32ToAddress(router.routers(domain));
        CallLib.CallWithCallback[]
            memory calls = new CallLib.CallWithCallback[](1);
        calls[0] = CallLib.CallWithCallback({
            _call: CallLib.StaticCall({
                to: target,
                data: abi.encodeWithSignature("owner()")
            }),
            callback: bytes.concat(
                this.receiveRouterOwer.selector,
                bytes32(secret)
            )
        });
        router.query(domain, calls);
    }

    /**
     * @dev `msg.sender` must be restricted to `this.router` to prevent any local account from spoofing query data.
     */
    function receiveRouterOwer(uint256 secret, address owner) external {
        require(msg.sender == address(router), "TestQuery: not from router");
        emit Owner(secret, owner);
    }
}
