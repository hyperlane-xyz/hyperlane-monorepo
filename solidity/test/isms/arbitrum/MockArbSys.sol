import {ArbSys} from "@arbitrum/nitro-contracts/src/precompiles/ArbSys.sol";
import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";

contract MockArbSys is ArbSys {
    // only needed this to mock
    function wasMyCallersAddressAliased() external view returns (bool) {
        return true;
    }

    function arbBlockNumber() external view returns (uint256) {
        return 123456;
    }

    function arbBlockHash(uint256 arbBlockNum) external view returns (bytes32) {
        return keccak256(abi.encodePacked(arbBlockNum));
    }

    function arbChainID() external view returns (uint256) {
        return 42161;
    }

    function arbOSVersion() external view returns (uint256) {
        return 65;
    }

    function getStorageGasAvailable() external view returns (uint256) {
        return 0;
    }

    function isTopLevelCall() external view returns (bool) {
        return true;
    }

    function mapL1SenderContractAddressToL2Alias(
        address sender,
        address /*unused*/
    ) external pure returns (address) {
        return AddressAliasHelper.applyL1ToL2Alias(sender);
    }

    function myCallersAddressWithoutAliasing() external view returns (address) {
        return msg.sender;
    }

    function withdrawEth(
        address /*destination*/
    ) external payable returns (uint256) {
        return 0;
    }

    function sendTxToL1(
        address, /*destination*/
        bytes calldata /*data*/
    ) external payable returns (uint256) {
        return 0;
    }

    function sendMerkleTreeState()
        external
        view
        returns (
            uint256 size,
            bytes32 root,
            bytes32[] memory partials
        )
    {
        return (0, bytes32(0), new bytes32[](0));
    }
}
