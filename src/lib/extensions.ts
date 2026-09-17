import { invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";

/** Every `.lua` file currently under `<library>/extensions/`. */
export async function listExtensionFiles(): Promise<string[]> {
  return invoke("list_extension_files");
}

/**
 * Read a picked file and install it as an extension.
 *
 * `readTextFile` is what makes this work on Android at all: the document
 * picker there hands back a `content://` URI rather than a real path, and
 * this plugin reads either kind the same way, so the Rust side only ever
 * sees plain text and never needs to know where it came from.
 */
export async function importExtensionFile(path: string): Promise<string> {
  const content = await readTextFile(path);
  const filename = path.split(/[/\\]/).pop() ?? path;
  return invoke("import_extension", { filename, content });
}

/** The installed file's real path, for sharing it back out. */
export async function extensionPath(filename: string): Promise<string> {
  return invoke("extension_path", { filename });
}

/** Uninstall one extension. */
export async function removeExtension(filename: string): Promise<void> {
  await invoke("remove_extension", { filename });
}
