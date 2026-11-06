// Version-only C ABI shim; all storage/compression comes from pinned upstream.
#include "abi.h"
#include <rocksdb/version.h>
#include <string>
static_assert(ROCKSDB_MAJOR == 10 && ROCKSDB_MINOR == 4 && ROCKSDB_PATCH == 2,
              "RocksDB headers differ from production lock");
extern "C" uint32_t ziggy_rocksdb_abi_version(void) { return 1; }
extern "C" uint32_t ziggy_rocksdb_header_version(void) {
    return (ROCKSDB_MAJOR << 16) | (ROCKSDB_MINOR << 8) | ROCKSDB_PATCH;
}
extern "C" const char* ziggy_rocksdb_runtime_version(void) {
    try {
        static const std::string version = ROCKSDB_NAMESPACE::GetRocksVersionAsString(true);
        return version.c_str();
    } catch (...) {
        return nullptr;
    }
}
