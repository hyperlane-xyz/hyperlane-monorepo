// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../token/interfaces/IXERC20.sol";
import "../token/interfaces/IFiatToken.sol";

contract ERC20Test is ERC20, IXERC20, IFiatToken {
    uint8 public immutable _decimals;

    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20(name, symbol) {
        _decimals = __decimals;
        _mint(msg.sender, totalSupply);
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(uint256 amount) public {
        _mint(msg.sender, amount);
    }

    function mint(
        address account,
        uint256 amount
    ) external override(IFiatToken, IXERC20) returns (bool) {
        _mint(account, amount);
        return true;
    }

    function burn(uint256 amount) public override(IFiatToken) {
        _burn(msg.sender, amount);
    }

    function burn(address account, uint256 amount) public override(IXERC20) {
        _burn(account, amount);
    }
}
