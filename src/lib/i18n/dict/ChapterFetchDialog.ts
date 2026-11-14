import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "chapterFetchDialog.title": "Get chapter {chapter}",
    "chapterFetchDialog.description":
      "Paste the page holding the chapter's images. Nothing is downloaded until you choose it.",
    "chapterFetchDialog.urlPlaceholder": "https://…",
    "chapterFetchDialog.findImages": "Find images",
    "chapterFetchDialog.openPage": "Open page",
    "chapterFetchDialog.openPageHint": "Render the page in a window and capture what it loads",
    "chapterFetchDialog.noImagesTitle": "No images in that page's markup.",
    "chapterFetchDialog.jsBuiltHint":
      "It most likely builds itself in JavaScript. Use {link} to render it in a window, scroll until the pages have loaded, and click Capture.",
    "chapterFetchDialog.jsBuiltNoWindow":
      "It most likely builds itself in JavaScript, which needs a second window to render — something this platform does not have. Downloading it on the desktop app and syncing the library is the way round.",
    "chapterFetchDialog.idleHint":
      "Images are measured before anything is saved, so pages, spreads and banners can be told apart and preselected for you.",
    "chapterFetchDialog.stageMeasuring": "measuring",
    "chapterFetchDialog.stageDownloading": "downloading",
    "chapterFetchDialog.allButton": "All",
    "chapterFetchDialog.noneButton": "None",
    "chapterFetchDialog.resetButton": "Reset",
    "chapterFetchDialog.pagesCount": "{count} pages",
    "chapterFetchDialog.cancel": "Cancel",
    "chapterFetchDialog.download": "Download",
    "chapterFetchDialog.downloadCount": "Download {count} pages",
    "chapterFetchDialog.selectionSummary": "{count} images · {chosen} chosen",
    "chapterFetchDialog.spreadBadge": "spread",
    "chapterFetchDialog.offSizeBadge": "off-size",
  },
  "pt-BR": {
    "chapterFetchDialog.title": "Baixar capítulo {chapter}",
    "chapterFetchDialog.description":
      "Cole a página que tem as imagens do capítulo. Nada é baixado até você escolher.",
    "chapterFetchDialog.urlPlaceholder": "https://…",
    "chapterFetchDialog.findImages": "Buscar imagens",
    "chapterFetchDialog.openPage": "Abrir página",
    "chapterFetchDialog.openPageHint": "Renderiza a página em uma janela e captura o que ela carrega",
    "chapterFetchDialog.noImagesTitle": "Nenhuma imagem no código dessa página.",
    "chapterFetchDialog.jsBuiltHint":
      "Ela provavelmente se monta em JavaScript. Use {link} para renderizá-la em uma janela, role até as páginas carregarem e clique em Capturar.",
    "chapterFetchDialog.jsBuiltNoWindow":
      "Ela provavelmente se monta em JavaScript, o que precisa de uma segunda janela para renderizar — algo que essa plataforma não tem. Baixá-la no app de desktop e sincronizar a biblioteca é o jeito de contornar isso.",
    "chapterFetchDialog.idleHint":
      "As imagens são medidas antes de qualquer coisa ser salva, para que páginas, páginas duplas e banners possam ser diferenciados e pré-selecionados para você.",
    "chapterFetchDialog.stageMeasuring": "medindo",
    "chapterFetchDialog.stageDownloading": "baixando",
    "chapterFetchDialog.allButton": "Todas",
    "chapterFetchDialog.noneButton": "Nenhuma",
    "chapterFetchDialog.resetButton": "Redefinir",
    "chapterFetchDialog.pagesCount": "{count} páginas",
    "chapterFetchDialog.cancel": "Cancelar",
    "chapterFetchDialog.download": "Baixar",
    "chapterFetchDialog.downloadCount": "Baixar {count} páginas",
    "chapterFetchDialog.selectionSummary": "{count} imagens · {chosen} escolhidas",
    "chapterFetchDialog.spreadBadge": "página dupla",
    "chapterFetchDialog.offSizeBadge": "fora do padrão",
  },
};

export default dict;
