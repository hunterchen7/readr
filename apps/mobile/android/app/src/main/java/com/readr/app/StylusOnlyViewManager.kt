package com.readr.app

import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewGroupManager
import com.facebook.react.uimanager.annotations.ReactProp

/**
 * ViewGroupManager (NOT SimpleViewManager — Fabric throws
 * ClassCastException when SurfaceMountingManager tries to add
 * children to a SimpleViewManager-managed view) exposing
 * StylusOnlyView to React Native.
 *
 * The `stylusOnly` prop toggles the interceptor at runtime so the
 * same native view can be used in both "writing mode" (stylus only)
 * and normal touch mode without remounting.
 */
@ReactModule(name = StylusOnlyViewManager.NAME)
class StylusOnlyViewManager : ViewGroupManager<StylusOnlyView>() {
  override fun getName(): String = NAME

  override fun createViewInstance(context: ThemedReactContext): StylusOnlyView =
      StylusOnlyView(context)

  @ReactProp(name = "stylusOnly", defaultBoolean = false)
  fun setStylusOnly(view: StylusOnlyView, value: Boolean) {
    view.stylusOnly = value
  }

  companion object {
    const val NAME = "RCTStylusOnlyView"
  }
}
