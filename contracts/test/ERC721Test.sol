// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Enumerable.sol";

contract ERC721Test is ERC721Enumerable {
    constructor(
        string memory name,
        string memory symbol,
        uint256 _mintAmount
    ) ERC721(name, symbol) {
        for (uint256 i = 0; i < _mintAmount; i++) {
            _mint(msg.sender, i);
        }
    }

    function _baseURI() internal pure override returns (string memory) {
        return "TEST-BASE-URI";
    }
}
