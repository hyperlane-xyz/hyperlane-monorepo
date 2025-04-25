// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface INetworkMiddlewareService {
    error AlreadySet();
    error NotNetwork();

    /**
     * @notice Emitted when a middleware is set for a network.
     * @param network address of the network
     * @param middleware new middleware of the network
     */
    event SetMiddleware(address indexed network, address middleware);

    /**
     * @notice Get the network registry's address.
     * @return address of the network registry
     */
    function NETWORK_REGISTRY() external view returns (address);

    /**
     * @notice Get a given network's middleware.
     * @param network address of the network
     * @return middleware of the network
     */
    function middleware(address network) external view returns (address);

    /**
     * @notice Set a new middleware for a calling network.
     * @param middleware new middleware of the network
     */
    function setMiddleware(address middleware) external;
}
