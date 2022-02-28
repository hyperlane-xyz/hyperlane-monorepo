// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.9;

import "../Home.sol";

contract TestHome is Home {
    constructor(uint32 _localDomain) Home(_localDomain) {} // solhint-disable-line no-empty-blocks

    function destinationAndNonce(uint32 _destination, uint32 _nonce)
        external
        pure
        returns (uint64)
    {
        return _destinationAndNonce(_destination, _nonce);
    }

    function setFailed() public {
        _setFailed();
    }
}
