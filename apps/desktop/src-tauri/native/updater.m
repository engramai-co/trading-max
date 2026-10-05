// Sparkle owns downloading, verification, installation and relaunch. Main thread only.
#import <Sparkle/Sparkle.h>

extern void trading_max_prepare_update(void);

@interface TMUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) NSString *feed;
@property(nonatomic, copy) NSString *version;
@property(nonatomic, copy) NSString *archive;
@property(nonatomic) uint64_t size;
@end

@implementation TMUpdaterDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater { return self.feed; }
- (NSArray *)feedParametersForUpdater:(SPUUpdater *)updater sendingSystemProfile:(BOOL)sendingProfile {
    return @[];
}
- (BOOL)updater:(SPUUpdater *)updater shouldProceedWithUpdate:(SUAppcastItem *)item
   updateCheck:(SPUUpdateCheck)check error:(NSError *__autoreleasing *)error {
    if (![item.versionString isEqualToString:self.version] ||
        ![item.fileURL.absoluteString isEqualToString:self.archive] ||
        item.contentLength != self.size || item.isInformationOnlyUpdate || item.isDeltaUpdate) {
        if (error) *error = [NSError errorWithDomain:@"TradingMaxUpdate" code:1 userInfo:@{
            NSLocalizedDescriptionKey: @"更新内容与刚核对的官方安装包不一致。请重新检查版本。"
        }];
        return NO;
    }
    return YES;
}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)updater {
    // Stops only the local processes owned by this App; remote services are untouched.
    trading_max_prepare_update();
}
@end

static SPUStandardUpdaterController *controller;
static TMUpdaterDelegate *delegate;
static NSString *lastError;
static BOOL started;

const char *trading_max_start_update(const char *feed, const char *version,
                                    const char *archive, uint64_t size) {
    @autoreleasepool {
        if (![NSThread isMainThread]) return "更新窗口必须在主线程打开。";
        if (!controller) {
            delegate = [TMUpdaterDelegate new];
            controller = [[SPUStandardUpdaterController alloc]
                initWithStartingUpdater:NO updaterDelegate:delegate userDriverDelegate:nil];
        }
        if (controller.updater.sessionInProgress) return "更新窗口已经打开，请完成或取消当前更新。";
        delegate.feed = [NSString stringWithUTF8String:feed];
        delegate.version = [NSString stringWithUTF8String:version];
        delegate.archive = [NSString stringWithUTF8String:archive];
        delegate.size = size;
        NSError *error = nil;
        if (!started && ![controller.updater startUpdater:&error]) {
            lastError = error.localizedDescription ?: @"无法启动更新，请使用官方安装包。";
            return lastError.UTF8String;
        }
        started = YES;
        [controller checkForUpdates:nil];
        return NULL;
    }
}
