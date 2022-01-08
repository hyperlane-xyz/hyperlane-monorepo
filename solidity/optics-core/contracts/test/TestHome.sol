// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Home.sol";
import "./TestReplica.sol";

contract TestHome is Home {
    using QueueLib for QueueLib.Queue;
    using MerkleLib for MerkleLib.Tree;

     // Mock state variables
    mapping(uint32 => address) public mockReplicas;
    uint32[] public mockReplicaDomains;
    
    constructor(uint32 _localDomain) Home(_localDomain) {} // solhint-disable-line no-empty-blocks

    function nextLeafIndex() external view returns (uint256) {
        return count();
    }

    function testHomeDomainHash() external view returns (bytes32) {
        return homeDomainHash();
    }

    function testDestinationAndNonce(uint32 _destination, uint32 _nonce)
        external
        pure
        returns (uint64)
    {
        return _destinationAndNonce(_destination, _nonce);
    }

    function addReplica(uint32 remoteDomain, address mockReplica) external {
      mockReplicaDomains.push(remoteDomain);
      mockReplicas[remoteDomain] = mockReplica;
    }

    function dispatch(
    uint32 _destinationDomain,
    bytes32 _recipientAddress,
    bytes memory _messageBody
    ) external override notFailed {
      for (uint i=0;i<mockReplicaDomains.length;i++) {
        uint32 replicaDomain = mockReplicaDomains[i];
        if (replicaDomain != _destinationDomain) continue;
        TestReplica replica = TestReplica(mockReplicas[replicaDomain]);
        replica.handleMessageFromMockHome(
          localDomain,
          bytes32(uint256(uint160(msg.sender))),
          _recipientAddress,
          _messageBody
        );
        return;
      }
    }

    function setFailed() public {
        _setFailed();
    }
}
