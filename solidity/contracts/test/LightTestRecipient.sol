import "./TestRecipient.sol";

contract LightTestRecipient is TestRecipient {
    // solhint-disable-next-line no-empty-blocks
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _data
    ) external override {
        // do nothing
    }
}
