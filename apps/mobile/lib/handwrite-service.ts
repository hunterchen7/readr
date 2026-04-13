import { NativeModules, Platform } from "react-native";

/**
 * Thin JS wrapper around the native HandwriteService module —
 * the Supernote vendor binder client that drives the kernel
 * handwriting pipeline (`service_myservice` /
 * `android.demo.IMyService`).
 *
 * On a Supernote Nomad this bypasses SurfaceFlinger, GPU, and
 * the Android input path entirely: pen samples go directly from
 * the EMR digitizer to a kernel driver that rasterizes them into
 * the EPD framebuffer. Stroke-to-pixel latency drops from the
 * ~200-400ms we get through Skia + React Native + SurfaceFlinger
 * to ~20ms — the same numbers Atelier and the official Ratta
 * Notes app achieve.
 *
 * On any other device (iOS, emulator, non-Supernote Android)
 * the native module isn't registered and every method here is
 * a no-op. Callers should always have a Skia-based fallback
 * path, which we do via `HandwritingCanvas`'s existing
 * committed-paths rendering.
 */

type HandwriteServiceNative = {
  start: (
    penTypeIdx: number,
    penSizeIdx: number,
    disableRects: number[],
  ) => Promise<boolean>;
  setPen: (penTypeIdx: number, penSizeIdx: number) => Promise<boolean>;
  setEraser: (sizeIdx: number) => Promise<boolean>;
  stop: () => Promise<boolean>;
  fullRefresh: () => Promise<boolean>;
  syncBackground: () => Promise<boolean>;
  captureCanvas: (
    left: number,
    top: number,
    width: number,
    height: number,
  ) => Promise<string | null>;
};

const native: HandwriteServiceNative | null =
  Platform.OS === "android" && NativeModules.HandwriteService
    ? (NativeModules.HandwriteService as HandwriteServiceNative)
    : null;

export const isHandwriteServiceAvailable = (): boolean => native !== null;

/**
 * Map our user-facing pen widths [2, 4, 8] dp to indices in
 * Atelier's BALL_PEN size table: {200, 400, 600}. The kernel
 * treats these as MAX width at full pressure — it scales down
 * based on EMR pressure as the user draws.
 */
export function penWidthToSizeIdx(width: number): number {
  if (width <= 2) return 0; // 200
  if (width <= 4) return 1; // 400
  return 2; // 600
}

/**
 * Map [2, 4, 8] → eraser size table index {400, 1000, 1600, 2200}.
 */
export function eraserWidthToSizeIdx(width: number): number {
  if (width <= 2) return 0;
  if (width <= 4) return 1;
  return 2;
}

async function safe<T>(
  fn: (() => Promise<T>) | undefined,
  fallback: T,
): Promise<T> {
  if (!fn) return fallback;
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

export const HandwriteService = {
  /**
   * Begin a handwriting session. Forbids the kernel from drawing
   * in the given rectangles (screen-pixel coordinates). Always
   * pass the entire area OUTSIDE your canvas — the backdrop, the
   * toolbar, the header, everything. Otherwise the kernel will
   * draw strokes there too.
   */
  start: (
    penTypeIdx: number,
    penSizeIdx: number,
    disableRects: number[],
  ) =>
    safe(
      () => native!.start(penTypeIdx, penSizeIdx, disableRects),
      false,
    ),
  setPen: (penTypeIdx: number, penSizeIdx: number) =>
    safe(() => native!.setPen(penTypeIdx, penSizeIdx), false),
  setEraser: (sizeIdx: number) =>
    safe(() => native!.setEraser(sizeIdx), false),
  stop: () => safe(() => native!.stop(), false),
  fullRefresh: () => safe(() => native!.fullRefresh(), false),
  /**
   * Signal the kernel to drop its cached stroke-trail buffer
   * and rebind to our window's background on the next frame.
   * Use this after erase / undo / redo / clear — the kernel
   * stops re-compositing the stale strokes without flashing.
   * This is how Ratta Notes handles undo/erase without ghosts.
   */
  syncBackground: () => safe(() => native!.syncBackground(), false),
  /**
   * Capture a screenshot of a screen region (in dp coordinates)
   * and return as a base64 PNG data URI. Uses the system
   * screencap binary which reads the display framebuffer
   * including kernel-drawn strokes. Returns null on failure.
   */
  captureCanvas: async (
    left: number,
    top: number,
    width: number,
    height: number,
  ): Promise<string | null> => {
    if (!native?.captureCanvas) return null;
    try {
      return await native.captureCanvas(left, top, width, height);
    } catch {
      return null;
    }
  },
};
