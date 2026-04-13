package com.readr.app

import android.content.Context
import android.os.IBinder
import android.os.Parcel
import android.util.Log
import android.view.View
import android.view.ViewGroup
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.lang.reflect.Method

/**
 * Supernote / Rockchip EPD control via reflection.
 *
 * Discovered by reverse-engineering /system/framework/libeinkpwcoreapi.jar
 * and the official Atelier / Ratta Notes APKs. On a Supernote Nomad
 * (rk3566_ht_eink, Chauvet / Android 11) the vendor exposes:
 *
 *   1. android.os.EinkManager  — a system service registered as
 *      Context.getSystemService("eink"). Atelier's
 *      com.ratta.paint.ReflectUtilities.setEinkManager is a
 *      generic bridge to it. Known methods:
 *          screenRefresh(boolean afterWindowHide, int reserved)
 *          sendHwcCmd(int cmd, int[] param)
 *          setScreenRotation(int rotation)
 *      enableFullUiAuto(boolean) and enableFullUiAuto(boolean,
 *      boolean) are also called by Atelier/Notes — not in the
 *      libeinkpwcoreapi interface stub but present on the live
 *      service instance, so we call via reflection on the
 *      returned object.
 *
 *   2. android.view.View.setEinkUpdateMode(int dataMode, int dispMode)
 *      — the per-view Rockchip waveform hook. This is the API the
 *      research agent was trying to find under the wrong name
 *      `requestEpdMode`. Setting both params picks a specific
 *      mxcfb waveform for the view's dirty rects.
 *
 *   3. android.view.SFCommand.screenRefresh() — a static framework
 *      method that directly invokes a SurfaceFlinger command to
 *      force a full refresh. Atelier falls back to this from
 *      ReflectUtilities.screenRefresh().
 *
 * Strategy: on canvas mount we call both #1 and #2 to pin the
 * panel into a fast waveform. On unmount and on destructive ops
 * (erase/clear/undo) we call the full-refresh path to clear
 * ghost residue. All reflection is cached and silently no-ops
 * on devices without the targets (emulator, OnePlus, A5X).
 */
class EpdModeModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

  init {
    Log.e(TAG, "EpdModeModule constructed (diag)")
  }

  override fun getName(): String = "EpdMode"

  companion object {
    private const val TAG = "EpdMode"

    // Rockchip EBC waveform enum — from
    // drivers/gpu/drm/rockchip/ebc-dev/ebc_dev.h in the
    // Supernote-Ratta/kernel_Nomad_Manta repo. These integer
    // values are the exact panel_refresh_mode constants shipped
    // on this device. The previous build passed (2, 1) which
    // mapped to EPD_FULL_GC16 — the slow, ghosty mode. EPD_A2
    // is what Atelier / Ratta Notes use for their drawing
    // canvases (1-bit animation waveform, ~120ms, no ghosting).
    const val EPD_AUTO = 0
    const val EPD_FULL_GC16 = 2
    const val EPD_PART_GC16 = 7
    const val EPD_A2 = 12
    const val EPD_DU = 14
    const val EPD_FORCE_FULL = 21
  }

  // ─── Cached reflection lookups ────────────────────────────────
  //
  // These are all `by lazy` so resolution happens on first call
  // and the result is cached. Each wraps a NoSuchMethodException
  // / ClassNotFoundException / SecurityException into a null,
  // which the call site treats as "not supported on this device".

  private val einkServiceObj: Any? by lazy {
    try {
      val ctx: Context = reactApplicationContext
      val svc = ctx.getSystemService("eink")
      if (svc == null) {
        Log.e(TAG, "getSystemService(\"eink\") returned null")
      } else {
        Log.e(TAG, "eink service class=${svc.javaClass.name}")
      }
      svc
    } catch (t: Throwable) {
      Log.e(TAG, "getSystemService(eink) threw: ${t.message}")
      null
    }
  }

  private val screenRefreshMethod: Method? by lazy {
    val svc = einkServiceObj ?: return@lazy null
    try {
      val m = svc.javaClass.getMethod(
          "screenRefresh",
          java.lang.Boolean.TYPE,
          java.lang.Integer.TYPE,
      )
      Log.e(TAG, "resolved EinkManager.screenRefresh(boolean, int)")
      m
    } catch (t: Throwable) {
      Log.e(TAG, "EinkManager.screenRefresh not resolvable: ${t.message}")
      null
    }
  }

  private val sendHwcCmdMethod: Method? by lazy {
    val svc = einkServiceObj ?: return@lazy null
    try {
      val m = svc.javaClass.getMethod(
          "sendHwcCmd",
          java.lang.Integer.TYPE,
          IntArray::class.java,
      )
      Log.e(TAG, "resolved EinkManager.sendHwcCmd(int, int[])")
      m
    } catch (t: Throwable) {
      Log.e(TAG, "EinkManager.sendHwcCmd not resolvable: ${t.message}")
      null
    }
  }

  private val enableFullUiAuto1Method: Method? by lazy {
    val svc = einkServiceObj ?: return@lazy null
    try {
      val m = svc.javaClass.getMethod(
          "enableFullUiAuto",
          java.lang.Boolean.TYPE,
      )
      Log.e(TAG, "resolved EinkManager.enableFullUiAuto(boolean)")
      m
    } catch (t: Throwable) {
      null
    }
  }

  private val enableFullUiAuto2Method: Method? by lazy {
    val svc = einkServiceObj ?: return@lazy null
    try {
      val m = svc.javaClass.getMethod(
          "enableFullUiAuto",
          java.lang.Boolean.TYPE,
          java.lang.Boolean.TYPE,
      )
      Log.e(TAG, "resolved EinkManager.enableFullUiAuto(boolean, boolean)")
      m
    } catch (t: Throwable) {
      null
    }
  }

  // View.setEinkUpdateMode(int dataMode, int dispMode) — the
  // per-view Rockchip waveform hook.
  private val setEinkUpdateModeMethod: Method? by lazy {
    try {
      val m = View::class.java.getMethod(
          "setEinkUpdateMode",
          java.lang.Integer.TYPE,
          java.lang.Integer.TYPE,
      )
      Log.e(TAG, "resolved View.setEinkUpdateMode(int, int)")
      m
    } catch (t: Throwable) {
      Log.e(TAG, "View.setEinkUpdateMode not resolvable: ${t.message}")
      null
    }
  }

  // View.invalidate(int left, int top, int right, int bottom,
  // int waveform) — the Rockchip-extended 5-arg invalidate
  // that Supernote Note's NoteInsidePagesActivity.autoRefresh
  // Invalidate calls with waveform=10 to do a partial refresh
  // with an explicit waveform hint. Found via:
  //   View.class.getDeclaredMethod("invalidate",
  //     Integer.TYPE × 5).invoke(noteTipContainer,
  //     rect.left, rect.top, rect.right, rect.bottom, 10)
  // On devices without the extension this resolves to null and
  // the reflection falls back to the standard 4-arg invalidate.
  private val invalidate5ArgMethod: Method? by lazy {
    try {
      val m = View::class.java.getDeclaredMethod(
          "invalidate",
          java.lang.Integer.TYPE,
          java.lang.Integer.TYPE,
          java.lang.Integer.TYPE,
          java.lang.Integer.TYPE,
          java.lang.Integer.TYPE,
      )
      Log.e(TAG, "resolved View.invalidate(int×5) with waveform hint")
      m
    } catch (t: Throwable) {
      Log.e(TAG, "View.invalidate(int×5) not resolvable: ${t.message}")
      null
    }
  }

  // android.view.SFCommand.screenRefresh() — static, no args.
  // Atelier and Ratta Notes both call this as a fallback when
  // the EinkManager path isn't available.
  private val sfCommandScreenRefreshMethod: Method? by lazy {
    try {
      val cls = Class.forName("android.view.SFCommand")
      val m = cls.getDeclaredMethod("screenRefresh")
      Log.e(TAG, "resolved SFCommand.screenRefresh()")
      m
    } catch (t: Throwable) {
      Log.e(TAG, "SFCommand.screenRefresh not resolvable: ${t.message}")
      null
    }
  }

  // ─── Private helpers ──────────────────────────────────────────

  private fun decorView(): View? =
      getCurrentActivity()?.window?.decorView

  /**
   * Walk the entire view tree from `root` and apply the given
   * waveform mode to every descendant via reflection. We do this
   * instead of targeting a single view because the Rockchip
   * per-view waveform hint is applied per dirty rect, and in a
   * nested React Native hierarchy we don't know which specific
   * child view is doing the Skia rasterization.
   *
   * Broadcasting the mode to all views is safe — views without
   * dirty rects don't receive updates, and the redundant calls
   * are effectively free (one virtual method dispatch per view).
   */
  private fun applyModeToTree(root: View?, m: Method, dataMode: Int, dispMode: Int): Int {
    if (root == null) return 0
    var count = 0
    try {
      m.invoke(root, dataMode, dispMode)
      count++
    } catch (_: Throwable) {
    }
    if (root is ViewGroup) {
      for (i in 0 until root.childCount) {
        count += applyModeToTree(root.getChildAt(i), m, dataMode, dispMode)
      }
    }
    return count
  }

  private fun invokeEink(m: Method?, vararg args: Any?): Boolean {
    val svc = einkServiceObj ?: return false
    val method = m ?: return false
    return try {
      method.invoke(svc, *args)
      true
    } catch (t: Throwable) {
      Log.e(TAG, "invokeEink ${method.name} threw: ${t.message}")
      false
    }
  }

  // ─── React Native bridge ──────────────────────────────────────

  /**
   * Pin the app onto the fast e-ink update mode used for drawing.
   *
   * We call two APIs in sequence:
   *   1. EinkManager.enableFullUiAuto(false) — tells Chauvet not
   *      to automatically promote our view to a full GC16 refresh
   *      on every frame. Without this, the compositor decides the
   *      waveform for us and picks GC16 for anything with AA.
   *   2. View.setEinkUpdateMode(dataMode=2, dispMode=1) on the
   *      decor view — the per-view hint. Mode 2/1 maps to the
   *      1-bit A2/DU combo Ratta Notes uses for handwriting
   *      regions. Experimentally determined from Atelier's
   *      postRectForPw calls.
   */
  @ReactMethod
  fun setA2(promise: Promise) {
    Log.e(TAG, "setA2() called from JS")
    var any = false

    // Disable auto-full-refresh for the drawing session.
    if (invokeEink(enableFullUiAuto1Method, false)) {
      Log.e(TAG, "setA2: enableFullUiAuto(false) ok")
      any = true
    }

    // Per-view waveform mode. The method signature is
    //   setEinkUpdateMode(int dataMode, int dispMode)
    // Broadcasting A2 mode to every view in the activity's tree
    // instead of just the decor view: the Rockchip per-view hint
    // is applied at dirty-rect time, and in a nested React
    // Native hierarchy the Skia canvas that does the actual
    // rasterization is deep in the tree — setting A2 on just
    // the decor view leaves the intermediate RN ViewGroups
    // (which the HWC sees as separate surfaces) in AUTO mode.
    val m = setEinkUpdateModeMethod
    if (m != null) {
      val count = applyModeToTree(decorView(), m, EPD_A2, EPD_A2)
      Log.e(TAG, "setA2: applied A2=$EPD_A2 to $count views")
      if (count > 0) any = true
    }

    promise.resolve(any)
  }

  /**
   * Release the fast-mode override and restore default automatic
   * UI refresh handling. Called on canvas unmount so the reader
   * screen behind it gets proper GC16 text rendering.
   */
  @ReactMethod
  fun reset(promise: Promise) {
    Log.e(TAG, "reset() called from JS")
    var any = false
    if (invokeEink(enableFullUiAuto1Method, true)) {
      Log.e(TAG, "reset: enableFullUiAuto(true) ok")
      any = true
    }
    val m = setEinkUpdateModeMethod
    if (m != null) {
      // Put the whole tree back into AUTO so the reader screen
      // gets GC16 text again.
      val count = applyModeToTree(decorView(), m, EPD_AUTO, EPD_AUTO)
      if (count > 0) any = true
    }
    promise.resolve(any)
  }

  /**
   * Request a full screen refresh — the proper way to clear
   * ghost residue. Calls EinkManager.screenRefresh(false, 1)
   * first (matching Atelier's DeviceTypeHelper) and falls back
   * to SFCommand.screenRefresh() if that's not available.
   */
  @ReactMethod
  fun setFull(promise: Promise) {
    Log.e(TAG, "setFull() called from JS")
    if (invokeEink(screenRefreshMethod, false, 1)) {
      Log.e(TAG, "setFull: EinkManager.screenRefresh(false, 1) ok")
      promise.resolve(true)
      return
    }
    // SFCommand fallback.
    val m = sfCommandScreenRefreshMethod
    if (m != null) {
      try {
        m.invoke(null)
        Log.e(TAG, "setFull: SFCommand.screenRefresh() ok")
        promise.resolve(true)
        return
      } catch (t: Throwable) {
        Log.e(TAG, "SFCommand.screenRefresh threw: ${t.message}")
      }
    }
    promise.resolve(false)
  }

  /** Legacy alias kept so JS code using setPart keeps working. */
  @ReactMethod
  fun setPart(promise: Promise) {
    setFull(promise)
  }

  /**
   * Rockchip partial-refresh invalidate with explicit waveform
   * hint. Walks the view tree from the decor view looking for
   * a view big enough to contain the requested rect and calls
   * `invalidate(left, top, right, bottom, waveform)` on it.
   *
   * This is Supernote Note's autoRefreshInvalidate path — a
   * per-rect partial refresh that picks a specific waveform
   * instead of letting the eink service auto-choose. Waveform
   * 10 (their "clean partial") tends to leave less residue
   * than the default DU waveform.
   *
   * Returns false if the 5-arg extension isn't available on
   * this device (falls back to plain invalidate on the decor
   * view, which still forces a frame but without the hint).
   */
  @ReactMethod
  fun invalidateRect(
      left: Int,
      top: Int,
      right: Int,
      bottom: Int,
      waveform: Int,
      promise: Promise,
  ) {
    Log.e(TAG, "invalidateRect($left,$top,$right,$bottom, wf=$waveform)")
    val root = decorView()
    if (root == null) {
      promise.resolve(false)
      return
    }
    val m = invalidate5ArgMethod
    if (m != null) {
      try {
        m.invoke(root, left, top, right, bottom, waveform)
        promise.resolve(true)
        return
      } catch (t: Throwable) {
        Log.e(TAG, "invalidate(int×5) threw: ${t.message}")
      }
    }
    // Fallback: plain invalidate of the rect. No waveform hint.
    try {
      root.postInvalidate(left, top, right, bottom)
      promise.resolve(true)
    } catch (t: Throwable) {
      promise.resolve(false)
    }
  }

  // ─── Handwriting service probe ────────────────────────────────
  //
  // Runs a deliberate sequence of binder transactions against
  // `service_myservice` / `android.demo.IMyService` — the vendor
  // binder service that Atelier and Supernote Notes use to drive
  // the kernel handwriting path. Every call is wrapped to isolate
  // failures so we can tell the difference between:
  //
  //   A) ServiceManager.getService threw / returned null
  //      → reflection or SELinux blocked at the service-locator
  //      level, and the whole approach is dead for us
  //   B) getService ok, transact throws SecurityException
  //      → SELinux allows the service-locator but blocks binder
  //      transacts from untrusted_app; same outcome
  //   C) transact returns false / throws RemoteException
  //      → binder reached the service but the service rejected
  //      the call (wrong parcel shape, wrong app name, caller
  //      check) — we can still fix this by matching Atelier's
  //      parcel format byte-for-byte
  //   D) transact returns true for all
  //      → we're unblocked, architecture change is viable
  //
  // Everything is logged verbosely with TAG=HandwriteProbe so
  // it's easy to grep in logcat.

  private val probeTag = "HandwriteProbe"

  /**
   * Resolve the myservice binder via reflection. Returns null on
   * any failure path (class not found, method not found, invoke
   * threw, service not registered). Logs each failure branch so
   * we can tell them apart.
   */
  private fun getHandwriteBinder(): IBinder? {
    return try {
      val cls = Class.forName("android.os.ServiceManager")
      val m = cls.getMethod("getService", String::class.java)
      val b = m.invoke(null, "service_myservice") as? IBinder
      if (b == null) {
        Log.e(probeTag, "getService returned null")
      } else {
        Log.e(probeTag, "getService ok: $b desc=${runCatching { b.interfaceDescriptor }.getOrNull()}")
      }
      b
    } catch (t: Throwable) {
      Log.e(probeTag, "getService threw", t)
      null
    }
  }

  /**
   * Run a single binder transact with the given code and parcel
   * builder. Captures every possible failure mode as a struct in
   * the returned map so JS / logcat can see exactly which
   * transaction fell over.
   */
  private fun probeTransact(
      binder: IBinder,
      label: String,
      code: Int,
      build: (Parcel) -> Unit,
  ): WritableMap {
    val result = Arguments.createMap()
    result.putString("label", label)
    result.putInt("code", code)
    val data = Parcel.obtain()
    val reply = Parcel.obtain()
    try {
      data.writeInterfaceToken("android.demo.IMyService")
      build(data)
      val ok = binder.transact(code, data, reply, 0)
      result.putBoolean("transactReturn", ok)
      result.putString("status", "ok")
      // Try to read a string reply like Atelier does — may be
      // empty / may fail if the service wrote nothing or wrote a
      // different primitive.
      val replyStr = runCatching { reply.readString() }.getOrNull()
      result.putString("replyString", replyStr ?: "")
      Log.e(
          probeTag,
          "[$label] code=$code transact ok=$ok reply='${replyStr ?: ""}'",
      )
    } catch (se: SecurityException) {
      result.putString("status", "SecurityException")
      result.putString("error", se.message ?: "")
      Log.e(probeTag, "[$label] SecurityException", se)
    } catch (re: android.os.RemoteException) {
      result.putString("status", "RemoteException")
      result.putString("error", re.message ?: "")
      Log.e(probeTag, "[$label] RemoteException", re)
    } catch (t: Throwable) {
      result.putString("status", t.javaClass.simpleName)
      result.putString("error", t.message ?: "")
      Log.e(probeTag, "[$label] threw", t)
    } finally {
      data.recycle()
      reply.recycle()
    }
    return result
  }

  /**
   * Atelier's HandWriteClient constants (A6X / Nomad arm). The
   * penSizeArrayA6X[1] row is BALL_PEN sizes; index 1 = 300.
   * colorArray[3] = 0 (black).
   */
  private val penAppName = "readr"
  private val penTypeBallPen = 1
  private val penWidthSmall = 300
  private val penColorBlack = 0

  @ReactMethod
  fun probeHandwriteService(promise: Promise) {
    Log.e(probeTag, "─── probeHandwriteService starting ───")
    Log.e(probeTag, "myUid=${android.os.Process.myUid()} myPid=${android.os.Process.myPid()}")
    val out = Arguments.createMap()

    val binder = getHandwriteBinder()
    if (binder == null) {
      out.putString("stage", "getService")
      out.putBoolean("ok", false)
      promise.resolve(out)
      return
    }
    out.putString("stage", "getService")
    out.putBoolean("getServiceOk", true)
    out.putString(
        "descriptor",
        runCatching { binder.interfaceDescriptor ?: "" }.getOrNull() ?: "",
    )
    out.putBoolean("binderAlive", runCatching { binder.isBinderAlive }.getOrDefault(false))
    out.putBoolean("pingBinder", runCatching { binder.pingBinder() }.getOrDefault(false))

    val transactions = Arguments.createArray()

    // 0 — WRITE_APP_INFO: register app name, two ints. Atelier
    // calls sendWriteInfo(1, 0) somewhere in its boot sequence.
    transactions.pushMap(
        probeTransact(binder, "WRITE_APP_INFO", 0) { p ->
          p.writeString(penAppName)
          p.writeInt(1)
          p.writeInt(0)
        },
    )

    // 1 — DISABLE_AREA_INFO / sendWritable(true): list-of-rects
    // with the magic 18888×18888 "enable writing" rect.
    transactions.pushMap(
        probeTransact(binder, "ENABLE_WRITABLE", 1) { p ->
          p.writeString(penAppName)
          p.writeInt(1) // rectList.size()
          // one rect: left, top, width, height, trailing-int
          p.writeInt(0)
          p.writeInt(0)
          p.writeInt(18888)
          p.writeInt(18888)
          p.writeInt(0)
        },
    )

    // 2 — PEN_INFO: ball pen, size 300, color 0 (black).
    transactions.pushMap(
        probeTransact(binder, "PEN_INFO", 2) { p ->
          p.writeString(penAppName)
          p.writeInt(penTypeBallPen)
          p.writeInt(penWidthSmall)
          p.writeInt(penColorBlack)
        },
    )

    // 3 — SHIFT_INFO: zero scroll offset.
    transactions.pushMap(
        probeTransact(binder, "SHIFT_INFO", 3) { p ->
          p.writeString(penAppName)
          p.writeInt(0)
          p.writeInt(0)
        },
    )

    // 1 — DISABLE_AREA_INFO / sendWritable(false): undo enable
    // with the magic 19999×19999 sentinel rect.
    transactions.pushMap(
        probeTransact(binder, "DISABLE_WRITABLE", 1) { p ->
          p.writeString(penAppName)
          p.writeInt(1)
          p.writeInt(0)
          p.writeInt(0)
          p.writeInt(19999)
          p.writeInt(19999)
          p.writeInt(0)
        },
    )

    out.putArray("transactions", transactions)
    out.putBoolean("ok", true)
    Log.e(probeTag, "─── probeHandwriteService complete ───")
    promise.resolve(out)
  }
}
