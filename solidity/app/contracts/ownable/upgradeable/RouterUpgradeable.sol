// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {AbacusConnectionClientUpgradeable} from "./AbacusConnectionClientUpgradeable.sol";
import {Router} from "../../Router.sol";

abstract contract RouterUpgradeable is
    Router,
    AbacusConnectionClientUpgradeable
{
    // simply a callthrough but included here for clarity of abstraction
    function __Router_init(
        address _abacusConnectionManager,
        address _interchainGasPaymaster
    ) internal onlyInitializing {
        __AbacusConnectionClient_init(
            _abacusConnectionManager,
            _interchainGasPaymaster
        );
    }

    /**
     * @notice Register the address of a Router contract for the same Application on a remote chain
     * @param _domain The domain of the remote Application Router
     * @param _router The address of the remote Application Router
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router)
        external
        onlyOwner
    {
        _enrollRemoteRouter(_domain, _router);
    }
}
