// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.7.6;

/**
 * @notice Partial interface of LZ's RelayerV2 contract found at
 * https://github.com/LayerZero-Labs/LayerZero/blob/main/contracts/RelayerV2.sol.
 */
interface ILZRelayerV2 {
    struct DstPrice {
        uint128 dstPriceRatio; // 10^10
        uint128 dstGasPriceInWei;
    }

    /**
     * @notice Gets the destination prices given a LZ domain.
     * @dev Note this is implemented as a mapping in the actual RelayerV2
     * contract found at https://github.com/LayerZero-Labs/LayerZero/blob/main/contracts/RelayerV2.sol
     *   mapping(uint16 => ILZRelayerV2.DstPrice) public override dstPriceLookup;
     * The public getter for this mapping returns the struct destructured as a tuple.
     */
    function dstPriceLookup(uint16 _lzDomain)
        external
        view
        returns (uint128 dstPriceRatio, uint128 dstGasPriceInWei);
}
