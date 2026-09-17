import type { PartialDictionary } from "@/lib/i18n/types";

/** `lib/send.ts`'s `presets` — outside any component. Provider names (Gmail,
 * Outlook, Yahoo, iCloud) are brand names and are not translated. */
const dict: PartialDictionary = {
  en: {
    "send.noteGmail": "Needs an app password, which requires 2-step verification to be on.",
    "send.noteOutlook": "Needs an app password when two-step verification is on.",
    "send.noteYahoo": "Needs an app password.",
    "send.noteICloud": "Needs an app-specific password from your Apple account.",
  },
  "pt-BR": {
    "send.noteGmail":
      "Precisa de uma senha de app, o que exige que a verificação em duas etapas esteja ativada.",
    "send.noteOutlook": "Precisa de uma senha de app quando a verificação em duas etapas está ativada.",
    "send.noteYahoo": "Precisa de uma senha de app.",
    "send.noteICloud": "Precisa de uma senha específica de app da sua conta Apple.",
  },
};

export default dict;
