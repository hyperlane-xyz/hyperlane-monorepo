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
import {IWormhole} from "../../interfaces/IWormhole.sol";
import {Message} from "../../libs/Message.sol";
import {AbstractCcipReadIsm} from "../ccip-read/AbstractCcipReadIsm.sol";

/**
 * @notice ABI surface the offchain-lookup-server implements for Wormhole.
 * @dev The relayer encodes a call to `getVaa` and posts it to the CCIP-read
 * url; the server returns the signed VAA which is handed back to `verify`.
 */
interface WormholeVaaService {
    function getVaa(
        bytes calldata _message
    ) external view returns (bytes memory _vaa);
}

/**
 * @title WormholeIsm
 * @notice CCIP-read ISM that verifies a Hyperlane message against a Wormhole
 * VAA attesting to the message id. The VAA is fetched offchain (from the
 * guardian network, via the offchain-lookup-server) and verified on-chain by
 * the Wormhole Core Bridge.
 */
contract WormholeIsm is AbstractCcipReadIsm {
    using Message for bytes;

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
        _disableInitializers();
    }

    function initialize(
        address _owner,
        string[] memory _urls
    ) external initializer {
        // Take ownership first so the onlyOwner setUrls call succeeds, then
        // hand ownership to the configured owner.
        __Ownable_init();
        setUrls(_urls);
        _transferOwnership(_owner);
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return abi.encodeCall(WormholeVaaService.getVaa, (_message));
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external view returns (bool) {
        bytes memory vaa = abi.decode(_metadata, (bytes));

        (IWormhole.VM memory vm, bool valid, string memory reason) = wormhole
            .parseAndVerifyVM(vaa);
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
