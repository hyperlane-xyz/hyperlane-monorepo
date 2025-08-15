# \KaspaBlocksApi

All URIs are relative to _http://localhost_

| Method                                                                                                                           | HTTP request                   | Description               |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | ------------------------- |
| [**get_block_blocks_block_id_get**](KaspaBlocksApi.md#get_block_blocks_block_id_get)                                             | **GET** /blocks/{blockId}      | Get Block                 |
| [**get_blocks_blocks_get**](KaspaBlocksApi.md#get_blocks_blocks_get)                                                             | **GET** /blocks                | Get Blocks                |
| [**get_blocks_from_bluescore_blocks_from_bluescore_get**](KaspaBlocksApi.md#get_blocks_from_bluescore_blocks_from_bluescore_get) | **GET** /blocks-from-bluescore | Get Blocks From Bluescore |

## get_block_blocks_block_id_get

> models::BlockModel get_block_blocks_block_id_get(block_id, include_transactions, include_color)
> Get Block

Get block information for a given block id

### Parameters

| Name                     | Type             | Description | Required   | Notes              |
| ------------------------ | ---------------- | ----------- | ---------- | ------------------ |
| **block_id**             | **String**       |             | [required] |
| **include_transactions** | Option<**bool**> |             |            | [default to true]  |
| **include_color**        | Option<**bool**> |             |            | [default to false] |

### Return type

[**models::BlockModel**](BlockModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

## get_blocks_blocks_get

> models::BlockResponse get_blocks_blocks_get(low_hash, include_blocks, include_transactions)
> Get Blocks

Lists block beginning from a low hash (block id).

### Parameters

| Name                     | Type             | Description | Required   | Notes              |
| ------------------------ | ---------------- | ----------- | ---------- | ------------------ |
| **low_hash**             | **String**       |             | [required] |
| **include_blocks**       | Option<**bool**> |             |            | [default to false] |
| **include_transactions** | Option<**bool**> |             |            | [default to false] |

### Return type

[**models::BlockResponse**](BlockResponse.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)

## get_blocks_from_bluescore_blocks_from_bluescore_get

> Vec<models::BlockModel> get_blocks_from_bluescore_blocks_from_bluescore_get(blue_score, include_transactions)
> Get Blocks From Bluescore

Lists blocks of a given blueScore

### Parameters

| Name                     | Type             | Description | Required | Notes                 |
| ------------------------ | ---------------- | ----------- | -------- | --------------------- |
| **blue_score**           | Option<**i32**>  |             |          | [default to 43679173] |
| **include_transactions** | Option<**bool**> |             |          | [default to false]    |

### Return type

[**Vec<models::BlockModel>**](BlockModel.md)

### Authorization

No authorization required

### HTTP request headers

- **Content-Type**: Not defined
- **Accept**: application/json

[[Back to top]](#) [[Back to API list]](../README.md#documentation-for-api-endpoints) [[Back to Model list]](../README.md#documentation-for-models) [[Back to README]](../README.md)
