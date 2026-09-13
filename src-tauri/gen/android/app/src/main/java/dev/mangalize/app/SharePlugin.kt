package dev.mangalize.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
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

@InvokeArg
class InstallArgs {
  lateinit var path: String
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

  /**
   * Hand a downloaded APK to Android's package installer.
   *
   * Never silent, and that is the point: the system asks, and it refuses
   * outright unless the new APK is signed with the same key as the installed
   * one. That is the same guarantee the desktop updater gets from checking a
   * signature, except enforced by the OS rather than by us.
   *
   * Installing from outside a store needs the user's permission per app, so a
   * device that has not granted it is sent to the settings screen that grants
   * it rather than being shown a failure.
   */
  @Command
  fun installApk(invoke: Invoke) {
    val args = invoke.parseArgs(InstallArgs::class.java)

    val file = File(args.path)
    if (!file.isFile) {
      invoke.reject("no update at ${args.path}")
      return
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !activity.packageManager.canRequestPackageInstalls()
    ) {
      activity.startActivity(
        Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${activity.packageName}"),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
      )
      invoke.reject(
        "Allow Mangalize to install apps, then tap update again.",
      )
      return
    }

    val uri = FileProvider.getUriForFile(
      activity,
      "${activity.packageName}.fileprovider",
      file,
    )
    activity.startActivity(
      Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      },
    )
    invoke.resolve()
  }
}
