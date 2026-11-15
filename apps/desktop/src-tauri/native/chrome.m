// Native window chrome for the workspace window. Main thread only.
// The page never receives a native command: AppKit owns dragging and zooming.
#import <Cocoa/Cocoa.h>

@interface TMDragStrip : NSView
@property(nonatomic, strong) NSTextField *connectionNotice;
@property(nonatomic, strong) NSButton *retryButton;
@property(nonatomic, assign) void (*retryHandler)(void);
@end

@interface TMConnectionNotice : NSTextField
@end
@implementation TMConnectionNotice
// Keep the whole title band draggable, including the non-interactive notice.
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

@implementation TMDragStrip
- (void)retryConnection:(id)sender {
    if (self.retryHandler) self.retryHandler();
}
- (BOOL)mouseDownCanMoveWindow { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)isOpaque { return NO; }
- (void)mouseDown:(NSEvent *)event {
    if (event.clickCount == 2) {
        NSString *action = [[NSUserDefaults standardUserDefaults] stringForKey:@"AppleActionOnDoubleClick"];
        if ([action isEqualToString:@"Minimize"]) {
            [self.window performMiniaturize:nil];
        } else if (![action isEqualToString:@"None"]) {
            [self.window performZoom:nil];
        }
        return;
    }
    [self.window performWindowDragWithEvent:event];
}
// Scrolling over the band still scrolls the page underneath.
- (void)scrollWheel:(NSEvent *)event {
    for (NSView *view in self.superview.subviews.reverseObjectEnumerator) {
        if (view != self && !view.hidden) {
            [view scrollWheel:event];
            return;
        }
    }
}
@end

// The system keeps the window controls at their standard position inside this
// band; the page leaves the band empty and the strip makes it draggable.
void trading_max_install_drag_strip(void *window_pointer, double height, void (*retry_handler)(void)) {
    NSWindow *window = (__bridge NSWindow *)window_pointer;
    NSView *content = window.contentView;
    if (content == nil || height <= 0) return;
    for (NSView *view in [content.subviews copy]) {
        if ([view isKindOfClass:[TMDragStrip class]]) [view removeFromSuperview];
    }
    NSRect bounds = content.bounds;
    CGFloat y = content.isFlipped ? 0 : NSMaxY(bounds) - height;
    TMDragStrip *strip = [[TMDragStrip alloc] initWithFrame:NSMakeRect(0, y, NSWidth(bounds), height)];
    strip.autoresizingMask = NSViewWidthSizable | (content.isFlipped ? NSViewMaxYMargin : NSViewMinYMargin);
    strip.retryHandler = retry_handler;
    NSTextField *notice = [TMConnectionNotice wrappingLabelWithString:@""];
    notice.frame = NSMakeRect(96, 0, MAX(0, NSWidth(bounds) - 224), height);
    notice.autoresizingMask = NSViewWidthSizable;
    notice.alignment = NSTextAlignmentCenter;
    notice.font = [NSFont systemFontOfSize:12 weight:NSFontWeightMedium];
    notice.textColor = [NSColor colorWithName:nil dynamicProvider:^NSColor *(NSAppearance *appearance) {
        BOOL dark = [[appearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua, NSAppearanceNameDarkAqua]]
            isEqualToString:NSAppearanceNameDarkAqua];
        return dark ? [NSColor colorWithSRGBRed:0.96 green:0.76 blue:0.37 alpha:1]
                    : [NSColor colorWithSRGBRed:0.50 green:0.32 blue:0.05 alpha:1];
    }];
    notice.backgroundColor = NSColor.windowBackgroundColor;
    notice.drawsBackground = YES;
    notice.maximumNumberOfLines = 2;
    notice.lineBreakMode = NSLineBreakByWordWrapping;
    notice.hidden = YES;
    notice.accessibilityElement = YES;
    notice.accessibilityRole = NSAccessibilityStaticTextRole;
    strip.connectionNotice = notice;
    [strip addSubview:notice];

    NSButton *retry = [NSButton buttonWithTitle:@"" target:strip action:@selector(retryConnection:)];
    retry.frame = NSMakeRect(MAX(0, NSWidth(bounds) - 116), 1, 104, height - 2);
    retry.autoresizingMask = NSViewMinXMargin;
    retry.bezelStyle = NSBezelStyleRounded;
    retry.controlSize = NSControlSizeSmall;
    retry.hidden = YES;
    strip.retryButton = retry;
    [strip addSubview:retry];
    [content addSubview:strip positioned:NSWindowAbove relativeTo:nil];
}

void trading_max_set_connection_notice(void *window_pointer, const char *message, const char *retry_title) {
    NSWindow *window = (__bridge NSWindow *)window_pointer;
    for (NSView *view in window.contentView.subviews) {
        if (![view isKindOfClass:[TMDragStrip class]]) continue;
        TMDragStrip *strip = (TMDragStrip *)view;
        NSTextField *notice = strip.connectionNotice;
        NSString *text = message ? [NSString stringWithUTF8String:message] : @"";
        NSString *title = retry_title ? [NSString stringWithUTF8String:retry_title] : @"";
        strip.retryButton.title = title;
        strip.retryButton.accessibilityLabel = title;
        strip.retryButton.hidden = text.length == 0;
        if ([notice.stringValue isEqualToString:text]) return;
        notice.stringValue = text;
        notice.accessibilityLabel = text;
        notice.hidden = text.length == 0;
        if (!notice.hidden) {
            NSAccessibilityPostNotificationWithUserInfo(notice, NSAccessibilityAnnouncementRequestedNotification,
                @{NSAccessibilityAnnouncementKey: text, NSAccessibilityPriorityKey: @(NSAccessibilityPriorityMedium)});
        }
    }
}
