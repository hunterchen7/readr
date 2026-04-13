package com.readr.app

import android.content.Context
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.widget.FrameLayout

/**
 * FrameLayout that drops pure-finger touch events before they reach
 * its children. Strokes from the Wacom EMR digitizer are tagged
 * `TOOL_TYPE_STYLUS` by Android's InputReader and pass through; any
 * MotionEvent whose pointers are all `TOOL_TYPE_FINGER` is
 * swallowed at dispatchTouchEvent, so react-native-gesture-handler
 * and Skia never see palm contacts at all.
 *
 * Why at this level rather than filtering inside the gesture
 * worklet: RNGH has no "stylus-only" activation filter. Its
 * `.onBegin` runs *after* the gesture has already claimed the
 * touch stream, so palm-first contention (palm lands → pen lands
 * microseconds later) produces race conditions. Dropping the
 * event at `dispatchTouchEvent` — the root of the Android touch
 * pipeline for this view tree — sidesteps that entirely.
 *
 * Temporal "pen priority" lockout (PEN_PRIORITY_MS): after any
 * stylus event, ignore finger events for a short window. This
 * matches the behavior of Samsung Notes / GoodNotes and handles
 * the common case where a palm is resting on the screen while
 * the user writes — by the time the kernel reports the palm,
 * the pen has already been detected and the lockout suppresses
 * stray finger samples.
 *
 * Controlled by the `stylusOnly` prop from JS. When false, the
 * view is a plain FrameLayout — useful for other gesture surfaces
 * where we still want finger input.
 */
class StylusOnlyView(context: Context) : FrameLayout(context) {
  init {
    isHorizontalScrollBarEnabled = false
    isVerticalScrollBarEnabled = false
    clipChildren = true
    clipToPadding = true
  }
  var stylusOnly: Boolean = false
  private var lastStylusAt: Long = 0L
  // Track the pointer ID of a confirmed pen stroke. Once we
  // accept a pointer as "real pen", we let it through for the
  // entire gesture. Pointers that fail the palm check on
  // ACTION_DOWN are rejected for their entire lifetime.
  private val rejectedPointers = mutableSetOf<Int>()

  companion object {
    private const val TAG = "StylusOnly"
    private const val PEN_PRIORITY_MS = 500L
    // Touch major axis threshold — a real Supernote pen tip
    // reports touchMajor around 0. Palms misclassified as
    // stylus report much higher values. If touchMajor > 0
    // and > this threshold, it's a palm.
    private const val PALM_TOUCH_MAJOR_THRESHOLD = 15f
  }

  /**
   * Check if a stylus-tagged pointer is actually a palm based
   * on touch geometry. The Wacom EMR pen has zero touch area
   * (it's inductive, not capacitive), so any stylus event with
   * a large touchMajor is almost certainly a misclassified palm
   * from the capacitive touch layer.
   */
  private fun isPalmLike(ev: MotionEvent, pointerIdx: Int): Boolean {
    val major = ev.getTouchMajor(pointerIdx)
    // touchMajor == 0 means the driver didn't report it (EMR
    // pen path) — definitely not a palm.
    if (major == 0f) return false
    return major > PALM_TOUCH_MAJOR_THRESHOLD
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (!stylusOnly) return super.dispatchTouchEvent(ev)

    val action = ev.actionMasked

    // Clean up rejected set on gesture end.
    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
      rejectedPointers.clear()
    }

    // Detect tool types across all pointers.
    var hasStylus = false
    var hasFinger = false
    for (i in 0 until ev.pointerCount) {
      when (ev.getToolType(i)) {
        MotionEvent.TOOL_TYPE_STYLUS,
        MotionEvent.TOOL_TYPE_ERASER -> hasStylus = true
        MotionEvent.TOOL_TYPE_FINGER -> hasFinger = true
      }
    }

    if (!hasStylus) return true // pure finger → drop

    lastStylusAt = SystemClock.uptimeMillis()

    // On pointer down, check if this new pointer is palm-like.
    if (action == MotionEvent.ACTION_DOWN ||
        action == MotionEvent.ACTION_POINTER_DOWN) {
      val idx = ev.actionIndex
      val toolType = ev.getToolType(idx)
      if (toolType == MotionEvent.TOOL_TYPE_STYLUS ||
          toolType == MotionEvent.TOOL_TYPE_ERASER) {
        if (isPalmLike(ev, idx)) {
          val pid = ev.getPointerId(idx)
          Log.e(TAG, "rejected palm pointer $pid touchMajor=${ev.getTouchMajor(idx)}")
          rejectedPointers.add(pid)
          return true
        }
      }
    }

    // Check if the action's pointer was rejected.
    val actionPid = ev.getPointerId(ev.actionIndex)
    if (actionPid in rejectedPointers) return true

    // Multi-pointer: drop finger pointer sub-events.
    if (hasFinger && ev.pointerCount > 1) {
      val actionToolType = ev.getToolType(ev.actionIndex)
      if (actionToolType == MotionEvent.TOOL_TYPE_FINGER) {
        return true
      }
    }

    return super.dispatchTouchEvent(ev)
  }
}
