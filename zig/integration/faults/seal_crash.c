// Fixture-only process crash at a real, task-owned RocksDB WAL write boundary.
// Never linked into the production agent. DB path and public proof path supplied
// explicitly by the disposable integration harness; no other file can arm it.
#if defined(__linux__)
#define _GNU_SOURCE
#include <sys/syscall.h>
#if !defined(__x86_64__) && !defined(__aarch64__)
#error "Linux fixture interposer requires a 64-bit x86 or ARM host"
#endif
#elif !defined(__APPLE__)
#error "Unsupported fixture interposer platform"
#endif
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>


static char database[PATH_MAX];
static char proof_path[PATH_MAX];
__attribute__((constructor)) static void configure(void) {
    const char *db = getenv("ZIGGY_SEAL_CRASH_DATABASE");
    const char *proof = getenv("ZIGGY_SEAL_CRASH_PROOF");
    if (!db || !proof || !strstr(db,"ziggy-public-relayer-process-") ||
        !strstr(db,"/crash-db-") || strlen(db)>=sizeof(database)-2 ||
        strlen(proof)>=sizeof(proof_path)) return;
    snprintf(database,sizeof(database),"%s/",db);
    snprintf(proof_path,sizeof(proof_path),"%s",proof);
}
static bool contains(const void *bytes, size_t length) {
    static const char tag[] = "zig_relayer_payload_link_v1/";
    if (length < sizeof(tag)-1) return false;
    for (size_t i=0;i<=length-(sizeof(tag)-1);i++)
        if (memcmp((const char *)bytes+i,tag,sizeof(tag)-1)==0) return true;
    return false;
}
static bool descriptor_path(int fd, char path[PATH_MAX]) {
#if defined(__APPLE__)
    return fcntl(fd,F_GETPATH,path)>=0;
#else
    char link[64];
    const int count=snprintf(link,sizeof(link),"/proc/self/fd/%d",fd);
    if (count<0 || (size_t)count>=sizeof(link)) return false;
    const ssize_t size=readlink(link,path,PATH_MAX-1);
    if (size<0 || size>=PATH_MAX-1) return false;
    path[size]='\0';
    return true;
#endif
}
static void after_write(int fd, const void *bytes, size_t length) {
    if (!database[0] || !contains(bytes,length)) return;
    char path[PATH_MAX];
    if (!descriptor_path(fd,path) || strncmp(path,database,strlen(database))!=0) return;
    const size_t size = strlen(path);
    if (size<4 || strcmp(path+size-4,".log")!=0) return;
    // The seal is physically present and durable before killing the unchanged
    // executable. Its rocksdb_write caller cannot return to destination enqueue.
    if (fsync(fd)!=0) _exit(97);
    const int proof = open(proof_path,O_WRONLY|O_CREAT|O_EXCL,0600);
    if (proof<0) _exit(98);
#if defined(__APPLE__)
    static const char record[]="{\"fixture\":\"dyld-real-wal-write\",\"seal_wal_fsynced_before_sigkill\":true}\n";
#else
    static const char record[]="{\"fixture\":\"ld-preload-real-wal-write\",\"seal_wal_fsynced_before_sigkill\":true}\n";
#endif
    if (write(proof,record,sizeof(record)-1)!=(ssize_t)(sizeof(record)-1) || fsync(proof)!=0) _exit(99);
    close(proof);
    if (kill(getpid(),SIGKILL)!=0) _exit(100);
    // Delivery is asynchronous on a multithreaded process. Do not let a fast
    // _exit race the pending signal and turn a real SIGKILL into exit status100.
    for (;;) pause();
}
#if defined(__linux__)
// Raw Linux write syscalls avoid recursively calling the exported preload
// symbols. Only this disposable 64-bit fault process uses these wrappers.
#define hook_write write
#define hook_pwrite pwrite
#define hook_writev writev
#define HOOK_LINKAGE
#define original_write(fd,bytes,length) syscall(SYS_write,fd,bytes,length)
#define original_pwrite(fd,bytes,length,offset) syscall(SYS_pwrite64,fd,bytes,length,offset)
#define original_writev(fd,vectors,count) syscall(SYS_writev,fd,vectors,count)
#else
#define HOOK_LINKAGE static
#define original_write write
#define original_pwrite pwrite
#define original_writev writev
#endif
HOOK_LINKAGE ssize_t hook_write(int fd,const void *bytes,size_t length) {
    const ssize_t result=original_write(fd,bytes,length);
    if (result>0) after_write(fd,bytes,(size_t)result);
    return result;
}
HOOK_LINKAGE ssize_t hook_pwrite(int fd,const void *bytes,size_t length,off_t offset) {
    const ssize_t result=original_pwrite(fd,bytes,length,offset);
    if (result>0) after_write(fd,bytes,(size_t)result);
    return result;
}
HOOK_LINKAGE ssize_t hook_writev(int fd,const struct iovec *vectors,int count) {
    const ssize_t result=original_writev(fd,vectors,count);
    size_t remaining=result>0?(size_t)result:0;
    for (int i=0;i<count && remaining;i++) {
        const size_t length=vectors[i].iov_len<remaining?vectors[i].iov_len:remaining;
        after_write(fd,vectors[i].iov_base,length);
        remaining-=length;
    }
    return result;
}
#if defined(__linux__)
// RocksDB may select the explicit large-file libc symbol.
ssize_t pwrite64(int fd,const void *bytes,size_t length,off64_t offset) {
    return hook_pwrite(fd,bytes,length,(off_t)offset);
}
#else
// Public dyld interposing ABI, verified against Apple's dyld-interposing.h:
// https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/dyld-interposing.h
struct interposition { const void *hook; const void *symbol; };
__attribute__((used,section("__DATA,__interpose,interposing")))
static const struct interposition hooks[] = {
    {(const void *)&hook_write,(const void *)&write},
    {(const void *)&hook_writev,(const void *)&writev},
    {(const void *)&hook_pwrite,(const void *)&pwrite},
};

#endif
