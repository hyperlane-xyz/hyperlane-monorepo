// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../token/interfaces/IXERC20.sol";
import "../token/interfaces/IFiatToken.sol";

contract ERC20Test is ERC20 {
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

    function mintTo(address account, uint256 amount) public {
        _mint(account, amount);
    }
}

contract FiatTokenTest is ERC20Test, IFiatToken {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) {}

    function burn(uint256 amount) public override {
        _burn(msg.sender, amount);
    }

    function mint(address account, uint256 amount) public returns (bool) {
        _mint(account, amount);
        return true;
    }
}

contract XERC20Test is ERC20Test, IXERC20 {
    constructor(
        string memory name,
        string memory symbol,
        uint256 totalSupply,
        uint8 __decimals
    ) ERC20Test(name, symbol, totalSupply, __decimals) {}

    function mint(address account, uint256 amount) public override {
        _mint(account, amount);
    }

    function burn(address account, uint256 amount) public override {
        _burn(account, amount);
    }
}
