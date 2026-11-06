#ifndef ZIGGY_ROCKS_ABI_H
#define ZIGGY_ROCKS_ABI_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint32_t ziggy_rocksdb_abi_version(void);
uint32_t ziggy_rocksdb_header_version(void);
const char* ziggy_rocksdb_runtime_version(void);
#ifdef __cplusplus
}
#endif
#endif
