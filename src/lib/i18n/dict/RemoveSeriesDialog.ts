import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "removeSeriesDialog.title": "Remove {title}?",
    "removeSeriesDialog.downloadedChapters":
      "{count} downloaded {chapters} on disk.",
    "removeSeriesDialog.chapterSingular": "chapter",
    "removeSeriesDialog.chapterPlural": "chapters",
    "removeSeriesDialog.nothingDownloaded": "Nothing has been downloaded for this series yet.",
    "removeSeriesDialog.deleteFiles": "Delete the downloaded files too",
    "removeSeriesDialog.deleteFilesHint":
      "Permanently removes the chapter images from disk. Anything you have already exported is untouched.",
    "removeSeriesDialog.deleteNoticeDeletePrefix":
      "The series and its files will be deleted from ",
    "removeSeriesDialog.deleteNoticeDeleteSuffix": ". This cannot be undone.",
    "removeSeriesDialog.deleteNoticeKeepPrefix": "Only the library entry goes. The files stay in ",
    "removeSeriesDialog.deleteNoticeKeepSuffix": ".",
    "removeSeriesDialog.cancel": "Cancel",
    "removeSeriesDialog.deleteSeriesAndFiles": "Delete series and files",
    "removeSeriesDialog.removeFromLibrary": "Remove from library",
  },
  "pt-BR": {
    "removeSeriesDialog.title": "Remover {title}?",
    "removeSeriesDialog.downloadedChapters":
      "{count} {chapters} baixados no disco.",
    "removeSeriesDialog.chapterSingular": "capítulo",
    "removeSeriesDialog.chapterPlural": "capítulos",
    "removeSeriesDialog.nothingDownloaded": "Nada foi baixado desta série ainda.",
    "removeSeriesDialog.deleteFiles": "Excluir também os arquivos baixados",
    "removeSeriesDialog.deleteFilesHint":
      "Remove permanentemente as imagens dos capítulos do disco. Qualquer coisa que você já tenha exportado permanece intacta.",
    "removeSeriesDialog.deleteNoticeDeletePrefix":
      "A série e seus arquivos serão excluídos de ",
    "removeSeriesDialog.deleteNoticeDeleteSuffix": ". Isso não pode ser desfeito.",
    "removeSeriesDialog.deleteNoticeKeepPrefix":
      "Apenas a entrada na biblioteca é removida. Os arquivos permanecem em ",
    "removeSeriesDialog.deleteNoticeKeepSuffix": ".",
    "removeSeriesDialog.cancel": "Cancelar",
    "removeSeriesDialog.deleteSeriesAndFiles": "Excluir série e arquivos",
    "removeSeriesDialog.removeFromLibrary": "Remover da biblioteca",
  },
};

export default dict;
