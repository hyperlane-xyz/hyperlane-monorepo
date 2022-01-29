// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "../Common.sol";

contract TestCommon is Common {
    constructor(uint32 _localDomain, address _updater) Common(_localDomain) {
        __Common_initialize(_updater);
    }

    function setUpdater(address _updater) external {
        updater = _updater;
    }

    function testIsUpdaterSignature(
        bytes32 _root,
        uint256 _index,
        bytes memory _signature
    ) external view returns (bool) {
        return _isUpdaterSignature(_root, _index, _signature);
    }

    /// @notice Hash of Home's domain concatenated with "OPTICS"
    function homeDomainHash() public view override returns (bytes32) {
        return keccak256(abi.encodePacked(localDomain, "OPTICS"));
    }

    function _fail() internal override {
        _setFailed();
    }
}
