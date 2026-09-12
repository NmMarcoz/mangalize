package dev.mangalize.app

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class ShareArgs {
  lateinit var path: String
  var title: String? = null
}

/**
 * Handing a built volume to another app.
 *
 * This is what "export" means on Android. A phone has no file manager the app
 * can drop a volume into and no Send to Kindle to mail it with, and the export
 * directory lives under `Android/data`, which recent Android versions hide from
 * the file pickers most apps show. The share sheet is the one route out: the
 * user picks Drive, or mail, or Save to Files, and the file goes there.
 *
 * The URI is a `content://` one from the FileProvider already declared in the
 * manifest. Handing out a `file://` path instead throws `FileUriExposedException`
 * on anything since Android 7.
 */
@TauriPlugin
class SharePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun shareFile(invoke: Invoke) {
    val args = invoke.parseArgs(ShareArgs::class.java)

    val file = File(args.path)
    if (!file.isFile) {
      invoke.reject("no file at ${args.path}")
      return
    }

    val uri = try {
      FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
    } catch (e: IllegalArgumentException) {
      // Thrown when the path is outside every <paths> entry in file_paths.xml,
      // which is a packaging mistake rather than anything the user did.
      invoke.reject("${file.parent} is not a shareable directory: ${e.message}")
      return
    }

    val label = args.title ?: file.name
    val send = Intent(Intent.ACTION_SEND).apply {
      // MimeTypeMap knows neither extension, and the receiving app picks what
      // it offers from this, so a wrong type here is a missing Kindle entry.
      type = when (file.extension.lowercase()) {
        "epub" -> "application/epub+zip"
        "cbz" -> "application/vnd.comicbook+zip"
        else -> "application/octet-stream"
      }
      putExtra(Intent.EXTRA_STREAM, uri)
      putExtra(Intent.EXTRA_TITLE, label)
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    activity.startActivity(Intent.createChooser(send, label))
    invoke.resolve()
  }
}
