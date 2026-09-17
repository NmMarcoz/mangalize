import type { PartialDictionary } from "@/lib/i18n/types";

/** A handful of one-word strings reused across more than one component,
 * kept here once rather than duplicated in each file's own dict. */
const dict: PartialDictionary = {
  en: {
    "common.black": "black",
    "common.grey": "grey",
    "common.white": "white",
  },
  "pt-BR": {
    "common.black": "preto",
    "common.grey": "cinza",
    "common.white": "branco",
  },
};

export default dict;
