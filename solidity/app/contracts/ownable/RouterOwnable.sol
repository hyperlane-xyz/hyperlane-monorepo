// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import {Router} from "../Router.sol";
import {AbacusConnectionClientOwnable} from "./AbacusConnectionClientOwnable.sol";

abstract contract RouterOwnable is Router, AbacusConnectionClientOwnable {
    constructor(
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    )
        AbacusConnectionClientOwnable(
            _abacusConnectionManager,
            _interchainGasPaymaster
        )
    {}

    /**
     * @notice Register the address of a Router contract for the same Application on a remote chain
     * @param _domain The domain of the remote Application Router
     * @param _router The address of the remote Application Router
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router)
        external
        virtual
        onlyOwner
    {
        _enrollRemoteRouter(_domain, _router);
    }
}
