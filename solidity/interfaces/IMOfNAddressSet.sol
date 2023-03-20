// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.0;

interface IMOfNAddressSet {
    function add(uint32 _domain, address _value) external;

    function addMany(uint32[] calldata _domains, address[][] calldata _values)
        external;

    function remove(uint32 _domain, address _value) external;

    function setThresholds(
        uint32[] calldata _domains,
        uint8[] calldata _thresholds
    ) external;

    function clear(uint32 _domain) external;

    function contains(uint32 _domain, address _value)
        external
        view
        returns (bool);

    function setThreshold(uint32 _domain, uint8 _threshold) external;

    function values(uint32 _domain) external view returns (address[] memory);

    function threshold(uint32 _domain) external view returns (uint8);

    function length(uint32 _domain) external view returns (uint256);

    function domains() external view returns (uint32[] memory);

    function valuesAndThreshold(uint32 _domain)
        external
        view
        returns (address[] memory, uint8);
}
