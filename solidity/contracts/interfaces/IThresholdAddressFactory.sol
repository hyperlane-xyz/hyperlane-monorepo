// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

interface IThresholdAddressFactory {
    function deploy(
        address[] calldata _values,
        uint8 _threshold
    ) external returns (address);
}
