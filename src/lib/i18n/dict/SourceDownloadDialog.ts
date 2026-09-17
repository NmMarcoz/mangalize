import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "sourceDownloadDialog.title": "Get {count} from {sourceName}",
    "sourceDownloadDialog.description":
      "Only the chapters already listed as missing. Nothing else is looked for, and one that fails does not stop the rest.",
    "sourceDownloadDialog.singleChapter": "Chapter {number}.",
    "sourceDownloadDialog.rangeChapters": "Chapters {first} to {last}.",
    "sourceDownloadDialog.backgroundHint":
      "This runs in the background — you can close this and carry on reading.",
    "sourceDownloadDialog.cancel": "Cancel",
    "sourceDownloadDialog.download": "Download",
  },
  "pt-BR": {
    "sourceDownloadDialog.title": "Baixar {count} de {sourceName}",
    "sourceDownloadDialog.description":
      "Apenas os capítulos já listados como faltando. Nada mais é procurado, e um que falhar não interrompe os demais.",
    "sourceDownloadDialog.singleChapter": "Capítulo {number}.",
    "sourceDownloadDialog.rangeChapters": "Capítulos {first} a {last}.",
    "sourceDownloadDialog.backgroundHint":
      "Isso roda em segundo plano — você pode fechar esta janela e continuar lendo.",
    "sourceDownloadDialog.cancel": "Cancelar",
    "sourceDownloadDialog.download": "Baixar",
  },
};

export default dict;
