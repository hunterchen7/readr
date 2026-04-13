import { Platform, View, type ViewProps } from "react-native";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const RN = require("react-native");

/**
 * Native-backed wrapper that drops pure-finger MotionEvents
 * before they reach children. Used to scope palm rejection to
 * the drawing canvas area. On iOS / emulator / old builds
 * without the native component registered, falls back silently
 * to a plain <View> so nothing crashes.
 *
 * See StylusOnlyView.kt for the actual dispatchTouchEvent
 * interceptor. The `stylusOnly` prop toggles the filter at
 * runtime so the same view can accept finger input outside
 * writing mode.
 */
interface StylusOnlyViewProps extends ViewProps {
  stylusOnly?: boolean;
}

const NativeImpl =
  Platform.OS === "android" &&
  typeof RN.requireNativeComponent === "function"
    ? (() => {
        try {
          return RN.requireNativeComponent(
            "RCTStylusOnlyView",
          ) as React.ComponentType<StylusOnlyViewProps>;
        } catch {
          return null;
        }
      })()
    : null;

export function StylusOnlyView(props: StylusOnlyViewProps) {
  if (NativeImpl) {
    return <NativeImpl {...props} />;
  }
  // Strip the stylusOnly prop so it doesn't leak into the DOM/view
  // on platforms without native support.
  const { stylusOnly: _ignored, ...rest } = props;
  return <View {...rest} />;
}
