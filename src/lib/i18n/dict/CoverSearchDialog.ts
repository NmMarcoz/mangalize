import type { PartialDictionary } from "@/lib/i18n/types";

const dict: PartialDictionary = {
  en: {
    // The trigger for this dialog lives in MetadataPanel but is this dialog's string.
    "coverSearch.search": "Search cover",
    "coverSearch.title": "Import cover from URL",
    "coverSearch.description":
      "Paste a direct image URL to download it as the volume's cover.",
    "coverSearch.step1": "Search for the cover in your browser (e.g. Google Images)",
    "coverSearch.step2": "Right-click the image and choose \"Copy image address\"",
    "coverSearch.step3": "Paste the URL below and click Import cover",
    "coverSearch.pasteUrl": "Paste image URL here",
    "coverSearch.cancel": "Cancel",
    "coverSearch.import": "Import cover",
  },
  "pt-BR": {
    "coverSearch.search": "Buscar capa",
    "coverSearch.title": "Importar capa por URL",
    "coverSearch.description":
      "Cole a URL de uma imagem para baixá-la como capa do volume.",
    "coverSearch.step1": "Pesquise a capa no seu navegador (ex: Google Imagens)",
    "coverSearch.step2": "Clique com o botão direito na imagem e escolha \"Copiar endereço da imagem\"",
    "coverSearch.step3": "Cole a URL abaixo e clique em Importar capa",
    "coverSearch.pasteUrl": "Cole a URL da imagem aqui",
    "coverSearch.cancel": "Cancelar",
    "coverSearch.import": "Importar capa",
  },
};

export default dict;
