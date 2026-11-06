// Fixture-only uncertain guard fsync. Never linked into production: the exact
// unchanged executable is injected only for an explicitly named disposable DB.
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>
static char database[PATH_MAX],proof_path[PATH_MAX];
static _Atomic int guard_fd=-1;
__attribute__((constructor)) static void configure(void){
 const char *db=getenv("ZIGGY_GUARD_SYNC_DATABASE"),*proof=getenv("ZIGGY_GUARD_SYNC_PROOF");
 if(!db||!proof||!strstr(db,"ziggy-public-validator-guard-")||!strstr(db,"/guard-db-")||strlen(db)>=sizeof(database)-2||strlen(proof)>=sizeof(proof_path))return;
 snprintf(database,sizeof(database),"%s/",db);snprintf(proof_path,sizeof(proof_path),"%s",proof);
}
static bool task_wal(int fd){char path[PATH_MAX];if(!database[0]||fcntl(fd,F_GETPATH,path)<0)return false;size_t size=strlen(path);return strncmp(path,database,strlen(database))==0&&size>=4&&strcmp(path+size-4,".log")==0;}
static void inspect(int fd,const void *bytes,size_t length){
 static const char tag[]="zig_validator_v1/reorg/";
 if(length<sizeof(tag)-1||!task_wal(fd))return;
 for(size_t i=0;i<=length-(sizeof(tag)-1);i++)if(memcmp((const char *)bytes+i,tag,sizeof(tag)-1)==0){atomic_store(&guard_fd,fd);return;}
}
static ssize_t hook_write(int fd,const void *bytes,size_t length){ssize_t n=write(fd,bytes,length);if(n>0)inspect(fd,bytes,(size_t)n);return n;}
static ssize_t hook_pwrite(int fd,const void *bytes,size_t length,off_t offset){ssize_t n=pwrite(fd,bytes,length,offset);if(n>0)inspect(fd,bytes,(size_t)n);return n;}
static ssize_t hook_writev(int fd,const struct iovec *v,int count){ssize_t n=writev(fd,v,count);size_t left=n>0?(size_t)n:0;for(int i=0;i<count&&left;i++){size_t len=v[i].iov_len<left?v[i].iov_len:left;inspect(fd,v[i].iov_base,len);left-=len;}return n;}
static int hook_fsync(int fd){
 int result=fsync(fd);if(result||atomic_load(&guard_fd)!=fd||!task_wal(fd))return result;
 // Bytes have actually reached stable storage. Returning EIO models the caller's
 // unknown durability outcome; a mere readback must not clear its pending guard.
 int proof=open(proof_path,O_WRONLY|O_CREAT|O_EXCL,0600);
 if(proof>=0){static const char record[]="{\"fixture\":\"guard-fsync-outcome-unknown\",\"real_fsync_succeeded\":true,\"reported_errno\":5}\n";if(write(proof,record,sizeof(record)-1)!=(ssize_t)(sizeof(record)-1)||fsync(proof)!=0)_exit(99);close(proof);}
 errno=EIO;return -1;
}
struct interposition{const void *hook;const void *symbol;};
__attribute__((used,section("__DATA,__interpose,interposing"))) static const struct interposition hooks[]={
 {(const void *)&hook_write,(const void *)&write},{(const void *)&hook_writev,(const void *)&writev},{(const void *)&hook_pwrite,(const void *)&pwrite},{(const void *)&hook_fsync,(const void *)&fsync}};
