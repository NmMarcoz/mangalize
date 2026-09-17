import type { PartialDictionary } from "@/lib/i18n/types";

/** `lib/settings.ts`'s `compressionPresets` — separate from `SettingsView`'s
 * own dict since it lives outside any component. */
const dict: PartialDictionary = {
  en: {
    "settings.compressionOriginal": "Original",
    "settings.compressionOriginalDetail":
      "Pages are copied untouched. Largest files, and usually far more detail than any e-reader can show.",
    "settings.compressionLarge": "Large · 2400px",
    "settings.compressionLargeDetail":
      "For a Kindle Scribe or a tablet. Roughly half the size of the original.",
    "settings.compressionKindle": "Kindle · 1600px",
    "settings.compressionKindleDetail":
      "Matches a Paperwhite or Oasis exactly. Typically a quarter of the original size, with nothing visible lost on the device.",
    "settings.compressionCompact": "Compact · 1280px",
    "settings.compressionCompactDetail":
      "When a volume has to fit an email attachment limit. Softer if you zoom right in.",
  },
  "pt-BR": {
    "settings.compressionOriginal": "Original",
    "settings.compressionOriginalDetail":
      "As páginas são copiadas sem alteração. Arquivos maiores, e geralmente com mais detalhe do que qualquer e-reader consegue mostrar.",
    "settings.compressionLarge": "Grande · 2400px",
    "settings.compressionLargeDetail":
      "Para um Kindle Scribe ou um tablet. Cerca de metade do tamanho original.",
    "settings.compressionKindle": "Kindle · 1600px",
    "settings.compressionKindleDetail":
      "Corresponde exatamente a um Paperwhite ou Oasis. Normalmente um quarto do tamanho original, sem perda visível no aparelho.",
    "settings.compressionCompact": "Compacto · 1280px",
    "settings.compressionCompactDetail":
      "Quando um volume precisa caber no limite de anexo de um e-mail. Fica mais suave se você der bastante zoom.",
  },
};

export default dict;
