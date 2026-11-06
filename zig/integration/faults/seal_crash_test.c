#include <fcntl.h>
#include <string.h>
#include <unistd.h>
int main(int n,char **v){if(n!=3)return 2;int fd=open(v[1],O_WRONLY|O_CREAT,0600);if(fd<0)return 3;const char *x="public-fixture zig_relayer_payload_link_v1/ public-fixture";if(write(fd,x,strlen(x))<0)return 4;close(fd);int after=open(v[2],O_WRONLY|O_CREAT,0600);if(after<0)return 5;close(after);return 0;}
