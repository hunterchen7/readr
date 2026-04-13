package com.readr.app

import android.graphics.Bitmap
import android.graphics.Rect
import android.os.IBinder
import android.os.Parcel
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray

/**
 * Direct client for Supernote's vendor handwriting service
 * (`service_myservice` / `android.demo.IMyService`).
 *
 * This is the binder interface Atelier and the official Ratta
 * Notes app use to drive the kernel handwriting pipeline. Pen
 * samples are consumed by a kernel driver straight from the EMR
 * digitizer and rasterized directly into the EPD framebuffer —
 * the app never sees individual pen points during a stroke, it
 * only tells the service:
 *
 *   • which app we are (WRITE_APP_INFO)
 *   • where on the panel we're allowed to draw (DISABLE_AREA_INFO)
 *   • what pen to use (PEN_INFO)
 *   • where the scroll/content origin is (SHIFT_INFO)
 *   • a snapshot of the background bitmap the kernel should
 *     composite strokes over (SYNC_BACKGROUND)
 *
 * By bypassing SurfaceFlinger and the Android input/render path
 * entirely, the panel draws pen strokes with ~20ms latency and
 * no GC16 re-composition ghosting.
 *
 * Everything here is learned from reverse-engineering Atelier's
 * `com.ratta.paint.HandWriteClient` and the official note app's
 * `com.ratta.supernote.note.utils.HandWriteClient`. Transaction
 * codes, interface token string, parcel shape, and app-name
 * sentinel are all copied byte-for-byte from those decompiled
 * clients — a mismatch in any of them makes the service silently
 * drop the transact.
 *
 * Probe confirmed this works from a normal UID 10094 third-party
 * app on a stock Nomad running Android 11 — see EpdModeModule
 * .probeHandwriteService and the HandwriteProbe logcat tag.
 */
class HandwriteServiceModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  override fun getName(): String = "HandwriteService"

  companion object {
    private const val TAG = "Handwrite"

    // The binder token the service checks on every transact.
    // Byte-for-byte match for Atelier / Notes.
    private const val INTERFACE_TOKEN = "android.demo.IMyService"

    // Registered as "service_myservice" in /system/bin/servicemanager.
    private const val SERVICE_NAME = "service_myservice"

    // App name handed to the service on every call. Atelier uses
    // "SupernotePaint" and Notes uses "superNoteNote"; the
    // service appears to treat it as a free-form identifier so we
    // use our own brand.
    private const val APP_NAME = "readr"

    // Transaction codes (from HandWriteClient.WriteInfo):
    private const val TRANSACT_WRITE_APP_INFO = 0
    private const val TRANSACT_DISABLE_AREA_INFO = 1
    private const val TRANSACT_PEN_INFO = 2
    private const val TRANSACT_SHIFT_INFO = 3
    private const val TRANSACT_TRAIL_INFO = 4
    private const val TRANSACT_SYNC_BACKGROUND = 6
    private const val TRANSACT_SET_RUBBER_INFO = 13

    // Pen types (from HandWriteClient.penType). BALL_PEN gives
    // pressure-varied stroke width which the user prefers —
    // strokes look "alive" with natural variation. The kernel
    // handles pressure scaling on its own based on EMR data.
    const val PEN_TYPE_BALL_PEN = 1
    const val PEN_TYPE_RUBBER_ERASE_PIXES = 8

    // Atelier's A6X pen-size table for BALL_PEN is row 1 of
    // penSizeArrayA6X: only three sizes {200, 400, 600}.
    // These are the "max width at full pressure" values —
    // the kernel scales down dynamically based on EMR pressure.
    private val PEN_SIZE_TABLE = intArrayOf(200, 400, 600)

    // Eraser size table (HandWriteClient.eraserArray).
    private val ERASER_SIZE_TABLE = intArrayOf(400, 1000, 1600, 2200)

    // Sentinel rects the service uses for global enable/disable
    // of writing. Magic values from HandWriteClient.sendWritable.
    private val RECT_WRITE_ENABLED = Rect(0, 0, 18888, 18888)
    private val RECT_WRITE_DISABLED = Rect(0, 0, 19999, 19999)

    // Atelier's color palette — an indexed byte rather than RGB.
    // colorArray[0] = 254 (light gray / highlight)
    // colorArray[3] = 0   (black)
    private const val COLOR_BLACK = 0
  }

  // Lazy-cached service binder. Null-safe against devices that
  // don't expose the service at all.
  private var cachedBinder: IBinder? = null
  private var started: Boolean = false

  init {
    // Safety: if the app crashed or was force-killed while a
    // drawing session was active, the kernel handwrite service
    // may still be in "writable" mode, causing strokes to
    // appear on every screen the user touches. Unconditionally
    // send the DISABLE_WRITABLE sentinel on module construction
    // to clear any stale state. This is cheap (one binder
    // transact) and a no-op if no session was active.
    try {
      val b = getBinder()
      if (b != null) {
        Log.e(TAG, "init: clearing stale handwrite session")
        val data = Parcel.obtain()
        val reply = Parcel.obtain()
        try {
          data.writeInterfaceToken(INTERFACE_TOKEN)
          data.writeString(APP_NAME)
          data.writeInt(1) // rect count
          data.writeInt(0)
          data.writeInt(0)
          data.writeInt(19999)
          data.writeInt(19999)
          data.writeInt(0)
          b.transact(TRANSACT_DISABLE_AREA_INFO, data, reply, 0)
        } finally {
          data.recycle()
          reply.recycle()
        }
      }
    } catch (t: Throwable) {
      Log.e(TAG, "init: stale session clear failed: ${t.message}")
    }
  }

  private fun getBinder(): IBinder? {
    cachedBinder?.let { if (it.isBinderAlive) return it }
    return try {
      val cls = Class.forName("android.os.ServiceManager")
      val m = cls.getMethod("getService", String::class.java)
      val b = m.invoke(null, SERVICE_NAME) as? IBinder
      cachedBinder = b
      if (b == null) Log.e(TAG, "getService($SERVICE_NAME) returned null")
      b
    } catch (t: Throwable) {
      Log.e(TAG, "getService($SERVICE_NAME) threw: ${t.message}")
      null
    }
  }

  private fun transact(
      label: String,
      code: Int,
      build: (Parcel) -> Unit,
  ): Boolean {
    val binder = getBinder() ?: run {
      Log.e(TAG, "[$label] no binder")
      return false
    }
    val data = Parcel.obtain()
    val reply = Parcel.obtain()
    return try {
      data.writeInterfaceToken(INTERFACE_TOKEN)
      build(data)
      val ok = binder.transact(code, data, reply, 0)
      if (!ok) Log.e(TAG, "[$label] transact returned false")
      ok
    } catch (t: Throwable) {
      Log.e(TAG, "[$label] threw: ${t.message}")
      false
    } finally {
      data.recycle()
      reply.recycle()
    }
  }

  // ─── Low-level transactions mirroring Atelier's HandWriteClient ──

  /** WRITE_APP_INFO — register our app name with the service. */
  private fun writeAppInfo(mode: Int, state: Int): Boolean =
      transact("WRITE_APP_INFO", TRANSACT_WRITE_APP_INFO) { p ->
        p.writeString(APP_NAME)
        p.writeInt(mode)
        p.writeInt(state)
      }

  /**
   * DISABLE_AREA_INFO — declares a list of rects where the kernel
   * may draw. Used two ways by the vendor code:
   *
   *   • With the magic `RECT_WRITE_ENABLED` to turn writing on,
   *     and `RECT_WRITE_DISABLED` to turn it off. These are
   *     sentinel values the service recognizes.
   *   • With real pixel rects to mark UI regions where the
   *     kernel should NOT draw (toolbars, status bar, etc).
   */
  private fun sendRectList(label: String, rects: List<Rect>): Boolean =
      transact(label, TRANSACT_DISABLE_AREA_INFO) { p ->
        p.writeString(APP_NAME)
        p.writeInt(rects.size)
        for (r in rects) {
          p.writeInt(r.left)
          p.writeInt(r.top)
          p.writeInt(r.width())
          p.writeInt(r.height())
          p.writeInt(0)
        }
      }

  /** PEN_INFO — tell the kernel what the pen looks like. */
  private fun sendPenInfo(penType: Int, size: Int, color: Int): Boolean =
      transact("PEN_INFO", TRANSACT_PEN_INFO) { p ->
        p.writeString(APP_NAME)
        p.writeInt(penType)
        p.writeInt(size)
        p.writeInt(color)
      }

  /** SHIFT_INFO — scroll offset so strokes track app content. */
  private fun sendShiftInfo(dx: Int, dy: Int): Boolean =
      transact("SHIFT_INFO", TRANSACT_SHIFT_INFO) { p ->
        p.writeString(APP_NAME)
        p.writeInt(dx)
        p.writeInt(dy)
      }

  // ─── Eink manager auto-full-refresh gate ──────────────────────
  //
  // We also need to disable the eink service's automatic GC16
  // promotion while writing — without this, the service will
  // decide any frame with AA pixels needs a full refresh and
  // fight our kernel-drawn strokes.

  private fun setAutoFull(enable: Boolean): Boolean {
    return try {
      val svc = reactApplicationContext.getSystemService("eink") ?: return false
      val m = svc.javaClass.getMethod("enableFullUiAuto", java.lang.Boolean.TYPE)
      m.invoke(svc, enable)
      true
    } catch (t: Throwable) {
      Log.e(TAG, "enableFullUiAuto($enable) failed: ${t.message}")
      false
    }
  }

  private fun screenRefresh(): Boolean {
    return try {
      val svc = reactApplicationContext.getSystemService("eink") ?: return false
      val m = svc.javaClass.getMethod(
          "screenRefresh",
          java.lang.Boolean.TYPE,
          java.lang.Integer.TYPE,
      )
      m.invoke(svc, false, 1)
      true
    } catch (t: Throwable) {
      Log.e(TAG, "screenRefresh failed: ${t.message}")
      false
    }
  }

  // ─── React Native bridge ──────────────────────────────────────

  /**
   * Start a handwriting session.
   *
   * @param penTypeIdx    0 = needle point, 1 = ball pen
   * @param penSizeIdx    index into PEN_SIZE_TABLE (0..10)
   * @param disableRects  list of pixel rects (left, top, right,
   *                      bottom, flat x4) where the kernel must
   *                      NOT draw — e.g. the toolbar and the
   *                      header of the modal card. Passing an
   *                      empty list means "draw anywhere".
   */
  @ReactMethod
  fun start(
      @Suppress("UNUSED_PARAMETER") penTypeIdx: Int,
      penSizeIdx: Int,
      disableRects: ReadableArray,
      promise: Promise,
  ) {
    Log.e(TAG, "start(size=$penSizeIdx, rects=${disableRects.size() / 4})")

    // Gate off the auto-full-refresh behavior in the eink
    // service — the service would otherwise periodically force
    // a GC16 refresh of anything with antialiased pixels, which
    // would fight our strokes.
    setAutoFull(false)

    // 1. Register our app with the service.
    writeAppInfo(1, 0)

    // 2. Configure the pen. We always use FIXED_CIRCLR_PEN —
    //    BALL_PEN would introduce pressure-based width changes
    //    that don't match our uniform-width Skia background.
    val size =
        if (penSizeIdx in PEN_SIZE_TABLE.indices) PEN_SIZE_TABLE[penSizeIdx]
        else PEN_SIZE_TABLE[1]
    sendPenInfo(PEN_TYPE_BALL_PEN, size, COLOR_BLACK)

    // 3. Zero scroll offset — our drawing modal is not a
    // scrolling surface.
    sendShiftInfo(0, 0)

    // 4. Forbid the kernel from drawing outside the canvas area.
    // disableRects arrives as [l0,t0,r0,b0, l1,t1,r1,b1, ...].
    val rects = mutableListOf<Rect>()
    val n = disableRects.size()
    var i = 0
    while (i + 3 < n) {
      rects.add(
          Rect(
              disableRects.getInt(i),
              disableRects.getInt(i + 1),
              disableRects.getInt(i + 2),
              disableRects.getInt(i + 3),
          ),
      )
      i += 4
    }
    if (rects.isNotEmpty()) {
      sendRectList("DISABLE_AREA", rects)
    }

    // 5. Finally, globally enable writing via the magic
    // 18888×18888 sentinel. Must come AFTER the disable rects
    // or the service applies them to the wrong session.
    sendRectList("ENABLE_WRITABLE", listOf(RECT_WRITE_ENABLED))

    started = true
    promise.resolve(true)
  }

  /** Change pen size mid-session. Pen type stays at
   *  FIXED_CIRCLR_PEN so the kernel rendering matches Skia. */
  @ReactMethod
  fun setPen(
      @Suppress("UNUSED_PARAMETER") penTypeIdx: Int,
      penSizeIdx: Int,
      promise: Promise,
  ) {
    Log.e(TAG, "setPen(size=$penSizeIdx)")
    val size =
        if (penSizeIdx in PEN_SIZE_TABLE.indices) PEN_SIZE_TABLE[penSizeIdx]
        else PEN_SIZE_TABLE[1]
    sendPenInfo(PEN_TYPE_BALL_PEN, size, COLOR_BLACK)
    promise.resolve(true)
  }

  /**
   * Switch to eraser mode. Uses FIXED_CIRCLR_PEN (type 10) with
   * color 255 (white) so the eraser has uniform, consistent
   * width with no pressure variation. Size is passed as a raw
   * kernel value (not an index) so the JS side has full control.
   */
  @ReactMethod
  fun setEraser(rawSize: Int, promise: Promise) {
    Log.e(TAG, "setEraser(rawSize=$rawSize)")
    sendPenInfo(10, rawSize, 255) // 10 = FIXED_CIRCLR_PEN
    promise.resolve(true)
  }

  /**
   * End a handwriting session. Reverses start() in the right
   * order: disable writing first, let the kernel drain any
   * pending strokes, then re-enable auto-full and flush.
   */
  @ReactMethod
  fun stop(promise: Promise) {
    Log.e(TAG, "stop()")
    if (!started) {
      promise.resolve(false)
      return
    }
    sendRectList("DISABLE_WRITABLE", listOf(RECT_WRITE_DISABLED))
    setAutoFull(true)
    screenRefresh()
    started = false
    promise.resolve(true)
  }

  /**
   * Request a full-panel GC16 flush. Destructive — every pixel
   * blinks white. Only use as an escape hatch. Normal erase /
   * undo / clear should use syncBackground() instead, which
   * doesn't touch the whole panel.
   */
  @ReactMethod
  fun fullRefresh(promise: Promise) {
    Log.e(TAG, "fullRefresh()")
    screenRefresh()
    promise.resolve(true)
  }

  /**
   * SYNC_BACKGROUND_MAYBE_LOSS_PARTIAL_TRAIL (transact 6) — tell
   * the kernel handwrite driver to drop its cached stroke trail
   * buffer and re-read the background from our window surface
   * on its next composite. This is how Ratta Notes implements
   * erase / undo / redo without flashing the panel: the app
   * updates its own Skia content (the strokes disappear), then
   * fires this call, and the kernel simply stops re-drawing the
   * stale strokes over the new background. No GC16 flush.
   *
   * NotePresenter calls this after onUndoRedoClick sets
   * isNeedSyncBuff=true and the next layer-load completes. We
   * just call it unconditionally from JS after React state
   * updates — simpler, same effect.
   *
   * Parcel shape (from SupernoteNote's
   * sendSyncBackgroundBuffMayBeLostTrail):
   *   writeString(app_name)
   *   writeInt(255)
   *   writeInt(deviceType == 4 ? 1 : 0)  // A6X2 / Nomad is
   *                                       // type 3, so 0
   */
  @ReactMethod
  fun syncBackground(promise: Promise) {
    Log.e(TAG, "syncBackground()")
    val ok = transact("SYNC_BACKGROUND", TRANSACT_SYNC_BACKGROUND) { p ->
      p.writeString(APP_NAME)
      p.writeInt(255)
      p.writeInt(0)
    }
    promise.resolve(ok)
  }

  /**
   * Capture a screenshot of a screen region and return it as a
   * base64-encoded PNG data URI. Uses the system `screencap`
   * binary which reads the display framebuffer — this includes
   * the kernel handwrite trail, not just the Android surface.
   *
   * Coordinates are in dp — we convert to pixels internally.
   */
  @ReactMethod
  fun captureCanvas(
      left: Double,
      top: Double,
      width: Double,
      height: Double,
      promise: Promise,
  ) {
    Thread {
      try {
        val density = reactApplicationContext.resources.displayMetrics.density
        val pxL = (left * density).toInt()
        val pxT = (top * density).toInt()
        val pxW = (width * density).toInt()
        val pxH = (height * density).toInt()
        Log.e(TAG, "captureCanvas: px=$pxL,$pxT ${pxW}x${pxH}")

        // Run screencap which captures the full display
        // framebuffer including kernel-drawn strokes.
        val process = Runtime.getRuntime().exec("screencap -p")
        val fullPng = process.inputStream.readBytes()
        process.waitFor()
        if (fullPng.isEmpty()) {
          Log.e(TAG, "captureCanvas: screencap returned empty")
          promise.resolve(null)
          return@Thread
        }

        // Decode, crop to canvas region, re-encode.
        val full = android.graphics.BitmapFactory.decodeByteArray(
            fullPng, 0, fullPng.size,
        )
        if (full == null) {
          Log.e(TAG, "captureCanvas: failed to decode screencap")
          promise.resolve(null)
          return@Thread
        }

        // Clamp crop rect to bitmap bounds.
        val cropL = pxL.coerceIn(0, full.width - 1)
        val cropT = pxT.coerceIn(0, full.height - 1)
        val cropW = pxW.coerceAtMost(full.width - cropL)
        val cropH = pxH.coerceAtMost(full.height - cropT)

        val cropped = Bitmap.createBitmap(full, cropL, cropT, cropW, cropH)
        full.recycle()

        val baos = ByteArrayOutputStream()
        cropped.compress(Bitmap.CompressFormat.PNG, 100, baos)
        cropped.recycle()

        val b64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP)
        promise.resolve("data:image/png;base64,$b64")
      } catch (t: Throwable) {
        Log.e(TAG, "captureCanvas threw: ${t.message}")
        promise.resolve(null)
      }
    }.start()
  }
}
