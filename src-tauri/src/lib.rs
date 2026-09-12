//! Tauri bindings.
//!
//! Every command is a thin translation between the frontend and one of the
//! library crates; no pipeline logic lives here. The modules split along the
//! same seams the crates do:
//!
//! - [`volume`] — scan a folder, preview it, export it (`mangalize-core`)
//! - [`meta`] — online series lookup (`mangalize-meta`)
//! - [`library`] — the stored collection (`mangalize-library`)
//! - [`fetch`] — pulling a chapter's images off a URL (`mangalize-fetch`)
//! - [`harvest`] — rendering a page to see what images it really loads
//! - [`send`] — mailing a finished volume to a device (`mangalize-send`)

mod fetch;
mod harvest;
mod library;
mod meta;
mod send;
mod settings;
mod thumbs;
mod util;
mod volume;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(fetch::BatchControl::default())
        .manage(library::BuildControl::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            volume::scan,
            volume::thumbnail,
            volume::build,
            volume::suggest_filename,
            volume::resolve_build_path,
            settings::get_settings,
            settings::set_settings,
            settings::suggested_output_root,
            meta::search_series,
            meta::series_covers,
            meta::series_chapters,
            meta::save_cover,
            library::library_root,
            library::set_library_root,
            library::library_series,
            library::library_add_series,
            library::library_sync_series,
            library::library_remove_series,
            library::library_update_series,
            library::library_volumes,
            library::library_download_covers,
            library::library_build_volume,
            library::library_delete_chapter,
            library::build_library_volumes,
            library::cancel_build,
            fetch::extract_chapter,
            fetch::measure_images,
            fetch::preview_image,
            fetch::download_chapter,
            fetch::import_chapter,
            fetch::plan_batch,
            fetch::download_batch,
            fetch::cancel_batch,
            harvest::harvest_images,
            send::send_config,
            send::save_send_config,
            send::send_test_email,
            send::send_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running mangalize");
}
