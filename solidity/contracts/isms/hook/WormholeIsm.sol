// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IWormhole} from "../../interfaces/IWormhole.sol";
import {Message} from "../../libs/Message.sol";

/**
 * @title WormholeIsm
 * @notice Verifies a Hyperlane message by checking a Wormhole VAA (passed as
 * metadata) that attests to the message id. The VAA must originate from the
 * authorized WormholeHook emitter on the expected origin chain.
 * @dev moduleType is NULL because the relayer must supply the VAA as opaque
 * metadata fetched off-chain from the guardian network.
 */
contract WormholeIsm is IInterchainSecurityModule {
    using Message for bytes;

    uint8 public constant moduleType = uint8(Types.NULL);

    IWormhole public immutable wormhole;
    /// @notice Wormhole chain id of the origin chain (not the EVM chain id).
    uint16 public immutable emitterChainId;
    /// @notice left-padded address of the authorized WormholeHook on origin.
    bytes32 public immutable emitterAddress;

    constructor(
        address _wormhole,
        uint16 _emitterChainId,
        bytes32 _emitterAddress
    ) {
        require(_wormhole != address(0), "WormholeIsm: invalid wormhole");
        require(_emitterAddress != bytes32(0), "WormholeIsm: invalid emitter");
        wormhole = IWormhole(_wormhole);
        emitterChainId = _emitterChainId;
        emitterAddress = _emitterAddress;
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view returns (bool) {
        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole
            .parseAndVerifyVM(_metadata);
        require(valid, reason);
        require(
            vm.emitterChainId == emitterChainId,
            "WormholeIsm: wrong emitter chain"
        );
        require(
            vm.emitterAddress == emitterAddress,
            "WormholeIsm: wrong emitter address"
        );
        require(
            abi.decode(vm.payload, (bytes32)) == _message.id(),
            "WormholeIsm: message id mismatch"
        );
        return true;
    }
}
