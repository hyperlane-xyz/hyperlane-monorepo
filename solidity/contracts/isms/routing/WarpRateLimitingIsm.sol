// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {DomainRoutingIsm} from "./DomainRoutingIsm.sol";
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title WarpRateLimitingIsm
 * @notice A contract to manage rate limits for various origins in the Hyperlane protocol.
 * @dev Inherits from DomainRoutingIsm and provides additional functionalities to set and manage rate limits.
 */
contract WarpRateLimitingIsm is DomainRoutingIsm {
    using Message for bytes;

    // Mapping of domain to its rate limit
    mapping(uint32 => uint256) rateLimitMap;

    // Event emitted when a rate limit is set for a domain
    event RateLimitSet(uint32 indexed domain, uint256 rateLimit);

    /**
     * @notice Constructor for the WarpRateLimitingIsm contract.
     * @dev Initializes rate limits for a set of origins.
     * @param _origins Array of origin domain IDs.
     * @param _rateLimits Array of rate limits corresponding to the _origins.
     */
    constructor(uint32[] memory _origins, uint256[] memory _rateLimits) {
        require(
            _origins.length == _rateLimits.length,
            "WarpRateLimitingIsm: INVALID_ARGS"
        );

        for (uint256 i = 0; i < _origins.length; i++) {
            rateLimitMap[_origins[i]] = _rateLimits[i];
        }
    }

    /**
     * @notice Sets the rate limit for a specific origin.
     * @dev Can only be called by the contract owner.
     * @param _origin The domain ID of the origin.
     * @param _rateLimit The rate limit to set for the given origin.
     */
    function setRateLimit(uint32 _origin, uint256 _rateLimit)
        external
        onlyOwner
    {
        rateLimitMap[_origin] = _rateLimit;

        emit RateLimitSet(_origin, _rateLimit);
    }

    /**
     * @notice Determines the appropriate ISM to verify a given message based on its rate limit.
     * @dev Uses the message's origin to check against the rate limit map.
     * @param _message Formatted Hyperlane message (see Message.sol).
     * @return module The ISM to use to verify _message.
     */
    function route(bytes calldata _message)
        public
        view
        override
        returns (IInterchainSecurityModule)
    {
        require(
            uint256(bytes32(_message.body()[32:64])) <
                rateLimitMap[_message.origin()]
        );

        return modules(_message.origin());
    }
}
