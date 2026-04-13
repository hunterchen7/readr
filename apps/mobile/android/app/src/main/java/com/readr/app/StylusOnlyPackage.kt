package com.readr.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Bundles all readr-specific native modules — the palm-rejection
 * ViewManager and the EpdMode reflection module.
 */
class StylusOnlyPackage : ReactPackage {
  override fun createNativeModules(
      reactContext: ReactApplicationContext,
  ): List<NativeModule> =
      listOf(
          EpdModeModule(reactContext),
          HandwriteServiceModule(reactContext),
      )

  override fun createViewManagers(
      reactContext: ReactApplicationContext,
  ): List<ViewManager<*, *>> = listOf(StylusOnlyViewManager())
}
