/**
 * Which platform the app is running on.
 *
 * Read from the webview's user agent rather than the OS plugin: it needs no
 * extra dependency, no capability grant, and the only question being asked is
 * "is this a phone", which the user agent answers reliably enough.
 *
 * Used to hide affordances that cannot work rather than to let them fail. A
 * button that opens a folder picker Android does not have is worse than no
 * button, because it looks like something that should work.
 */
const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;

export const isAndroid = /android/i.test(ua);
export const isIOS = /iphone|ipad|ipod/i.test(ua);

/** True on a touch device with one window and no file system to browse. */
export const isMobile = isAndroid || isIOS;

/**
 * Whether the user can point the app at an arbitrary folder.
 *
 * Android sandboxes app storage; reaching outside it needs the document picker
 * and permissions this app does not ask for. The library lives in the app's own
 * directory there, and moving it is not offered.
 */
export const canPickFolders = !isMobile;

/**
 * Whether a second window can be opened to render a page.
 *
 * The harvest flow needs one. Android has a single webview, so pages that build
 * themselves in JavaScript can only be reached by reading their markup.
 */
export const canRenderPages = !isMobile;

/** Whether there is a secure store for a mail password. See `send.rs`. */
export const canSendToDevice = !isMobile;

/** Whether a file manager exists to reveal a built volume in. */
export const canRevealFiles = !isMobile;
