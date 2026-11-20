// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../IInterchainSecurityModule.sol";

interface IWeb2SecurityModule is IInterchainSecurityModule {
    event SignersUpdated(address[] signers, uint8 threshold);
    event EndpointRegistered(bytes32 indexed endpointHash);
    event EndpointUnregistered(bytes32 indexed endpointHash);
    event Web2DomainUpdated(uint32 oldDomain, uint32 newDomain);
    event AttestationAgeLimitUpdated(uint256 oldLimit, uint256 newLimit);

    function web2Domain() external view returns (uint32);

    function threshold() external view returns (uint8);

    function signers() external view returns (address[] memory);

    function isAuthorizedSigner(address _signer) external view returns (bool);

    function isAuthorizedEndpoint(
        bytes32 _endpointHash
    ) external view returns (bool);

    function requireEndpointAuthorization() external view returns (bool);

    function maxAttestationAge() external view returns (uint256);
}
