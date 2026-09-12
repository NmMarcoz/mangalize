package dev.mangalize.app

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The one Android source file that is ours: everything under `generated/` is
 * rewritten by `tauri android init`, and this is not.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // CSS `env(safe-area-inset-*)` is not the answer here. Android's WebView
    // only ever reports a display cutout through it — never the status bar or
    // the gesture bar — so on a phone without a notch every inset reads zero
    // and the app draws its header under the clock.
    //
    // The insets are only offered to the view hierarchy, so that is where they
    // are taken, by shrinking the window the WebView lives in. The web side
    // then needs to know nothing about any of this.
    // Edge-to-edge leaves the bars transparent over our own background, so the
    // icons drawn on them have to be told they are sitting on a dark one.
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }

    val content = findViewById<View>(android.R.id.content)
    // The strip the padding below opens up shows whatever is behind the content
    // view. Painting it here rather than leaving it to `windowBackground` means
    // it cannot come out white because a theme attribute resolved elsewhere.
    content.setBackgroundColor(ContextCompat.getColor(this, R.color.window_background))
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars: Insets = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      // The keyboard covers the bottom of the window rather than sitting beside
      // the gesture bar, so the larger of the two is the whole of the overlap.
      val ime: Insets = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      insets
    }
  }
}
