// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

import "@summa-tx/memview-sol/contracts/TypedMemView.sol";

library FundraiseMessage {
    using TypedMemView for bytes;
    using TypedMemView for bytes29;

    // Transfer(bytes32 tokenId, bytes32 to, uint256 amount)
    // Deposit(bytes32 tokenId, bytes32 to, uint256 amount)
    enum Types {
        Transfer, // 0
        Deposit // 1
    }

    uint256 private constant TOKEN_ID_LEN = 36; // 4 bytes domain + 32 bytes id

    // ============ Formatters ============

    function formatTransfer(
        bytes29 _tokenId,
        bytes32 _to,
        uint256 _amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(Types.Transfer), _tokenId, _to, _amount);
    }

    function formatDeposit(
        bytes29 _tokenId,
        bytes32 _to,
        uint256 _amount
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(uint8(Types.Deposit), _tokenId, _to, _amount);
    }

    function formatTokenId(uint32 _domain, bytes32 _id)
        internal
        pure
        returns (bytes29)
    {
        return abi.encodePacked(_domain, _id).ref(0);
    }

    // ============ Identifiers ============

    /**
     * @notice Get the type that the TypedMemView is cast to
     * @param _view The message
     * @return _type The type of the message (either Transfer or Deposit)
     */
    function messageType(bytes29 _view) internal pure returns (Types _type) {
        _type = Types(uint8(_view.typeOf()));
    }

    /**
     * @notice Determine whether the message contains a Transfer volley
     * @param _view The message
     * @return True if the volley is Transfer
     */
    function isTransfer(bytes29 _view) internal pure returns (bool) {
        return messageType(_view) == Types.Transfer;
    }

    /**
     * @notice Determine whether the message contains a Deposit volley
     * @param _view The message
     * @return True if the volley is Deposit
     */
    function isDeposit(bytes29 _view) internal pure returns (bool) {
        return messageType(_view) == Types.Deposit;
    }

    // ============ Getters ============

    // /**
    //  * @notice Parse the match ID sent within a Transfer or Deposit message
    //  * @dev The number is encoded as a uint32 at index 1
    //  * @param _view The message
    //  * @return The match id encoded in the message
    //  */
    // function tokenId(bytes29 _view) internal pure returns (bytes29) {
    //   // before: 1 byte identifier
    //     return _view.index(1, 32);
    // }

    function to(bytes29 _view) internal pure returns (bytes32) {
        // before: 1 byte identifier + 36 bytes tokenId
        return _view.index(37, 32);
    }

    function amount(bytes29 _view) internal pure returns (uint256) {
        // before: 1 byte identifie + 36 bytes tokenId + 32 bytes to
        return uint256(_view.index(69, 32));
    }
}
