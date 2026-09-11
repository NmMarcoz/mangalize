//! The editable model the UI binds to and the writers consume.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::page::Page;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    /// Japanese reading order: pages advance right to left.
    #[default]
    RightToLeft,
    LeftToRight,
}

impl Direction {
    /// The EPUB `page-progression-direction` value.
    pub fn epub_ppd(self) -> &'static str {
        match self {
            Direction::RightToLeft => "rtl",
            Direction::LeftToRight => "ltr",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Metadata {
    /// Series title, e.g. "Ichi the Witch".
    pub series: String,
    /// Volume number within the series, if known.
    pub volume: Option<u32>,
    pub author: String,
    pub language: String,
    pub description: String,
    pub direction: Direction,
    /// Stable identifier written into the EPUB package document.
    pub identifier: String,
}

impl Default for Metadata {
    fn default() -> Self {
        Self {
            series: String::new(),
            volume: None,
            author: String::new(),
            language: "en".into(),
            description: String::new(),
            direction: Direction::default(),
            identifier: String::new(),
        }
    }
}

impl Metadata {
    /// The title as it should appear in a reader's library.
    pub fn display_title(&self) -> String {
        match self.volume {
            Some(v) => format!("{}, Vol. {v}", self.series),
            None => self.series.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Chapter {
    /// Title shown in the table of contents.
    pub title: String,
    /// Folder this chapter was scanned from.
    pub source: PathBuf,
    /// Pages in reading order, including excluded ones so the UI can show them.
    pub pages: Vec<Page>,
}

impl Chapter {
    /// Pages that will actually be written to the output.
    pub fn included(&self) -> impl Iterator<Item = &Page> {
        self.pages.iter().filter(|p| p.is_included())
    }

    pub fn included_count(&self) -> usize {
        self.included().count()
    }

    pub fn excluded_count(&self) -> usize {
        self.pages.len() - self.included_count()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Volume {
    pub metadata: Metadata,
    /// Cover image. Defaults to the first included page of the first chapter
    /// when the user has not picked one.
    pub cover: Option<PathBuf>,
    pub chapters: Vec<Chapter>,
    /// Folder the volume was scanned from.
    pub root: PathBuf,
}

impl Volume {
    /// Every page that will be written, flattened across chapters.
    pub fn included_pages(&self) -> impl Iterator<Item = &Page> {
        self.chapters.iter().flat_map(|c| c.included())
    }

    pub fn total_included(&self) -> usize {
        self.included_pages().count()
    }

    /// The cover to use: the explicit choice, else the first page of the volume.
    pub fn effective_cover(&self) -> Option<PathBuf> {
        self.cover
            .clone()
            .or_else(|| self.included_pages().next().map(|p| p.path.clone()))
    }
}
