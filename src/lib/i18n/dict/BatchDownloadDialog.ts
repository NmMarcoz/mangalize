import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "batchDownloadDialog.title": "Download missing chapters",
    "batchDownloadDialog.description":
      "Paste any chapter page, or the series index. The URL pattern is learned from it and used to look for the {count} chapters you are missing.",
    "batchDownloadDialog.urlPlaceholder": "https://…/manga/ichi-the-witch-chapter-1/",
    "batchDownloadDialog.findChapters": "Find chapters",
    "batchDownloadDialog.missing": "Missing: {summary}.",
    "batchDownloadDialog.nothing": "nothing",
    "batchDownloadDialog.checkingChapters":
      "Reading the page and checking which chapters exist…",
    "batchDownloadDialog.noneReachedTitle": "No chapters could be reached.",
    "batchDownloadDialog.noneReachedDetail":
      "That URL has no number to vary and no chapter links. Try pasting an actual chapter page rather than the series landing page.",
    "batchDownloadDialog.chaptersFound": "{count} chapters found",
    "batchDownloadDialog.foundBreakdown":
      "{linked} linked by the site, {guessed} matched by pattern",
    "batchDownloadDialog.unresolvedHint":
      "No URL found for {summary} — that site may not have them.",
    "batchDownloadDialog.patternBadge": "pattern",
    "batchDownloadDialog.stageReading": "reading",
    "batchDownloadDialog.stageDownloading": "downloading",
    "batchDownloadDialog.progressLine": "Chapter {chapter} — {stage}",
    "batchDownloadDialog.pagesCount": "{done}/{total} pages",
    "batchDownloadDialog.stopped": "Stopped.",
    "batchDownloadDialog.chaptersDownloaded": "{count} chapters downloaded",
    "batchDownloadDialog.chaptersFailed": ", {count} failed",
    "batchDownloadDialog.failureLine": "Chapter {number}: {error}",
    "batchDownloadDialog.cancel": "Cancel",
    "batchDownloadDialog.download": "Download {count}",
    "batchDownloadDialog.patternLabel": "URL pattern",
    "batchDownloadDialog.backgroundHint": "Runs in the background — you can keep reading.",
  },
  "pt-BR": {
    "batchDownloadDialog.title": "Baixar capítulos faltando",
    "batchDownloadDialog.description":
      "Cole a página de qualquer capítulo, ou o índice da série. O padrão da URL é aprendido a partir dela e usado para procurar os {count} capítulos que estão faltando.",
    "batchDownloadDialog.urlPlaceholder": "https://…/manga/ichi-the-witch-chapter-1/",
    "batchDownloadDialog.findChapters": "Buscar capítulos",
    "batchDownloadDialog.missing": "Faltando: {summary}.",
    "batchDownloadDialog.nothing": "nada",
    "batchDownloadDialog.checkingChapters":
      "Lendo a página e verificando quais capítulos existem…",
    "batchDownloadDialog.noneReachedTitle": "Nenhum capítulo pôde ser alcançado.",
    "batchDownloadDialog.noneReachedDetail":
      "Essa URL não tem número para variar nem links de capítulo. Tente colar a página de um capítulo de verdade em vez da página inicial da série.",
    "batchDownloadDialog.chaptersFound": "{count} capítulos encontrados",
    "batchDownloadDialog.foundBreakdown":
      "{linked} linkados pelo site, {guessed} encontrados pelo padrão",
    "batchDownloadDialog.unresolvedHint":
      "Nenhuma URL encontrada para {summary} — esse site pode não os ter.",
    "batchDownloadDialog.patternBadge": "padrão",
    "batchDownloadDialog.stageReading": "lendo",
    "batchDownloadDialog.stageDownloading": "baixando",
    "batchDownloadDialog.progressLine": "Capítulo {chapter} — {stage}",
    "batchDownloadDialog.pagesCount": "{done}/{total} páginas",
    "batchDownloadDialog.stopped": "Interrompido.",
    "batchDownloadDialog.chaptersDownloaded": "{count} capítulos baixados",
    "batchDownloadDialog.chaptersFailed": ", {count} com falha",
    "batchDownloadDialog.failureLine": "Capítulo {number}: {error}",
    "batchDownloadDialog.cancel": "Cancelar",
    "batchDownloadDialog.download": "Baixar {count}",
    "batchDownloadDialog.patternLabel": "Padrão da URL",
    "batchDownloadDialog.backgroundHint": "Roda em segundo plano — você pode continuar lendo.",
  },
};

export default dict;
