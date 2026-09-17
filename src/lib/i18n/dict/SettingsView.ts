import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    "settingsView.title": "Settings",
    "settingsView.save": "Save",
    "settingsView.saved": "Saved",
    "settingsView.loading": "Loading…",
    "settingsView.libraryFolder": "Library folder",
    "settingsView.libraryFolderHint":
      "Where series, chapters and cover art are stored. Moving this does not move existing files; point it at a folder you have already copied.",
    "settingsView.buildFolder": "Build folder",
    "settingsView.buildFolderHint":
      "Where Build writes without asking. Build as… still lets you choose a one-off location.",
    "settingsView.buildFolderPlaceholder": "Not set — Build will ask every time",
    "settingsView.folderPerSeries": "A folder per series",
    "settingsView.folderPerSeriesOn": "Ichi the Witch/Ichi the Witch v01.epub",
    "settingsView.folderPerSeriesOff": "Ichi the Witch v01.epub — everything in one folder",
    "settingsView.splitSpreads": "Split double-page spreads",
    "settingsView.splitSpreadsOn":
      "Each spread becomes two pages, right half first for manga. Kindle zooms into part of a wide page instead of fitting it, so this is almost always what you want.",
    "settingsView.splitSpreadsOff":
      "Spreads stay whole. Fine on a tablet or a desktop reader; on a Kindle you will see half the drawing.",
    "settingsView.pageSize": "Page size",
    "settingsView.pageSizeHint":
      "Black-and-white pages are stored as greyscale, which removes about a third again. Colour covers keep their colour, and a page already smaller than the limit is left alone.",
    "settingsView.defaultFormat": "Default format",
    "settingsView.defaultFormatEpub": "EPUB · Kindle",
    "settingsView.defaultFormatCbz": "CBZ · Comic readers",
    "settingsView.defaultFormatHint": "Pre-selected in the editor, and what a batch build uses.",
    "settingsView.language": "Language",
    "settingsView.languageHint": "Only the app's own chrome — a series you read keeps whatever language it was published in.",
    "settingsView.extensions": "Extensions",
    "settingsView.import": "Import…",
    "settingsView.extensionsHintAndroid":
      "A .lua file picked here is copied into the library's extensions folder — the only way to get one there on a phone.",
    "settingsView.extensionsHintDesktop":
      "A .lua file copied into the library's extensions folder works too; this is the same thing without leaving the app.",
    "settingsView.libraryBackup": "Library backup",
    "settingsView.libraryBackupHint":
      "Every series' source and metadata, and every chapter's reading progress and manual volume assignments — not the downloaded pages themselves. For moving to another device, or just a backup.",
    "settingsView.export": "Export…",
    "settingsView.importSummary":
      "Imported {seriesTotal} series ({seriesAdded} new). Updated progress on {chaptersTouched} chapters.",
    "settingsView.updates": "Updates",
    "settingsView.checkForUpdates": "Check for updates",
    "settingsView.upToDate": "Up to date",
    "settingsView.updatesHint":
      "There is no store to update a sideloaded build, so the app fetches the release itself and Android asks before installing it. An update signed with a different key is refused — by the system, not by us.",
    "settingsView.revealInFileManager": "Reveal in file manager",
    "settingsView.notSet": "Not set",
    "settingsView.change": "Change",
    "settingsView.clear": "Clear",
  },
  "pt-BR": {
    "settingsView.title": "Configurações",
    "settingsView.save": "Salvar",
    "settingsView.saved": "Salvo",
    "settingsView.loading": "Carregando…",
    "settingsView.libraryFolder": "Pasta da biblioteca",
    "settingsView.libraryFolderHint":
      "Onde séries, capítulos e capas ficam armazenados. Alterar isto não move os arquivos existentes; aponte para uma pasta para a qual você já copiou tudo.",
    "settingsView.buildFolder": "Pasta de saída",
    "settingsView.buildFolderHint":
      "Onde o Gerar salva sem perguntar. \"Gerar como…\" ainda permite escolher um local pontual.",
    "settingsView.buildFolderPlaceholder": "Não definido — o Gerar vai perguntar toda vez",
    "settingsView.folderPerSeries": "Uma pasta por série",
    "settingsView.folderPerSeriesOn": "Ichi the Witch/Ichi the Witch v01.epub",
    "settingsView.folderPerSeriesOff": "Ichi the Witch v01.epub — tudo em uma pasta só",
    "settingsView.splitSpreads": "Dividir páginas duplas",
    "settingsView.splitSpreadsOn":
      "Cada página dupla vira duas páginas, com a metade direita primeiro para mangá. O Kindle amplia parte de uma página larga em vez de ajustá-la, então isso é quase sempre o que você quer.",
    "settingsView.splitSpreadsOff":
      "As páginas duplas ficam inteiras. Bom para um tablet ou um leitor de desktop; no Kindle você verá metade do desenho.",
    "settingsView.pageSize": "Tamanho da página",
    "settingsView.pageSizeHint":
      "Páginas em preto e branco são salvas em escala de cinza, o que reduz o tamanho em cerca de mais um terço. Capas coloridas mantêm a cor, e uma página já menor que o limite é deixada como está.",
    "settingsView.defaultFormat": "Formato padrão",
    "settingsView.defaultFormatEpub": "EPUB · Kindle",
    "settingsView.defaultFormatCbz": "CBZ · Leitores de quadrinhos",
    "settingsView.defaultFormatHint": "Pré-selecionado no editor, e usado em uma geração em lote.",
    "settingsView.language": "Idioma",
    "settingsView.languageHint": "Apenas a interface do aplicativo — uma série que você lê mantém o idioma em que foi publicada.",
    "settingsView.extensions": "Extensões",
    "settingsView.import": "Importar…",
    "settingsView.extensionsHintAndroid":
      "Um arquivo .lua escolhido aqui é copiado para a pasta de extensões da biblioteca — a única forma de colocar um lá no celular.",
    "settingsView.extensionsHintDesktop":
      "Copiar um arquivo .lua para a pasta de extensões da biblioteca também funciona; isso é a mesma coisa sem sair do aplicativo.",
    "settingsView.libraryBackup": "Backup da biblioteca",
    "settingsView.libraryBackupHint":
      "O código-fonte e os metadados de cada série, e o progresso de leitura e as atribuições manuais de volume de cada capítulo — não as páginas baixadas. Para mudar de dispositivo, ou apenas para backup.",
    "settingsView.export": "Exportar…",
    "settingsView.importSummary":
      "Importadas {seriesTotal} séries ({seriesAdded} novas). Progresso atualizado em {chaptersTouched} capítulos.",
    "settingsView.updates": "Atualizações",
    "settingsView.checkForUpdates": "Procurar atualizações",
    "settingsView.upToDate": "Atualizado",
    "settingsView.updatesHint":
      "Não há uma loja para atualizar uma instalação feita fora dela, então o aplicativo busca o lançamento por conta própria e o Android pergunta antes de instalar. Uma atualização assinada com uma chave diferente é recusada — pelo sistema, não por nós.",
    "settingsView.revealInFileManager": "Mostrar no gerenciador de arquivos",
    "settingsView.notSet": "Não definido",
    "settingsView.change": "Alterar",
    "settingsView.clear": "Limpar",
  },
};

export default dict;
