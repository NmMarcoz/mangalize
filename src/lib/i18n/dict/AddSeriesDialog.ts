import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "addSeriesDialog.title": "Add a series",
    "addSeriesDialog.description":
      "Searches MangaDex, falling back to Kitsu. Adding also pulls the published volume layout, so the library can tell you what is missing.",
    "addSeriesDialog.volumesAndChapters":
      "{volumes} published volumes, {chapters} chapters.",
    "addSeriesDialog.cancel": "Cancel",
    "addSeriesDialog.add": "Add to library",
  },
  "pt-BR": {
    "addSeriesDialog.title": "Adicionar uma série",
    "addSeriesDialog.description":
      "Busca no MangaDex, recorrendo ao Kitsu. Adicionar também traz o layout de volumes publicados, para que a biblioteca possa dizer o que está faltando.",
    "addSeriesDialog.volumesAndChapters":
      "{volumes} volumes publicados, {chapters} capítulos.",
    "addSeriesDialog.cancel": "Cancelar",
    "addSeriesDialog.add": "Adicionar à biblioteca",
  },
};

export default dict;
