#import <AppKit/AppKit.h>
#include <node_api.h>
#include <cstring>

static napi_value Run(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  void* bytes = nullptr; size_t length = 0; bool buffer = false;
  if (argc < 1 || napi_is_buffer(env, argv[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, argv[0], &bytes, &length) != napi_ok || length != sizeof(void*)) {
    napi_throw_type_error(env, nullptr, "Expected an Electron native window handle"); return nullptr;
  }
  if (![NSThread isMainThread]) {
    napi_throw_error(env, nullptr, "Must run in the Electron main process"); return nullptr;
  }
  void* pointer = nullptr; memcpy(&pointer, bytes, sizeof(pointer));
  NSView* view = (__bridge NSView*)pointer;
  NSWindow* window = view.window;
  if (!window) { napi_throw_error(env, nullptr, "No window for native view"); return nullptr; }
  bool fix = false;
  if (argc > 1) napi_get_value_bool(env, argv[1], &fix);
  if (fix) {
    window.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces |
      NSWindowCollectionBehaviorCanJoinAllApplications |
      NSWindowCollectionBehaviorFullScreenAuxiliary |
      NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorTransient;
    window.level = NSFloatingWindowLevel;
    window.hidesOnDeactivate = NO;
    [window makeKeyAndOrderFront:nil];
    [window orderFrontRegardless];
  }
  NSDictionary* values = @{
    @"class": NSStringFromClass(window.class),
    @"isPanel": @([window isKindOfClass:NSPanel.class]),
    @"onActiveSpace": @(window.onActiveSpace),
    @"visible": @(window.visible),
    @"key": @(window.keyWindow),
    @"collectionBehavior": @(window.collectionBehavior),
    @"styleMask": @(window.styleMask),
    @"level": @(window.level),
    @"appActive": @(NSApp.active),
    @"windowNumber": @(window.windowNumber)
  };
  NSData* data = [NSJSONSerialization dataWithJSONObject:values options:0 error:nil];
  napi_value result; napi_create_string_utf8(env, (const char*)data.bytes, data.length, &result);
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value fn; napi_create_function(env, "inspect", NAPI_AUTO_LENGTH, Run, nullptr, &fn);
  napi_set_named_property(env, exports, "inspect", fn); return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
