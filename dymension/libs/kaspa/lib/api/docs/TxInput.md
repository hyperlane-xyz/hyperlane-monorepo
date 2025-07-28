# TxInput

## Properties

| Name                           | Type                                        | Description | Notes      |
| ------------------------------ | ------------------------------------------- | ----------- | ---------- |
| **transaction_id**             | **String**                                  |             |
| **index**                      | **i32**                                     |             |
| **previous_outpoint_hash**     | **String**                                  |             |
| **previous_outpoint_index**    | **String**                                  |             |
| **previous_outpoint_resolved** | Option<[**models::TxOutput**](TxOutput.md)> |             | [optional] |
| **previous_outpoint_address**  | Option<**String**>                          |             | [optional] |
| **previous_outpoint_amount**   | Option<**i32**>                             |             | [optional] |
| **signature_script**           | Option<**String**>                          |             | [optional] |
| **sig_op_count**               | Option<**String**>                          |             | [optional] |

[[Back to Model list]](../README.md#documentation-for-models) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to README]](../README.md)
