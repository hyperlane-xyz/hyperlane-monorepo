// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20} from "../HypERC20.sol";

/**
 * @title Hyperlane ERC20 router extending HypERC20 with opaque memos
 * @author Dymension
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypERC20Memo is HypERC20 {
    mapping(address => mapping(uint256 => bytes)) private _memos;
    mapping(address => uint256) private _nonces;

    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox
    ) HypERC20(__decimals, _scale, _mailbox) {}

    function setMemoForNextTransfer(bytes calldata memo) external {
        require(memo.length <= 2048, "memo too long");
        _memos[msg.sender][_nonces[msg.sender]] = memo;
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        super._transferFromSender(_amount);

        bytes memory memo = _memos[msg.sender][_nonces[msg.sender]];

        delete _memos[msg.sender][_nonces[msg.sender]];
        _nonces[msg.sender]++;

        return memo;
    }
}
