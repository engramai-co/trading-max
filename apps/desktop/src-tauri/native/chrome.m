// Native window chrome for the workspace window. Main thread only.
// The page never receives a native command: AppKit owns dragging and zooming.
#import <Cocoa/Cocoa.h>

@interface TMDragStrip : NSView
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
    [content addSubview:strip positioned:NSWindowAbove relativeTo:nil];
}
