// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Router} from "../client/Router.sol";
import {TronTypeCasts} from "./TronTypeCasts.sol";

/**
 * @title TronRouter
 * @notice Tron-specific Router implementation
 * @dev Handles Tron address conversions in routing
 */
contract TronRouter is Router {
    using TronTypeCasts for address;

    /**
     * @notice Constructor
     * @param _mailbox The address of the mailbox contract
     */
    constructor(address _mailbox) Router(_mailbox) {}

    /**
     * @notice Enrolls a remote router for a specific domain
     * @dev Override to handle Tron address format
     * @param _domain The domain of the remote router
     * @param _router The address of the remote router as bytes32
     */
    function enrollRemoteRouter(uint32 _domain, bytes32 _router) external virtual onlyOwner {
        _enrollRemoteRouter(_domain, _router);
    }

    /**
     * @notice Returns the remote router address for a domain
     * @dev Override to handle Tron address format
     * @param _domain The domain to query
     * @return The remote router address as bytes32
     */
    function remoteRouters(uint32 _domain) external view returns (bytes32) {
        return _remoteRouters[_domain];
    }

    /**
     * @notice Internal function to check if an address is a remote router
     * @dev Uses Tron address conversion
     * @param _domain The domain to check
     * @param _potentialRemoteRouter The address to check
     * @return True if the address is a remote router
     */
    function _isRemoteRouter(
        uint32 _domain,
        bytes32 _potentialRemoteRouter
    ) internal view override returns (bool) {
        return _remoteRouters[_domain] == _potentialRemoteRouter;
    }

    /**
     * @notice Internal function to get the remote router for a domain
     * @dev Uses Tron address conversion
     * @param _domain The domain to query
     * @return The remote router address as bytes32
     */
    function _mustHaveRemoteRouter(
        uint32 _domain
    ) internal view override returns (bytes32) {
        bytes32 _router = _remoteRouters[_domain];
        require(_router != bytes32(0), "TronRouter: No router enrolled for domain");
        return _router;
    }
}
