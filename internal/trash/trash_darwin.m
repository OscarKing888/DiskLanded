#import <Foundation/Foundation.h>
#include <string.h>

// 使用系统废纸篓接口；失败时保留原文件，不回退到永久删除。
int disklanded_trash(const char *path, char **destination, char **message) {
    @autoreleasepool {
        NSString *name = [NSString stringWithUTF8String:path];
        NSURL *url = [NSURL fileURLWithPath:name];
        NSURL *result = nil;
        NSError *error = nil;
        BOOL ok = [[NSFileManager defaultManager] trashItemAtURL:url
                                               resultingItemURL:&result
                                                          error:&error];
        if (!ok) {
            *message = strdup(error ? [[error localizedDescription] UTF8String]
                                    : "The system could not recycle this file.");
            return 0;
        }
        *destination = strdup([[result path] UTF8String]);
        return 1;
    }
}
