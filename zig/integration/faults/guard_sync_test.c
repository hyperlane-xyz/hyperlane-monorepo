#include <errno.h>
#include <fcntl.h>
#include <string.h>
#include <unistd.h>
int main(int n,char **v){if(n!=3)return 2;int fd=open(v[1],O_WRONLY|O_CREAT,0600);if(fd<0)return 3;const char *tag="public-fixture zig_validator_v1/reorg/ public-fixture";if(write(fd,tag,strlen(tag))<0)return 4;int result=fsync(fd);close(fd);return v[2][0]=='1'?(result==-1&&errno==EIO?0:5):(result==0?0:6);}
