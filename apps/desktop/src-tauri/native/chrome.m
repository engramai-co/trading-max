// Native window chrome for the workspace window. Main thread only.
// The page never receives a native command: AppKit owns dragging and zooming.
#import <Cocoa/Cocoa.h>

@interface TMDragStrip : NSView
@property(nonatomic, strong) NSTextField *connectionNotice;
@end

@interface TMConnectionNotice : NSTextField
@end
@implementation TMConnectionNotice
// Keep the whole title band draggable, including the non-interactive notice.
- (NSView *)hitTest:(NSPoint)point { return nil; }
@end

@implementation TMDragStrip
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
void trading_max_install_drag_strip(void *window_pointer, double height) {
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
    NSTextField *notice = [TMConnectionNotice labelWithString:@""];
    notice.frame = NSMakeRect(96, (height - 20) / 2, MAX(0, NSWidth(bounds) - 192), 20);
    notice.autoresizingMask = NSViewWidthSizable;
    notice.alignment = NSTextAlignmentCenter;
    notice.font = [NSFont systemFontOfSize:13 weight:NSFontWeightMedium];
    notice.textColor = NSColor.labelColor;
    notice.backgroundColor = NSColor.windowBackgroundColor;
    notice.drawsBackground = YES;
    notice.lineBreakMode = NSLineBreakByTruncatingTail;
    notice.hidden = YES;
    strip.connectionNotice = notice;
    [strip addSubview:notice];
    [content addSubview:strip positioned:NSWindowAbove relativeTo:nil];
}

void trading_max_set_connection_notice(void *window_pointer, const char *message) {
    NSWindow *window = (__bridge NSWindow *)window_pointer;
    for (NSView *view in window.contentView.subviews) {
        if (![view isKindOfClass:[TMDragStrip class]]) continue;
        NSTextField *notice = ((TMDragStrip *)view).connectionNotice;
        NSString *text = message ? [NSString stringWithUTF8String:message] : @"";
        if ([notice.stringValue isEqualToString:text]) return;
        notice.stringValue = text;
        notice.hidden = text.length == 0;
        if (!notice.hidden) {
            NSAccessibilityPostNotificationWithUserInfo(notice, NSAccessibilityAnnouncementRequestedNotification,
                @{NSAccessibilityAnnouncementKey: text, NSAccessibilityPriorityKey: @(NSAccessibilityPriorityMedium)});
        }
    }
}
