// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

interface IFastTokenRouter {
    function fillFastTransfer(
        address _recipient,
        uint256 _amount,
        uint256 _fastFee,
        uint32 _origin,
        uint256 _fastTransferId
    ) external;

    function fastTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        uint256 _fastFee
    ) external payable returns (bytes32 messageId);
}
