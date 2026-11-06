// Fixture-only process crash at a real, task-owned RocksDB WAL write boundary.
// Never linked into the production agent. DB path and public proof path supplied
// explicitly by the disposable integration harness; no other file can arm it.
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
static void after_write(int fd, const void *bytes, size_t length) {
    if (!database[0] || !contains(bytes,length)) return;
    char path[PATH_MAX];
    if (fcntl(fd,F_GETPATH,path)<0 || strncmp(path,database,strlen(database))!=0) return;
    const size_t size = strlen(path);
    if (size<4 || strcmp(path+size-4,".log")!=0) return;
    // The seal is physically present and durable before killing the unchanged
    // executable. Its rocksdb_write caller cannot return to destination enqueue.
    if (fsync(fd)!=0) _exit(97);
    const int proof = open(proof_path,O_WRONLY|O_CREAT|O_EXCL,0600);
    if (proof<0) _exit(98);
    static const char record[]="{\"fixture\":\"dyld-real-wal-write\",\"seal_wal_fsynced_before_sigkill\":true}\n";
    if (write(proof,record,sizeof(record)-1)!=(ssize_t)(sizeof(record)-1) || fsync(proof)!=0) _exit(99);
    close(proof);
    if (kill(getpid(),SIGKILL)!=0) _exit(100);
    // Delivery is asynchronous on a multithreaded process. Do not let a fast
    // _exit race the pending signal and turn a real SIGKILL into exit status100.
    for (;;) pause();
}
static ssize_t hook_write(int fd,const void *bytes,size_t length) {
    const ssize_t result=write(fd,bytes,length);
    if (result>0) after_write(fd,bytes,(size_t)result);
    return result;
}
static ssize_t hook_pwrite(int fd,const void *bytes,size_t length,off_t offset) {
    const ssize_t result=pwrite(fd,bytes,length,offset);
    if (result>0) after_write(fd,bytes,(size_t)result);
    return result;
}
static ssize_t hook_writev(int fd,const struct iovec *vectors,int count) {
    const ssize_t result=writev(fd,vectors,count);
    size_t remaining=result>0?(size_t)result:0;
    for (int i=0;i<count && remaining;i++) {
        const size_t length=vectors[i].iov_len<remaining?vectors[i].iov_len:remaining;
        after_write(fd,vectors[i].iov_base,length);
        remaining-=length;
    }
    return result;
}
// Public dyld interposing ABI, verified against Apple's dyld-interposing.h:
// https://github.com/apple-oss-distributions/dyld/blob/main/include/mach-o/dyld-interposing.h
struct interposition { const void *hook; const void *symbol; };
__attribute__((used,section("__DATA,__interpose,interposing")))
static const struct interposition hooks[] = {
    {(const void *)&hook_write,(const void *)&write},
    {(const void *)&hook_writev,(const void *)&writev},
    {(const void *)&hook_pwrite,(const void *)&pwrite},
};
