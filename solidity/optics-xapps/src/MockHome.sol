// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

/**
  MockHome is a contract that is intended to use in testing scenarios without a full-blown optics deployment. MockReplicas can be connected to this MockHome directly. Messages are still considered to be async
 */

import "@celo-org/optics-sol/contracts/Home.sol";
import {Common} from "@celo-org/optics-sol/contracts/Common.sol";
import { MockReplica } from "./MockReplica.sol";

contract MockHome is Common {

    // Mock state variables
    mapping(uint32 => address) public mockReplicas;
    uint32[] public mockReplicaDomains;
    
    constructor(uint32 _localDomain) Common(_localDomain) {} // solhint-disable-line no-empty-blocks

    // ============ External Functions  ============

    /**
     * @notice Dispatch the message it to the destination domain & recipient
     * @dev Format the message, insert its hash into Merkle tree,
     * enqueue the new Merkle root, and emit `Dispatch` event with message information.
     * @param _destinationDomain Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _messageBody Raw bytes content of message
     */
    function dispatch(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        bytes memory _messageBody
    ) external notFailed {
      for (uint i=0;i<mockReplicaDomains.length;i++) {
        uint32 replicaDomain = mockReplicaDomains[i];
        if (replicaDomain != _destinationDomain) continue;
        MockReplica replica = MockReplica(mockReplicas[replicaDomain]);
        replica.handleMessageFromMockHome(
          localDomain,
          bytes32(uint256(uint160(msg.sender))),
          _recipientAddress,
          _messageBody
        );
        return;
      }
    }

    function addReplica(uint32 remoteDomain, address mockReplica) external {
      mockReplicaDomains.push(remoteDomain);
      mockReplicas[remoteDomain] = mockReplica;
    }


    function homeDomainHash() public view override returns (bytes32) {
        return _homeDomainHash(localDomain);
    }

        function _fail() internal override {
        // set contract to FAILED
        _setFailed();
    }
}
