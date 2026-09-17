import type { PartialDictionary } from "@/lib/i18n/types";

/** `lib/reader.ts`'s `readerModes`/`readerFits` — outside any component, so
 * kept separate from `ReaderSettings`'s own dict. */
const dict: PartialDictionary = {
  en: {
    "reader.modePaged": "Single page",
    "reader.modePagedDetail": "One page at a time. What most manga is drawn for.",
    "reader.modeDouble": "Two pages",
    "reader.modeDoubleDetail": "A facing pair, as a printed book falls open. Wide screens only.",
    "reader.modeWebtoon": "Continuous",
    "reader.modeWebtoonDetail": "Scrolls without page breaks. What webtoons are drawn for.",
    "reader.fitContain": "Fit page",
    "reader.fitWidth": "Fit width",
    "reader.fitHeight": "Fit height",
    "reader.fitOriginal": "Original size",
  },
  "pt-BR": {
    "reader.modePaged": "Página única",
    "reader.modePagedDetail": "Uma página por vez. O formato para o qual a maioria dos mangás é desenhada.",
    "reader.modeDouble": "Duas páginas",
    "reader.modeDoubleDetail":
      "Um par lado a lado, como um livro impresso aberto. Só em telas largas.",
    "reader.modeWebtoon": "Contínuo",
    "reader.modeWebtoonDetail": "Rola sem quebras de página. O formato para o qual webtoons são desenhados.",
    "reader.fitContain": "Ajustar à página",
    "reader.fitWidth": "Ajustar à largura",
    "reader.fitHeight": "Ajustar à altura",
    "reader.fitOriginal": "Tamanho original",
  },
};

export default dict;
