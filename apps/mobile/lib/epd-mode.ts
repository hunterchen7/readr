import { NativeModules, Platform } from "react-native";

/**
 * Safe wrapper around the native EpdMode module (Android-only).
 *
 * The native module uses reflection to call a Rockchip-private
 * `View.requestEpdMode(String)` method that Ratta's own Notes and
 * Atelier apps use to pin the EPD panel onto its fast A2 waveform.
 * This cuts stroke-to-pixel latency from ~300ms (GC16) to ~120ms
 * (A2) and eliminates the ghost residue that would otherwise
 * accumulate during drawing.
 *
 * All methods are no-ops on iOS / web / emulators / devices
 * without the hidden API — they resolve to false and never throw.
 * Callers should treat failure as "we're on a normal display,
 * drawing still works, just without the waveform boost".
 */

type EpdModeNative = {
  setA2: () => Promise<boolean>;
  setPart: () => Promise<boolean>;
  setFull: () => Promise<boolean>;
  reset: () => Promise<boolean>;
  probeHandwriteService: () => Promise<unknown>;
  invalidateRect: (
    left: number,
    top: number,
    right: number,
    bottom: number,
    waveform: number,
  ) => Promise<boolean>;
};

const native: EpdModeNative | null =
  Platform.OS === "android" && NativeModules.EpdMode
    ? (NativeModules.EpdMode as EpdModeNative)
    : null;

async function safe(
  fn: (() => Promise<boolean>) | undefined,
): Promise<boolean> {
  if (!fn) return false;
  try {
    return await fn();
  } catch {
    return false;
  }
}

export const EpdMode = {
  /** Pin the panel to A2 (fast, 1-bit, low-latency) — call when
   *  entering a drawing canvas. */
  setA2: () => safe(native?.setA2),
  /** Partial refresh mode — idle default while the canvas is
   *  mounted but the user isn't actively stroking. */
  setPart: () => safe(native?.setPart),
  /** Full GC16 refresh — call after large destructive ops
   *  (erase, clear, undo) to fully flush ghost residue. */
  setFull: () => safe(native?.setFull),
  /** Release the waveform override back to Android default
   *  — call on canvas unmount. */
  reset: () => safe(native?.reset),
  /** Rockchip partial refresh with an explicit waveform hint.
   *  Coordinates are PANEL PIXELS (not dp). Waveform 10 is the
   *  clean-partial waveform Supernote Note uses in
   *  autoRefreshInvalidate. Silently falls back to a plain
   *  invalidate on non-Rockchip devices. */
  invalidateRect: (
    left: number,
    top: number,
    right: number,
    bottom: number,
    waveform = 10,
  ): Promise<boolean> => {
    if (!native?.invalidateRect) return Promise.resolve(false);
    return native
      .invalidateRect(left, top, right, bottom, waveform)
      .catch(() => false);
  },
  /** Diagnostic: probe `service_myservice` / android.demo.IMyService
   *  — the vendor binder Atelier / Supernote Notes use for the
   *  kernel handwriting path. Logs everything with tag
   *  HandwriteProbe. Returns the native result verbatim so JS can
   *  log it too. */
  probeHandwriteService: async (): Promise<unknown> => {
    if (!native?.probeHandwriteService) return null;
    try {
      return await native.probeHandwriteService();
    } catch (e) {
      return { error: String(e) };
    }
  },
};
