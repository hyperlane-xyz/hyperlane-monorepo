#if defined(__linux__)
#define _GNU_SOURCE
#endif
#include <fcntl.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>
int main(int n,char **v) {
    if(n!=3 && n!=4)return 2;
    int fd=open(v[1],O_WRONLY|O_CREAT,0600);if(fd<0)return 3;
    const char *x="public-fixture zig_relayer_payload_link_v1/ public-fixture";
    const char *mode=n==4?v[3]:"write";
    ssize_t result;
    if(strcmp(mode,"write")==0)result=write(fd,x,strlen(x));
    else if(strcmp(mode,"pwrite")==0)result=pwrite(fd,x,strlen(x),0);
    else if(strcmp(mode,"writev")==0) {
        const char *prefix="header ";
        const struct iovec vectors[]={{.iov_base=(void *)prefix,.iov_len=strlen(prefix)},
                                     {.iov_base=(void *)x,.iov_len=strlen(x)}};
        result=writev(fd,vectors,2);
#if defined(__linux__)
    } else if(strcmp(mode,"pwrite64")==0) {result=pwrite64(fd,x,strlen(x),0);
#endif
    } else {close(fd);return 6;}
    if(result<0)return 4;
    close(fd);
    int after=open(v[2],O_WRONLY|O_CREAT,0600);if(after<0)return 5;
    close(after);return 0;
}
