// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.7.6;

import {ILZRelayerV2} from "../../interfaces/ILZRelayerV2.sol";

// Mocked version of https://github.com/LayerZero-Labs/LayerZero/blob/main/contracts/RelayerV2.sol
contract MockLZRelayerV2 is ILZRelayerV2 {
    // LZ domain => DstPrice
    mapping(uint16 => ILZRelayerV2.DstPrice) public override dstPriceLookup;

    function setDstPriceLookup(
        uint16 _lzDomain,
        ILZRelayerV2.DstPrice calldata _dstPrice
    ) external {
        dstPriceLookup[_lzDomain] = _dstPrice;
    }
}
