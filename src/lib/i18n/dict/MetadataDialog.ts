import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "metadataDialog.title": "Fetch series metadata",
    "metadataDialog.description":
      "Searches MangaDex, falling back to Kitsu. Nothing is sent anywhere except the search term.",
    "metadataDialog.viewSource": "View source",
    "metadataDialog.cancel": "Cancel",
    "metadataDialog.apply": "Apply",
    "metadataDialog.noPublishedLayout": "No published layout for volume {volume}.",
    "metadataDialog.chapterCountMatches":
      "Volume {volume} has {count} chapters — matches your folder",
    "metadataDialog.chapterCountMismatch":
      "Volume {volume} has {count} chapters — your folder has {actual}",
    "metadataDialog.chaptersList": "Chapters {list}",
  },
  "pt-BR": {
    "metadataDialog.title": "Buscar metadados da série",
    "metadataDialog.description":
      "Busca no MangaDex, recorrendo ao Kitsu. Nada é enviado além do termo de busca.",
    "metadataDialog.viewSource": "Ver fonte",
    "metadataDialog.cancel": "Cancelar",
    "metadataDialog.apply": "Aplicar",
    "metadataDialog.noPublishedLayout": "Nenhum layout publicado para o volume {volume}.",
    "metadataDialog.chapterCountMatches":
      "O volume {volume} tem {count} capítulos — corresponde à sua pasta",
    "metadataDialog.chapterCountMismatch":
      "O volume {volume} tem {count} capítulos — sua pasta tem {actual}",
    "metadataDialog.chaptersList": "Capítulos {list}",
  },
};

export default dict;
