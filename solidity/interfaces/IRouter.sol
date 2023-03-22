// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IRouter {
    function domains() external view returns (uint32[] memory);

    function routers(uint32 _domain) external view returns (bytes32);

    function enrollRemoteRouter(uint32 _domain, bytes32 _router) external;

    function enrollRemoteRouters(
        uint32[] calldata _domains,
        bytes32[] calldata _routers
    ) external;
}
