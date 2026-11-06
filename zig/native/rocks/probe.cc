// Disposable native C API smoke; never opens a configured agent database.
#include "abi.h"
#include <rocksdb/c.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <string>
extern "C" const char* zlibVersion(void);
extern "C" int LZ4_versionNumber(void);
extern "C" unsigned ZSTD_versionNumber(void);
extern "C" const char* BZ2_bzlibVersion(void);
// Exact bzip2-sys archive is built with BZ_NO_STDIO; agents supply the same
// fatal-invariant callback in Zig. Only this probe supplies a C callback.
extern "C" void bz_internal_error(int) { std::abort(); }
static void check(char*& error) {
    if (error) { std::fprintf(stderr, "native smoke: %s\n", error); rocksdb_free(error); std::exit(2); }
}
int main(int argc, char** argv) {
    if (argc != 2 || ziggy_rocksdb_abi_version() != 1 ||
        ziggy_rocksdb_header_version() != 0x0a0402 ||
        !ziggy_rocksdb_runtime_version() ||
        std::strcmp(ziggy_rocksdb_runtime_version(), "10.4.2") != 0) return 2;
    const std::string value(256 * 1024, 'a');
    for (int codec : {0, 1, 2, 3, 4, 5, 7}) {
        const auto path = (std::filesystem::path(argv[1]) / std::to_string(codec)).string();
        rocksdb_options_t* options = rocksdb_options_create();
        rocksdb_options_set_create_if_missing(options, 1);
        rocksdb_options_set_compression(options, codec);
        rocksdb_options_set_write_buffer_size(options, 512 * 1024);
        char* error = nullptr;
        rocksdb_t* db = rocksdb_open(options, path.c_str(), &error); check(error);
        if (!db) return 2;
        rocksdb_writeoptions_t* write = rocksdb_writeoptions_create();
        rocksdb_writeoptions_set_sync(write, 1);
        for (int i = 0; i != 5; ++i) {
            const auto key = std::to_string(i);
            rocksdb_put(db, write, key.data(), key.size(), value.data(), value.size(), &error); check(error);
        }
        rocksdb_flushoptions_t* flush = rocksdb_flushoptions_create();
        rocksdb_flushoptions_set_wait(flush, 1);
        rocksdb_flush(db, flush, &error); check(error);
        rocksdb_flushoptions_destroy(flush);
        rocksdb_close(db);
        db = rocksdb_open_for_read_only(options, path.c_str(), 0, &error); check(error);
        if (!db) return 2;
        rocksdb_readoptions_t* read = rocksdb_readoptions_create();
        size_t size = 0;
        char* actual = rocksdb_get(db, read, "4", 1, &size, &error); check(error);
        if (!actual || size != value.size() || std::memcmp(actual, value.data(), size) != 0) return 2;
        rocksdb_free(actual);
        rocksdb_readoptions_destroy(read);
        rocksdb_writeoptions_destroy(write);
        rocksdb_close(db);
        rocksdb_options_destroy(options);
    }
    std::printf("{\"abi_version\":1,\"rocksdb\":\"%s\",\"zlib\":\"%s\",\"lz4\":%d,\"zstd\":%u,\"bzip2\":\"%s\",\"codecs_reopened\":[0,1,2,3,4,5,7]}\n",
        ziggy_rocksdb_runtime_version(), zlibVersion(), LZ4_versionNumber(), ZSTD_versionNumber(), BZ2_bzlibVersion());
}
