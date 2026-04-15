import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  View,
  Pressable,
  Text,
  StyleSheet,
  Modal,
  Alert,
  PixelRatio,
  Image as RNImage,
  useWindowDimensions,
} from "react-native";
import {
  Canvas,
  Path,
  Skia,
  ImageFormat,
  type SkPath,
} from "@shopify/react-native-skia";
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from "react-native-gesture-handler";
import {
  useSharedValue,
  makeMutable,
  runOnJS,
  type SharedValue,
} from "react-native-reanimated";
import {
  Pencil,
  Eraser,
  Undo2,
  Redo2,
  Trash2,
  RotateCw,
} from "lucide-react-native";
import type { Stroke, StrokePoint, PenConfig } from "@readr/shared";
import { useDisplay } from "../../contexts/DisplayContext";
import { StylusOnlyView } from "./StylusOnlyView";
import { EpdMode } from "../../lib/epd-mode";
import {
  HandwriteService,
  isHandwriteServiceAvailable,
  penWidthToSizeIdx,
  eraserWidthToSizeIdx,
} from "../../lib/handwrite-service";

// Supernote's vendor handwriting binder drives the kernel-level
// pen path that bypasses SurfaceFlinger entirely. When it's
// available, the kernel draws strokes straight from the EMR
// digitizer to the EPD framebuffer, so our Skia layer must stay
// OUT of the way during live drawing — every Skia frame we push
// would otherwise fight the kernel's pixels through SurfaceFlinger
// recomposition. On other devices (emulator, LCD, non-Supernote
// e-readers) the flag is false and we use the existing Skia
// path. Computed once at module load — it doesn't change.
const NATIVE_DRAW = isHandwriteServiceAvailable();

/**
 * Run a callback after the current Skia frame has had time to
 * paint and land in SurfaceFlinger. Used to schedule
 * HandwriteService.syncBackground calls so the kernel reads the
 * FRESH Skia surface (with whatever stroke / erase just landed)
 * rather than the stale one from before React re-rendered.
 *
 * Why not just requestAnimationFrame? Skia renders on a separate
 * GPU thread — rAF fires when React's commit is queued, not
 * when Skia has actually pushed pixels. A short timeout covers
 * ~2 display refresh cycles which is enough for the new frame
 * to be on the EPD compositor by the time we fire.
 */
const afterSkiaPaint = (fn: () => void): void => {
  // 80ms = ~5 display frames. Generous but imperceptible on a
  // destructive op. 32ms was too tight — Skia's GPU commit
  // routinely takes 2-3 frames and we were firing sync too
  // early, which is how "cleared strokes come back" slipped in.
  setTimeout(fn, 80);
};

interface HandwritingCanvasProps {
  visible: boolean;
  initialStrokes?: Stroke[];
  initialCanvasImage?: string | null;
  passageText?: string;
  onSave: (strokes: Stroke[], penConfig: PenConfig, canvasImage: string | null) => void;
  onCancel: () => void;
}

const PEN_SIZES = [2, 4, 8] as const;
// Skia stroke widths used when rendering the persistent
// background on Supernote. The kernel's BALL_PEN renders
// pressure-varied strokes whose AVERAGE width is thinner than
// the max (200/400/600 kernel units). Skia draws uniform-width
// strokes, so if we use the same dp values (2/4/8) they look
// noticeably fatter than the kernel version — especially medium
// and large. These scaled-down values keep the Skia render
// slightly thinner than the kernel's average, which is
// imperceptible since the user only sees the Skia version on
// save → reopen (the kernel trail covers it during live drawing).
const PEN_SIZES_NATIVE: Record<number, number> = {
  2: 2,   // small: already thin enough
  4: 3,   // medium: 4 → 3
  8: 5,   // large: 8 → 5
};
const PEN_COLORS = ["#000000", "#dc2626", "#2563eb"] as const;

type CommittedEntry = {
  color: string;
  width: number;
  path: SharedValue<SkPath>;
};

/**
 * Render strokes to an offscreen Skia surface and return a
 * base64-encoded PNG data URI. This produces a STATIC image
 * with no render loop — unlike the Skia <Canvas> component
 * which runs its own continuous frame pump. Used on Supernote
 * so the kernel's trail overlay lives undisturbed.
 */
function renderStrokesToDataUri(
  strokes: Stroke[],
  width: number,
  height: number,
): string | null {
  if (width <= 0 || height <= 0) return null;
  const surface = Skia.Surface.Make(
    Math.round(width),
    Math.round(height),
  );
  if (!surface) return null;
  const canvas = surface.getCanvas();
  // White background matching the canvas style
  const bgPaint = Skia.Paint();
  bgPaint.setColor(Skia.Color("#ffffff"));
  canvas.drawRect(
    { x: 0, y: 0, width, height },
    bgPaint,
  );
  // Draw each stroke
  const byStyle = buildPathsByStyle(strokes);
  for (const [key, path] of Object.entries(byStyle)) {
    const [color, widthStr] = key.split("|");
    const w = Number(widthStr);
    const paint = Skia.Paint();
    paint.setColor(Skia.Color(color));
    paint.setStyle(1); // Stroke
    paint.setStrokeWidth(PEN_SIZES_NATIVE[w] ?? w);
    paint.setStrokeCap(1); // Round
    paint.setStrokeJoin(1); // Round
    paint.setAntiAlias(true);
    canvas.drawPath(path, paint);
  }
  surface.flush();
  const image = surface.makeImageSnapshot();
  const base64 = image.encodeToBase64(ImageFormat.PNG, 100);
  return `data:image/png;base64,${base64}`;
}

/** Build one SkPath per (color, width) from a list of strokes. */
function buildPathsByStyle(strokes: Stroke[]): Record<string, SkPath> {
  const out: Record<string, SkPath> = {};
  for (const s of strokes) {
    const key = `${s.color}|${s.width}`;
    let p = out[key];
    if (!p) {
      p = Skia.Path.Make();
      out[key] = p;
    }
    const pts = s.points;
    if (pts.length === 0) continue;
    p.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      p.lineTo(pts[i].x, pts[i].y);
    }
  }
  return out;
}

export function HandwritingCanvas({
  visible,
  initialStrokes = [],
  initialCanvasImage,
  passageText,
  onSave,
  onCancel,
}: HandwritingCanvasProps) {
  const display = useDisplay();
  const { width: winW, height: winH } = useWindowDimensions();
  const [strokes, setStrokes] = useState<Stroke[]>(initialStrokes);
  // Latest-strokes ref so stable callbacks (notably applyErase,
  // which is called from the worklet via runOnJS and captured into
  // the pan gesture at mount time) can read the current list
  // synchronously without needing to be a dep of the gesture.
  const strokesRef = useRef<Stroke[]>(initialStrokes);
  const redoStackRef = useRef<Stroke[]>([]);
  useEffect(() => {
    strokesRef.current = strokes;
  }, [strokes]);
  // Redo stack.
  const [redoStack, setRedoStack] = useState<Stroke[]>([]);
  const [penColor, setPenColor] = useState("#000000");
  const [penWidth, setPenWidth] = useState(4);
  const [isEraser, setIsEraser] = useState(false);

  // In native-draw mode we use a static image snapshot instead
  // of the Skia <Canvas> component. The Canvas runs a continuous
  // render loop that pushes frames through SurfaceFlinger, which
  // overwrites the kernel's trail pixels. A static <Image> has
  // no render loop — it's just pixels sitting in the window
  // surface, exactly like Ratta Notes' TransferModeView.
  const [snapshotUri, setSnapshotUri] = useState<string | null>(null);

  // Tool config mirrored into a shared value so the pan worklet
  // can read it from the UI thread without crossing into JS.
  const toolShared = useSharedValue({
    color: penColor,
    width: penWidth,
    isEraser,
  });
  useEffect(() => {
    toolShared.value = { color: penColor, width: penWidth, isEraser };
  }, [penColor, penWidth, isEraser, toolShared]);

  // Shared-value mirror of NATIVE_DRAW the worklet can read
  // without crossing the JS bridge. When true, the pan worklet
  // stops mutating the Skia committed paths during live drawing
  // (the kernel is drawing straight to the panel; anything we
  // push through Skia would force SurfaceFlinger recomposition
  // and fight the kernel's pixels).
  const nativeDrawShared = useSharedValue(NATIVE_DRAW);

  // Push pen/eraser tool changes to the kernel. Eraser = same
  // BALL_PEN but with color 255 (white). The kernel draws white
  // pixels where the pen touches — that IS the erase, exactly
  // how Atelier does it (sendEraserInfo type 0 = penType 1,
  // color 255). No JS rendering, no snapshots, no sync.
  useEffect(() => {
    if (!NATIVE_DRAW || !visible) return;
    if (isEraser) {
      // Raw kernel size values — FIXED_CIRCLR_PEN, uniform width.
      // pen 2 → 1000, pen 4 → 1500, pen 8 → 2400
      const eraserSize = penWidth <= 2 ? 1000 : penWidth <= 4 ? 1500 : 2400;
      HandwriteService.setEraser(eraserSize);
    } else {
      HandwriteService.setPen(1, penWidthToSizeIdx(penWidth));
    }
  }, [isEraser, penWidth, visible]);

  // ─── Single-canvas architecture ─────────────────────────────────
  //
  // Earlier versions had TWO canvases — a committed layer driven
  // by React state and a live layer driven by a shared-value
  // SkPath. The handoff between them was racy: on stroke end we
  // scheduled runOnJS(commitStroke) (async), but the next stroke's
  // onBegin wiped the live path synchronously on the UI thread.
  // If the user started a new stroke before the committed canvas
  // had re-rendered with the previous one, there was a frame (or
  // several, on e-ink) where the previous stroke existed in
  // NEITHER layer — a per-stroke flicker, worse when drawing fast.
  //
  // New design: one canvas, all strokes mutated in place on the UI
  // thread via pre-allocated shared SkPaths — one per (color,
  // width) combination. Starting a new stroke appends a new
  // sub-path via moveTo/lineTo on the appropriate shared path;
  // finished strokes simply stay in that path for the rest of the
  // session. React state (`strokes`) is kept in parallel only for
  // save/undo/clear/erase bookkeeping — it never drives the
  // display for a new stroke, so no re-render happens as a direct
  // consequence of finishing a stroke. The only time the shared
  // paths are rebuilt from React state is on an explicit button
  // tap (undo/clear/erase/modal reopen).
  //
  // `makeMutable` escapes hook ordering and lets us allocate one
  // shared SkPath per (color, width) combo in a single useRef.

  const committedPathsRef = useRef<CommittedEntry[] | null>(null);
  if (committedPathsRef.current === null) {
    const entries: CommittedEntry[] = [];
    for (const color of PEN_COLORS) {
      for (const width of PEN_SIZES) {
        entries.push({
          color,
          width,
          path: makeMutable(Skia.Path.Make()),
        });
      }
    }
    committedPathsRef.current = entries;
  }
  const committedPaths = committedPathsRef.current;

  // Eraser feedback path — a single shared SkPath that draws the
  // "rub" gesture while erasing. Purely visual; the actual erase
  // happens on onEnd by filtering `strokes` on the JS thread and
  // rebuilding the committed paths.
  const eraserPath = useSharedValue<SkPath>(Skia.Path.Make());

  // Points of the currently-in-progress stroke, held on the UI
  // thread so onEnd can hand them to the JS thread for bookkeeping.
  const livePointsShared = useSharedValue<StrokePoint[]>([]);

  // Rebuild the committed shared paths from React `strokes`. Called
  // only on modal open / clear / undo / erase — never when a new
  // stroke is added, since the worklet already writes directly into
  // the committed shared paths on the UI thread.
  const rebuildFromStrokes = useCallback(
    (next: Stroke[]) => {
      const byKey = buildPathsByStyle(next);
      for (const e of committedPaths) {
        const k = `${e.color}|${e.width}`;
        e.path.value = byKey[k] ?? Skia.Path.Make();
      }
    },
    [committedPaths],
  );

  // Card layout in device-pixel coordinates. This drives both
  // our own layout and the DISABLE_AREA rects we hand to the
  // kernel handwriting service so strokes never land outside
  // the drawable region of the modal card.
  const cardW = Math.min(winW - 24, 900);
  const cardH = Math.min(winH - 120, 1000);
  const cardX = (winW - cardW) / 2;
  const cardY = (winH - cardH) / 2;
  // Vertical space taken by the card header + toolbar above
  // the drawable area. Keep this in sync with the style
  // constants (headerPaddingTop 12 + ~32 row + toolbar ~44).
  const HEADER_DP = 94;

  // The drawable area inside the card (below header + toolbar).
  // Used for the offscreen Skia snapshot in native-draw mode.
  const canvasW = cardW;
  const canvasH = cardH - HEADER_DP;

  // Helper: render strokes to a static image and set it as the
  // snapshot. Only used in NATIVE_DRAW mode. On non-Supernote
  // devices, the Skia <Canvas> handles rendering directly.
  const renderSnapshot = useCallback(
    (next: Stroke[]) => {
      if (!NATIVE_DRAW) return;
      const uri = renderStrokesToDataUri(next, canvasW, canvasH);
      setSnapshotUri(uri);
    },
    [canvasW, canvasH],
  );

  // Same rect expressed in PANEL PIXELS — for the Rockchip
  // View.invalidate(l, t, r, b, waveform) partial refresh API
  // which works in raw pixels, not dp.
  const drawRectPx = useMemo(() => {
    const px = PixelRatio.get();
    return {
      left: Math.round(cardX * px),
      top: Math.round((cardY + HEADER_DP) * px),
      right: Math.round((cardX + cardW) * px),
      bottom: Math.round((cardY + cardH) * px),
    };
  }, [cardX, cardY, cardW, cardH]);

  // Reset the canvas whenever the modal opens.
  useEffect(() => {
    if (visible) {
      strokesRef.current = initialStrokes;
      redoStackRef.current = [];
      // Reset tool to pencil on every open so the kernel
      // starts in pen mode, not stuck in eraser from a
      // previous session.
      setIsEraser(false);
      if (!NATIVE_DRAW) {
        setStrokes(initialStrokes);
        setRedoStack([]);
        rebuildFromStrokes(initialStrokes);
      } else {
        // Use the saved framebuffer screenshot if available,
        // otherwise render from strokes as fallback (first
        // time opening a note that was created on LCD).
        if (initialCanvasImage) {
          setSnapshotUri(initialCanvasImage);
        } else {
          renderSnapshot(initialStrokes);
        }
      }
      livePointsShared.value = [];
      eraserPath.value = Skia.Path.Make();
      EpdMode.setA2();

      // Hand the drawing region to the vendor handwrite service
      // so the kernel knows where it's allowed to rasterize pen
      // strokes. Coordinates are device pixels, not dp — the
      // kernel driver works in raw panel pixels (1404×1872 on
      // Nomad) and Atelier's HandWriteClient does the same dp→px
      // conversion. We give it rects covering everything OUTSIDE
      // the drawable area: the four strips of "window minus
      // card" plus the card's header and toolbar.
      if (NATIVE_DRAW) {
        const px = PixelRatio.get();
        const screenW = Math.round(winW * px);
        const screenH = Math.round(winH * px);
        // Inset the drawable region by CANVAS_INSET so strokes
        // can't land right at the card border or on the toolbar.
        const drawLeft = Math.round(cardX * px);
        const drawTop = Math.round((cardY + HEADER_DP + 8) * px);
        const drawRight = Math.round((cardX + cardW) * px);
        const drawBottom = Math.round((cardY + cardH) * px);
        // Four strips forbidding the area outside the drawable
        // rectangle: top (above header), bottom, left, right.
        // Rects are passed as [l, t, r, b, l, t, r, b, ...].
        const disableRects: number[] = [
          // top strip (window top to just above draw area)
          0, 0, screenW, drawTop,
          // bottom strip
          0, drawBottom, screenW, screenH,
          // left strip (between top and bottom strips)
          0, drawTop, drawLeft, drawBottom,
          // right strip
          drawRight, drawTop, screenW, drawBottom,
        ];
        const penTypeIdx = 1; // BALL_PEN
        HandwriteService.start(
          penTypeIdx,
          penWidthToSizeIdx(penWidth),
          disableRects,
        ).then(() => {
          if (initialStrokes.length > 0) {
            afterSkiaPaint(() => HandwriteService.syncBackground());
          }
        });
      }
    } else {
      // Release the override when the modal closes so the reader
      // screen goes back to GC16 (readable 16-level text).
      EpdMode.reset();
      if (NATIVE_DRAW) HandwriteService.stop();
    }
    // Cleanup: always stop kernel writing when this effect
    // re-runs or the component unmounts — covers edge cases
    // where the modal closes without visible flipping to false.
    return () => {
      if (NATIVE_DRAW) HandwriteService.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // ─── Close / ghost clear ───────────────────────────────────────
  //
  // We used to run a two-phase black→white software flash here
  // as a "ghost clear" bandaid. It was making things worse: on
  // Supernote the flash overlays go through the same GC16
  // compositor path as everything else and just bake in MORE
  // ghost residue. Removed.
  //
  // For real ghost clearing we rely entirely on EpdMode.setFull
  // (Rockchip native full-refresh waveform) where available.
  // On devices without the reflection target there's no good
  // option from a sideloaded app — accept the residue.
  const doCancel = useCallback(() => {
    if (NATIVE_DRAW) HandwriteService.stop();
    EpdMode.reset();
    onCancel();
  }, [onCancel]);
  // Helper to restart kernel writing after an alert dismisses.
  const restartKernel = useCallback(() => {
    if (!NATIVE_DRAW) return;
    const px = PixelRatio.get();
    const screenW = Math.round(winW * px);
    const screenH = Math.round(winH * px);
    const dL = Math.round(cardX * px);
    const dT = Math.round((cardY + HEADER_DP + 8) * px);
    const dR = Math.round((cardX + cardW) * px);
    const dB = Math.round((cardY + cardH) * px);
    HandwriteService.start(1, penWidthToSizeIdx(penWidth), [
      0, 0, screenW, dT,
      0, dB, screenW, screenH,
      0, dT, dL, dB,
      dR, dT, screenW, dB,
    ]);
  }, [winW, winH, cardX, cardY, cardW, cardH, penWidth]);

  const handleCancel = useCallback(() => {
    const hasChanges = strokesRef.current.length !== initialStrokes.length;
    if (hasChanges) {
      // Don't stop the kernel until the user actually confirms. Stopping
      // it here caused a visible panel flicker even when they picked
      // "Keep editing", defeating the purpose of the confirmation.
      Alert.alert("Discard changes?", "Your drawing will not be saved.", [
        { text: "Keep editing", style: "cancel" },
        {
          text: "Discard",
          style: "destructive",
          onPress: () => {
            if (NATIVE_DRAW) HandwriteService.stop();
            doCancel();
          },
        },
      ]);
    } else {
      doCancel();
    }
  }, [doCancel, initialStrokes.length]);
  const handleSave = useCallback(async () => {
    if (NATIVE_DRAW) {
      // If a debounced capture is pending, flush it now.
      if (captureTimerRef.current) {
        clearTimeout(captureTimerRef.current);
        captureTimerRef.current = null;
        const img = await HandwriteService.captureCanvas(
          cardX, cardY + HEADER_DP, canvasW, canvasH,
        );
        if (img) latestImageRef.current = img;
      }
      HandwriteService.stop();
      EpdMode.reset();
      onSave(strokesRef.current, { color: penColor, width: penWidth }, latestImageRef.current);
      return;
    }
    EpdMode.reset();
    onSave(strokes, { color: penColor, width: penWidth }, null);
  }, [onSave, strokes, penColor, penWidth, cardX, cardY, canvasW, canvasH]);
  const handleRefresh = useCallback(() => {
    // Native full-refresh then restore A2 for continued drawing.
    // No-op on non-Rockchip devices.
    (async () => {
      await EpdMode.setFull();
      await EpdMode.setA2();
    })();
  }, []);

  // ─── Debounced screenshot after each stroke ────────────────────
  //
  // Capture the framebuffer after each stroke release so we
  // always have a recent snapshot ready. Save just reads the
  // ref — no capture needed at save time.
  const latestImageRef = useRef<string | null>(initialCanvasImage ?? null);
  const captureTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debouncedCapture = useCallback(() => {
    if (!NATIVE_DRAW) return;
    if (captureTimerRef.current) clearTimeout(captureTimerRef.current);
    captureTimerRef.current = setTimeout(async () => {
      captureTimerRef.current = null;
      const img = await HandwriteService.captureCanvas(
        cardX,
        cardY + HEADER_DP,
        canvasW,
        canvasH,
      );
      if (img) latestImageRef.current = img;
    }, 150);
  }, [cardX, cardY, canvasW, canvasH]);

  // ─── JS-side commit (bookkeeping only) ─────────────────────────
  //
  // Any new mark (pen stroke or erase) invalidates the redo stack,
  // since the history branch the redo entries belonged to is no
  // longer reachable.
  const addPenStroke = useCallback(
    (points: StrokePoint[], color: string, width: number) => {
      if (points.length === 0) return;
      if (NATIVE_DRAW) {
        strokesRef.current = [
          ...strokesRef.current,
          { points, color, width },
        ];
        redoStackRef.current = [];
        debouncedCapture();
        return;
      }
      setStrokes((prev) => [...prev, { points, color, width }]);
      setRedoStack([]);
    },
    [debouncedCapture],
  );

  const flushKernelBuffer = useCallback(() => {
    if (!NATIVE_DRAW) return;
    afterSkiaPaint(() => {
      HandwriteService.syncBackground();
      EpdMode.invalidateRect(
        drawRectPx.left,
        drawRectPx.top,
        drawRectPx.right,
        drawRectPx.bottom,
        10,
      );
    });
  }, [drawRectPx]);

  const applyErase = useCallback(
    (points: StrokePoint[]) => {
      eraserPath.value = Skia.Path.Make();
      if (points.length === 0) return;
      const prev = strokesRef.current;
      const next = prev.filter((s) => {
        for (const ep of points) {
          for (const sp of s.points) {
            const dx = ep.x - sp.x;
            const dy = ep.y - sp.y;
            if (dx * dx + dy * dy < 400) return false; // 20px
          }
        }
        return true;
      });
      if (next.length === prev.length) return;
      strokesRef.current = next;
      redoStackRef.current = [];
      if (NATIVE_DRAW) {
        // Kernel already drew white over the erased area — we
        // just need to remove affected strokes from the ref so
        // save doesn't bring them back. No rendering needed.
        return;
      }
      rebuildFromStrokes(next);
      setStrokes(next);
      setRedoStack([]);
    },
    [rebuildFromStrokes, eraserPath],
  );

  // ─── Pan gesture (pen + eraser, UI-thread) ─────────────────────
  const MAX_JUMP = 150;
  const MAX_JUMP_SQ = MAX_JUMP * MAX_JUMP;
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .maxPointers(1)
        .averageTouches(false)
        .onBegin((e) => {
          "worklet";
          const tool = toolShared.value;
          livePointsShared.value = [
            { x: e.x, y: e.y, pressure: 0.5 },
          ];
          // When the vendor kernel handwrite path is active we
          // don't touch Skia at all during live drawing — the
          // kernel draws straight to the EPD framebuffer from
          // the digitizer, and any Skia path mutation here would
          // push a SurfaceFlinger frame through the compositor
          // and fight the kernel's pixels. We still collect pen
          // points so onEnd can commit the finished stroke to
          // React state for save / undo / redo bookkeeping.
          if (nativeDrawShared.value) return;
          if (tool.isEraser) {
            const p = Skia.Path.Make();
            p.moveTo(e.x, e.y);
            p.lineTo(e.x + 0.5, e.y + 0.5);
            eraserPath.value = p;
            return;
          }
          // Fallback Skia path: draw an immediate visible dot at
          // the touch point, not just a moveTo. moveTo only sets
          // the "current point" for the next lineTo — no pixels
          // are emitted. The tiny +0.5px lineTo forces Skia to
          // rasterize one stamp of the stroke at the touch
          // location so the pen tip is visible immediately.
          for (let i = 0; i < committedPaths.length; i++) {
            const entry = committedPaths[i];
            if (entry.color === tool.color && entry.width === tool.width) {
              entry.path.modify((p) => {
                p.moveTo(e.x, e.y);
                p.lineTo(e.x + 0.5, e.y + 0.5);
                return p;
              });
              break;
            }
          }
        })
        .onUpdate((e) => {
          "worklet";
          const pts = livePointsShared.value;
          const last = pts[pts.length - 1];
          if (last) {
            const dx = e.x - last.x;
            const dy = e.y - last.y;
            if (dx * dx + dy * dy > MAX_JUMP_SQ) return;
          }
          pts.push({ x: e.x, y: e.y, pressure: 0.5 });
          if (nativeDrawShared.value) return;
          const tool = toolShared.value;
          if (tool.isEraser) {
            eraserPath.modify((p) => {
              p.lineTo(e.x, e.y);
              return p;
            });
            return;
          }
          for (let i = 0; i < committedPaths.length; i++) {
            const entry = committedPaths[i];
            if (entry.color === tool.color && entry.width === tool.width) {
              entry.path.modify((p) => {
                p.lineTo(e.x, e.y);
                return p;
              });
              break;
            }
          }
        })
        .onEnd(() => {
          "worklet";
          const pts = livePointsShared.value;
          const tool = toolShared.value;
          livePointsShared.value = [];
          if (tool.isEraser) {
            if (nativeDrawShared.value) {
              // Save the eraser gesture as a white stroke so
              // Skia renders white-over-black on reopen — same
              // visual as the kernel's live white drawing.
              // Matches kernel eraser sizes: 1000→10, 1500→15, 2400→24
              const eraserW = tool.width <= 2 ? 10 : tool.width <= 4 ? 15 : 24;
              runOnJS(addPenStroke)(pts, "#ffffff", eraserW);
            } else {
              runOnJS(applyErase)(pts);
            }
          } else {
            runOnJS(addPenStroke)(pts, tool.color, tool.width);
          }
        })
        .onFinalize((_e, success) => {
          "worklet";
          if (!success) {
            livePointsShared.value = [];
            // Eraser feedback is cheap to clear; pen-paths are
            // accepted as-is (a partial stroke is preferable to
            // rewinding the committed path, which would require
            // saving a pre-onBegin snapshot on every press).
            eraserPath.value = Skia.Path.Make();
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [applyErase, addPenStroke],
  );

  // ─── Undo / redo / clear — rebuild shared paths from strokes[] ─
  //
  // Undo pops the last stroke off `strokes` and pushes it onto
  // the redo stack. Redo is the inverse. Clear drops everything
  // and also empties the redo stack (no way to come back from a
  // full clear).
  // Undo / redo / clear. No more software flash — it was making
  // ghosting worse, not better. EpdMode.setA2 stays pinned for
  // the whole session; the panel naturally redraws the dirty
  // region when rebuildFromStrokes updates the shared paths.
  // After a destructive op (undo / redo / clear / erase) the
  // kernel still has the removed strokes cached in its own
  // trail buffer and keeps re-compositing them over our new
  // background, which reads on-panel as ghosts that "won't go
  // away". Ratta Notes handles this by firing transact 6
  // (SYNC_BACKGROUND_MAYBE_LOSS_PARTIAL_TRAIL) which tells the
  // kernel to drop its cached trail and re-read the background
  // from our window surface. Non-flashing; just a single binder
  // call. See NotePresenter.onUndoRedoClick for the reference
  // flow — they set isNeedSyncBuff=true, then the next layer
  // load fires sendSyncBackgroundBuffMayBeLostTrail. We just
  // call it directly here since our state update is already
  // synchronous with the ensuing Skia repaint. No-op on
  // non-Supernote devices.
  const handleUndo = useCallback(() => {
    const prev = strokesRef.current;
    if (prev.length === 0) return;
    const popped = prev[prev.length - 1];
    const next = prev.slice(0, -1);
    strokesRef.current = next;
    redoStackRef.current = [...redoStackRef.current, popped];
    if (NATIVE_DRAW) {
      // Re-render static snapshot with remaining strokes,
      // then tell the kernel to drop its trail and re-read
      // the fresh snapshot as its background.
      renderSnapshot(next);
      flushKernelBuffer();
    } else {
      rebuildFromStrokes(next);
      setStrokes(next);
      setRedoStack(redoStackRef.current);
    }
  }, [rebuildFromStrokes, flushKernelBuffer, renderSnapshot]);
  const handleRedo = useCallback(() => {
    const r = redoStackRef.current;
    if (r.length === 0) return;
    const last = r[r.length - 1];
    const nextRedo = r.slice(0, -1);
    redoStackRef.current = nextRedo;
    const prev = strokesRef.current;
    const next = [...prev, last];
    strokesRef.current = next;
    if (NATIVE_DRAW) {
      renderSnapshot(next);
      flushKernelBuffer();
    } else {
      rebuildFromStrokes(next);
      setStrokes(next);
      setRedoStack(nextRedo);
    }
  }, [rebuildFromStrokes, flushKernelBuffer, renderSnapshot]);
  const doClear = useCallback(() => {
    const next: Stroke[] = [];
    strokesRef.current = next;
    redoStackRef.current = [];
    if (NATIVE_DRAW) {
      renderSnapshot(next);
      flushKernelBuffer();
    } else {
      rebuildFromStrokes(next);
      setStrokes(next);
      setRedoStack([]);
    }
  }, [rebuildFromStrokes, flushKernelBuffer, renderSnapshot]);
  const handleClear = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    // Don't stop the kernel until the user confirms — otherwise the
    // panel flashes a "clear" even when they tap Cancel, which is
    // exactly what the confirmation is there to prevent.
    Alert.alert("Clear canvas", "Erase everything?", [
      { text: "Cancel", style: "cancel" },
      { text: "Clear", style: "destructive", onPress: async () => {
        if (NATIVE_DRAW) HandwriteService.stop();
        doClear();
        // Full refresh to wipe kernel trail from panel.
        await EpdMode.setFull();
        restartKernel();
      }},
    ]);
  }, [doClear, restartKernel]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType={display.animationsEnabled ? "fade" : "none"}
      onRequestClose={handleCancel}
    >
      <GestureHandlerRootView style={[StyleSheet.absoluteFill, { overflow: "hidden" }]}>
        {/* Backdrop is a plain View — NOT a Pressable. Accidental
            palm/finger touches outside the card should never dismiss
            the drawing session. The only way out is the X button or
            Save. On e-ink the dim colour is dropped entirely —
            translucent blacks dither into a speckle pattern that
            leaves its own ghost. */}
        {/*
          On e-ink the backdrop is OPAQUE WHITE, not dimmed and not
          transparent. Both of the obvious alternatives are wrong:
            - a dimmed rgba(0,0,0,0.35) backdrop dithers into gray
              noise that forces the EPD onto GC16 and leaves its
              own ghost
            - a transparent backdrop lets the reader screen
              underneath remain visible, and every time the Skia
              canvas commits a new frame SurfaceFlinger composites
              the *entire* screen (including the reader's book
              text) and pushes it to the EPD driver, which then
              partial-refreshes the book area through GC16 over
              and over — baking residue into the book pixels.
              That's why ghosting was appearing inside the book
              text, not just on the canvas.
          Opaque white fully occludes the reader, so those pixels
          stay constant frame-to-frame and the EPD driver's
          dirty-rect detection skips them entirely.
        */}
        <View
          style={[
            styles.backdrop,
            display.isEink && { backgroundColor: "#ffffff" },
          ]}
          pointerEvents="none"
        />
        <View style={styles.centerWrap} pointerEvents="box-none">
          <View
            style={[
              styles.card,
              { width: cardW, height: cardH },
              // Drop the drop-shadow on e-ink. Android re-rasters
              // elevation shadows into a separate layer every frame
              // a child redraws — every stroke on our Skia canvas
              // marks the whole card dirty, so we'd be paying the
              // shadow composite cost per pointer sample. It also
              // looks terrible on an e-ink panel (grey halo dither
              // that leaves its own ghost).
              display.isEink && styles.cardFlat,
            ]}
          >
            <View style={styles.header}>
              <Pressable
                onPress={handleCancel}
                hitSlop={12}
                style={styles.closeBtn}
              >
                <Text style={styles.closeText}>✕</Text>
              </Pressable>
              <Text style={styles.title}>Draw</Text>
              <Pressable onPress={handleSave} hitSlop={12}>
                <Text style={styles.saveText}>Save</Text>
              </Pressable>
            </View>
            {passageText ? (
              <View style={styles.passageBar}>
                <Text style={styles.passageText} numberOfLines={2}>
                  &ldquo;{passageText}&rdquo;
                </Text>
              </View>
            ) : null}

            {/* Pen toolbar */}
            <View style={styles.toolbar}>
              {PEN_SIZES.map((size) => (
                <Pressable
                  key={size}
                  style={[
                    styles.sizeButton,
                    penWidth === size && styles.sizeButtonActive,
                  ]}
                  onPress={() => setPenWidth(size)}
                >
                  <View
                    style={{
                      width: size * 2,
                      height: size * 2,
                      borderRadius: size,
                      backgroundColor: penWidth === size ? "#111" : "#999",
                    }}
                  />
                </Pressable>
              ))}

              <View style={styles.separator} />

              {PEN_COLORS.map((color) => (
                <Pressable
                  key={color}
                  style={[
                    styles.colorDot,
                    { backgroundColor: color },
                    penColor === color && !isEraser && styles.colorDotActive,
                  ]}
                  onPress={() => setPenColor(color)}
                />
              ))}

              <View style={styles.separator} />

              <Pressable
                style={[
                  styles.toolButton,
                  !isEraser && styles.toolButtonActive,
                ]}
                onPress={() => setIsEraser(false)}
                accessibilityLabel="Pencil"
              >
                <Pencil size={18} color={!isEraser ? "#fff" : "#111"} />
              </Pressable>
              <Pressable
                style={[
                  styles.toolButton,
                  isEraser && styles.toolButtonActive,
                ]}
                onPress={() => setIsEraser(true)}
                accessibilityLabel="Eraser"
              >
                <Eraser size={18} color={isEraser ? "#fff" : "#111"} />
              </Pressable>

              <View style={styles.separator} />

              {!NATIVE_DRAW ? (
                <>
                  <Pressable
                    style={[
                      styles.toolButton,
                      strokes.length === 0 && styles.toolButtonDisabled,
                    ]}
                    onPress={handleUndo}
                    disabled={strokes.length === 0}
                    accessibilityLabel="Undo"
                  >
                    <Undo2
                      size={18}
                      color={strokes.length === 0 ? "#bbb" : "#111"}
                    />
                  </Pressable>

                  <Pressable
                    style={[
                      styles.toolButton,
                      redoStack.length === 0 && styles.toolButtonDisabled,
                    ]}
                    onPress={handleRedo}
                    disabled={redoStack.length === 0}
                    accessibilityLabel="Redo"
                  >
                    <Redo2
                      size={18}
                      color={redoStack.length === 0 ? "#bbb" : "#111"}
                    />
                  </Pressable>
                </>
              ) : null}

              <Pressable
                style={styles.toolButton}
                onPress={handleClear}
                accessibilityLabel="Clear canvas"
              >
                <Trash2 size={18} color="#111" />
              </Pressable>

              {display.isEink ? (
                <Pressable
                  style={styles.toolButton}
                  onPress={handleRefresh}
                  accessibilityLabel="Refresh display"
                >
                  <RotateCw size={18} color="#111" />
                </Pressable>
              ) : null}
            </View>

            {/*
              StylusOnlyView intercepts dispatchTouchEvent at the
              native layer and drops pure-finger MotionEvents
              before they reach react-native-gesture-handler or
              Skia. On e-ink we enable it so palm contacts
              (including palms that land BEFORE the pen, which
              maxPointers(1) can't reject) never enter the
              gesture pipeline at all. Also enforces a 500 ms
              pen-priority lockout where finger events are
              dropped for a window after each stylus sample.
              On LCD we leave it off so finger drawing still
              works on emulators/phones.
            */}
            <StylusOnlyView
              style={styles.canvas}
              stylusOnly={display.isEink}
            >
              <GestureDetector gesture={pan}>
                <View style={[StyleSheet.absoluteFill, { overflow: "hidden" }]} collapsable={false}>
                  {/* Round caps + join and full Skia antialiasing.
                      We tried disabling AA + using butt/miter on
                      e-ink to force the mxcfb driver onto the fast
                      DU waveform, but the jagged polygonal ends
                      looked awful. With EpdMode.setA2() active,
                      the waveform selection is already forced at
                      the kernel level — the Skia paint's AA flag
                      doesn't matter for waveform picking anymore,
                      so we get clean round strokes AND fast panel
                      response. */}
                  {NATIVE_DRAW ? (
                    // Static image — no render loop. The kernel
                    // draws live strokes directly to the EPD on
                    // top of this. Re-rendered only on open /
                    // undo / redo / clear via renderSnapshot().
                    snapshotUri ? (
                      <RNImage
                        source={{ uri: snapshotUri }}
                        style={StyleSheet.absoluteFill}
                        resizeMode="cover"
                      />
                    ) : (
                      <View style={[StyleSheet.absoluteFill, { backgroundColor: "#fff" }]} />
                    )
                  ) : (
                    <Canvas style={StyleSheet.absoluteFill}>
                      {committedPaths.map((e) => (
                        <Path
                          key={`${e.color}|${e.width}`}
                          path={e.path}
                          color={e.color}
                          style="stroke"
                          strokeWidth={e.width}
                          strokeCap="round"
                          strokeJoin="round"
                        />
                      ))}
                      <Path
                        path={eraserPath}
                        color="#cccccc"
                        style="stroke"
                        strokeWidth={20}
                        strokeCap="round"
                        strokeJoin="round"
                        opacity={0.5}
                      />
                    </Canvas>
                  )}
                </View>
              </GestureDetector>
            </StylusOnlyView>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  centerWrap: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
    padding: 16,
  },
  card: {
    backgroundColor: "#fff",
    borderRadius: 14,
    overflow: "hidden",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 8,
  },
  cardFlat: {
    shadowOpacity: 0,
    shadowRadius: 0,
    elevation: 0,
    borderWidth: 1,
    borderColor: "#000",
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
  },
  title: { fontSize: 16, fontWeight: "600" },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  closeText: { fontSize: 18, color: "#666", lineHeight: 20 },
  saveText: { fontSize: 15, color: "#111", fontWeight: "600" },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    gap: 6,
    flexWrap: "wrap",
  },
  sizeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    justifyContent: "center",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "transparent",
  },
  sizeButtonActive: { borderColor: "#111" },
  colorDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: "transparent",
  },
  colorDotActive: { borderColor: "#111" },
  separator: { width: 1, height: 20, backgroundColor: "#e0e0e0" },
  toolButton: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#ddd",
    minWidth: 34,
    minHeight: 30,
    justifyContent: "center",
    alignItems: "center",
  },
  toolButtonActive: { backgroundColor: "#111", borderColor: "#111" },
  // Disabled look for undo/redo when there's nothing to undo/redo.
  toolButtonDisabled: {
    borderColor: "#eee",
    backgroundColor: "#f5f5f5",
  },
  toolButtonText: { fontSize: 11, color: "#666" },
  passageBar: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#e0e0e0",
    backgroundColor: "#f9f9f9",
  },
  passageText: {
    fontSize: 12,
    color: "#666",
    fontStyle: "italic",
    lineHeight: 16,
  },
  canvas: {
    flex: 1,
    overflow: "hidden",
    // Pure white — any off-white like #fafafa dithers into gray
    // pixels on e-ink and forces the mxcfb driver onto the slow
    // GC16 waveform.
    backgroundColor: "#ffffff",
  },
});
