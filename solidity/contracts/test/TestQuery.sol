// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {InterchainQueryRouter} from "../middleware/InterchainQueryRouter.sol";
import {Call} from "../OwnableMulticall.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

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
        Call memory call = Call({
            to: TypeCasts.bytes32ToAddress(router.routers(domain)),
            data: abi.encodeWithSignature("owner()")
        });
        bytes memory callback = bytes.concat(
            this.receiveRouterOwer.selector,
            bytes32(secret)
        );
        router.query(domain, call, callback);
    }

    /**
     * @dev `msg.sender` must be restricted to `this.router` to prevent any local account from spoofing query data.
     */
    function receiveRouterOwer(uint256 secret, address owner) external {
        require(msg.sender == address(router), "TestQuery: not from router");
        emit Owner(secret, owner);
    }
}
