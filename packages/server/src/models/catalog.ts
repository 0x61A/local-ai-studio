import {
  getModelDetail,
  pickBestFit,
  type HfFile,
  type HfModelDetail,
} from "./huggingface.js";

export type CatalogCategory =
  | "popular"
  | "reasoning"
  | "coding"
  | "lightweight"
  | "large"
  | "vision"
  | "embedding";

export interface CatalogModelItem {
  id: string;
  name: string;
  repo: string;
  category: CatalogCategory;
  descriptionTr: string;
  descriptionEn: string;
  parameters: string;
  contextLength: number;
  /**
   * Tercih edilen nicemleme. Dosya ADI degil: dosya adlari depo sahibine gore
   * degisiyor ve zamanla degisiyor. Gercek dosya indirme aninda Hugging
   * Face'in dosya listesinden cozulur.
   */
  preferredQuant: string;
  /** Yalnizca gosterim icin kaba boyut. Indirme bunu kullanmaz. */
  approxSizeBytes: number;
  minRamGb: number;
  tagsTr: string[];
  tagsEn: string[];
  isEmbedding?: boolean;
  /**
   * Gorsel model mi. Gorsel modeller iki dosyadir: dil modeli ve goruntu
   * kodlayici (mmproj). Yalnizca ilki indirilirse model calisir ama gorsel
   * goremez -- sessizce metin modeline donusur. Kodlayicinin adi da depoda
   * cozulur.
   */
  needsProjector?: boolean;
}

export interface CatalogModelResponse
  extends Omit<CatalogModelItem, "descriptionTr" | "descriptionEn" | "tagsTr" | "tagsEn"> {
  description: string;
  tags: string[];
  /** Kaba bir gosterge; gercek boyut cozumlemede ogrenilir. */
  fits: boolean;
  fitsReason: string;
  estimatedMb: number;
}

/** Indirmeye hazir, Hugging Face'ten cozulmus gercek dosya. */
export interface ResolvedFile {
  filename: string;
  downloadUrl: string;
  sizeBytes: number;
  sha256: string | null;
}

export interface ResolvedCatalogModel {
  id: string;
  model: ResolvedFile;
  /** Gorsel modellerde goruntu kodlayici; yoksa null. */
  projector: ResolvedFile | null;
}

export class CatalogResolveError extends Error {}

export const CATALOG_MODELS: CatalogModelItem[] = [
  // -- Popüler & Çok Amaçlı ----------------------------------------------------
  {
    id: "qwen2.5-7b-instruct",
    name: "Qwen 2.5 7B Instruct",
    repo: "bartowski/Qwen2.5-7B-Instruct-GGUF",
    category: "popular",
    descriptionTr: "Mükemmel Türkçe desteği, 128k bağlam penceresi ve üstün genel sohbet kabiliyeti.",
    descriptionEn: "Strong multilingual understanding, 128k context window, and outstanding general chat quality.",
    parameters: "7.6B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_920_000_000,
    minRamGb: 6,
    tagsTr: ["Türkçe", "Popüler", "Geniş Bağlam", "128k"],
    tagsEn: ["Multilingual", "Popular", "Wide Context", "128k"],
  },
  {
    id: "llama-3.1-8b-instruct",
    name: "Meta Llama 3.1 8B Instruct",
    repo: "bartowski/Meta-Llama-3.1-8B-Instruct-GGUF",
    category: "popular",
    descriptionTr: "Meta'nın endüstri standardı açık modeli; genel diyalog, özetleme ve talimat takibinde çok başarılı.",
    descriptionEn: "Meta's industry-standard open model; exceptional at general dialogue, summarization, and instruction following.",
    parameters: "8.0B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_920_000_000,
    minRamGb: 6.5,
    tagsTr: ["Meta", "Popüler", "Genel", "128k"],
    tagsEn: ["Meta", "Popular", "General", "128k"],
  },
  {
    id: "gemma-2-9b-it",
    name: "Google Gemma 2 9B Instruct",
    repo: "bartowski/gemma-2-9b-it-GGUF",
    category: "popular",
    descriptionTr: "Google DeepMind mimarisiyle eğitilmiş, sınıfının en yüksek kıyaslama skorlarına sahip dengeli model.",
    descriptionEn: "Trained on Google DeepMind architecture with top-tier benchmarks for its parameter class.",
    parameters: "9.2B",
    contextLength: 8192,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 5_800_000_000,
    minRamGb: 7.5,
    tagsTr: ["Google", "Kaliteli", "Dengeli"],
    tagsEn: ["Google", "High Quality", "Balanced"],
  },
  {
    id: "mistral-7b-instruct-v0.3",
    name: "Mistral 7B Instruct v0.3",
    repo: "bartowski/Mistral-7B-Instruct-v0.3-GGUF",
    category: "popular",
    descriptionTr: "Mistral AI'ın hızlı, araç çağrısı destekleyen ve kaynakları verimli kullanan popüler 7B modeli.",
    descriptionEn: "Fast, function-calling capable, and resource-efficient 7B model by Mistral AI.",
    parameters: "7.3B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_370_000_000,
    minRamGb: 6,
    tagsTr: ["Mistral", "Hızlı", "Araç Desteği"],
    tagsEn: ["Mistral", "Fast", "Tool Calling"],
  },
  {
    id: "hermes-3-llama-3.1-8b",
    name: "Hermes 3 Llama 3.1 8B",
    repo: "bartowski/Hermes-3-Llama-3.1-8B-GGUF",
    category: "popular",
    descriptionTr: "Nous Research tarafından ajanlar, araç kullanımı ve rol yapma için özel eğitilmiş gelişmiş model.",
    descriptionEn: "Specialized model by Nous Research fine-tuned for autonomous agents, tool use, and roleplay.",
    parameters: "8.0B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_920_000_000,
    minRamGb: 6.5,
    tagsTr: ["Ajan", "Araçlar", "Rol Yapma"],
    tagsEn: ["Agent", "Tools", "Roleplay"],
  },

  // -- Akıl Yürütme & Düşünme (Reasoning / R1) --------------------------------
  {
    id: "deepseek-r1-distill-qwen-7b",
    name: "DeepSeek R1 Distill Qwen 7B",
    repo: "bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF",
    category: "reasoning",
    descriptionTr: "OpenAI o1 kalitesinde adım adım derin düşünme, matematiksel çıkarım ve mantık yeteneği.",
    descriptionEn: "Step-by-step reasoning, mathematical deduction, and logic matching OpenAI o1-level chains of thought.",
    parameters: "7.6B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_680_000_000,
    minRamGb: 6.5,
    tagsTr: ["Düşünme", "o1 Seviyesi", "Matematik", "Mantık"],
    tagsEn: ["Reasoning", "o1 Level", "Math", "Logic"],
  },
  {
    id: "deepseek-r1-distill-qwen-14b",
    name: "DeepSeek R1 Distill Qwen 14B",
    repo: "bartowski/DeepSeek-R1-Distill-Qwen-14B-GGUF",
    category: "reasoning",
    descriptionTr: "Karmaşık bilimsel, algoritmik ve çok adımlı problem çözümlerinde üstün akıl yürütme gücü.",
    descriptionEn: "Superior reasoning power for complex scientific, algorithmic, and multi-step problem solving.",
    parameters: "14.8B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 8_990_000_000,
    minRamGb: 11.5,
    tagsTr: ["İleri Düşünme", "Bilim", "Algoritma"],
    tagsEn: ["Deep Reasoning", "Science", "Algorithms"],
  },
  {
    id: "deepseek-r1-distill-llama-8b",
    name: "DeepSeek R1 Distill Llama 8B",
    repo: "bartowski/DeepSeek-R1-Distill-Llama-8B-GGUF",
    category: "reasoning",
    descriptionTr: "Llama 3.1 temeli üzerine DeepSeek R1 düşünme yeteneklerinin damıtılmış versiyonu.",
    descriptionEn: "DeepSeek R1 reasoning capabilities distilled onto the Meta Llama 3.1 8B foundation.",
    parameters: "8.0B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_920_000_000,
    minRamGb: 6.5,
    tagsTr: ["Llama R1", "Mantık", "Düşünme"],
    tagsEn: ["Llama R1", "Logic", "Reasoning"],
  },
  {
    id: "deepseek-r1-distill-qwen-1.5b",
    name: "DeepSeek R1 Distill Qwen 1.5B",
    repo: "bartowski/DeepSeek-R1-Distill-Qwen-1.5B-GGUF",
    category: "reasoning",
    descriptionTr: "Düşük bellekli sistemler ve dizüstü bilgisayarlar için ultra hafif adım adım düşünme modeli.",
    descriptionEn: "Ultra-lightweight step-by-step reasoning model designed for low RAM systems and laptops.",
    parameters: "1.5B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 1_120_000_000,
    minRamGb: 2,
    tagsTr: ["Hafif R1", "Hızlı", "Düşük RAM"],
    tagsEn: ["Light R1", "Fast", "Low RAM"],
  },

  // -- Kodlama & Yazılım (Coding & Developer) ---------------------------------
  {
    id: "qwen2.5-coder-7b-instruct",
    name: "Qwen 2.5 Coder 7B Instruct",
    repo: "Qwen/Qwen2.5-Coder-7B-Instruct-GGUF",
    category: "coding",
    descriptionTr: "90+ dilde kod yazma, hata ayıklama, refactoring ve kod tamamlama şampiyonu.",
    descriptionEn: "Top benchmark performer for code generation, debugging, refactoring, and code completion in 90+ languages.",
    parameters: "7.6B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_680_000_000,
    minRamGb: 6.5,
    tagsTr: ["Kodlama", "Python/JS/C++", "Refactoring", "128k"],
    tagsEn: ["Coding", "Python/JS/C++", "Refactoring", "128k"],
  },
  {
    id: "qwen2.5-coder-14b-instruct",
    name: "Qwen 2.5 Coder 14B Instruct",
    repo: "Qwen/Qwen2.5-Coder-14B-Instruct-GGUF",
    category: "coding",
    descriptionTr: "Büyük kod tabanları, karmaşık sistem mimarileri ve ileri seviye yazılım geliştirme için güçlü model.",
    descriptionEn: "Formidable model for large codebases, complex system architecture, and advanced software engineering.",
    parameters: "14.8B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 8_990_000_000,
    minRamGb: 11.5,
    tagsTr: ["İleri Kodlama", "Mimari", "Geniş Depolar"],
    tagsEn: ["Advanced Coding", "Architecture", "Large Repos"],
  },
  {
    id: "qwen2.5-coder-1.5b-instruct",
    name: "Qwen 2.5 Coder 1.5B Instruct",
    repo: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF",
    category: "coding",
    descriptionTr: "Anında yanıt veren, hafif ve kaynak tüketmeyen hızlı kodlama yardımcısı.",
    descriptionEn: "Instantaneous, lightweight, low-footprint coding assistant for rapid code suggestions.",
    parameters: "1.5B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 1_040_000_000,
    minRamGb: 1.8,
    tagsTr: ["Hafif Kod", "Hızlı", "Düşük Tüketim"],
    tagsEn: ["Light Coding", "Fast", "Low Footprint"],
  },
  {
    id: "deepseek-coder-6.7b-instruct",
    name: "DeepSeek Coder 6.7B Instruct",
    repo: "TheBloke/deepseek-coder-6.7B-instruct-GGUF",
    category: "coding",
    descriptionTr: "Algoritmalar ve proje düzeyinde kod üretiminde yaygın olarak test edilmiş güvenilir model.",
    descriptionEn: "Widely tested and trusted model for algorithms and project-level code generation.",
    parameters: "6.7B",
    contextLength: 16384,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_080_000_000,
    minRamGb: 5.5,
    tagsTr: ["DeepSeek", "Algoritma", "Kodlama"],
    tagsEn: ["DeepSeek", "Algorithm", "Coding"],
  },
  {
    id: "codestral-22b-v0.1",
    name: "Codestral 22B v0.1",
    repo: "bartowski/Codestral-22B-v0.1-GGUF",
    category: "coding",
    descriptionTr: "Mistral AI'ın 80'den fazla programlama dilinde uzmanlaşmış kurumsal kodlama modeli.",
    descriptionEn: "Mistral AI's enterprise coding model fluent in over 80 programming languages.",
    parameters: "22.2B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 13_500_000_000,
    minRamGb: 16.5,
    tagsTr: ["Mistral", "80+ Dil", "Kurumsal Kod"],
    tagsEn: ["Mistral", "80+ Languages", "Enterprise Code"],
  },

  // -- Hafif & Hızlı (Lightweight / Laptop) -----------------------------------
  {
    id: "llama-3.2-3b-instruct",
    name: "Llama 3.2 3B Instruct",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    category: "lightweight",
    descriptionTr: "8 GB RAM'li cihazlarda dahi ışık hızında çalışan, 128k bağlamlı olağanüstü kompakt model.",
    descriptionEn: "Lightning fast on 8 GB RAM machines with 128k context and surprising capability.",
    parameters: "3.2B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 2_020_000_000,
    minRamGb: 3.0,
    tagsTr: ["Hafif", "Meta", "128k", "8 GB RAM İçin İdeal"],
    tagsEn: ["Lightweight", "Meta", "128k", "Ideal for 8GB RAM"],
  },
  {
    id: "llama-3.2-1b-instruct",
    name: "Llama 3.2 1B Instruct",
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    category: "lightweight",
    descriptionTr: "Yalnızca ~800 MB boyutuyla anında inen, en düşük donanımlarda bile akıcı çalışan model.",
    descriptionEn: "Downloads in seconds at only ~800 MB, running smoothly on virtually any hardware.",
    parameters: "1.2B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 810_000_000,
    minRamGb: 1.5,
    tagsTr: ["Minimal", "Çok Hızlı", "Düşük Boyut"],
    tagsEn: ["Minimal", "Very Fast", "Small Size"],
  },
  {
    id: "qwen2.5-3b-instruct",
    name: "Qwen 2.5 3B Instruct",
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    category: "lightweight",
    descriptionTr: "3B sınıfında en iyi Türkçe ve çok dilli anlama başarımı sunan kompakt güç merkezi.",
    descriptionEn: "Best-in-class Turkish and multilingual capability in the compact 3B segment.",
    parameters: "3.1B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 2_040_000_000,
    minRamGb: 3.0,
    tagsTr: ["Türkçe", "Kompakt", "Dengeli"],
    tagsEn: ["Multilingual", "Compact", "Balanced"],
  },
  {
    id: "qwen2.5-1.5b-instruct",
    name: "Qwen 2.5 1.5B Instruct",
    repo: "Qwen/Qwen2.5-1.5B-Instruct-GGUF",
    category: "lightweight",
    descriptionTr: "Düşük bellekli sistemlerde hızlı yanıtlar için ideal hafif genel sohbet modeli.",
    descriptionEn: "Ideal lightweight chat model for fast responses on memory-constrained systems.",
    parameters: "1.5B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 1_040_000_000,
    minRamGb: 1.8,
    tagsTr: ["Hafif", "Türkçe", "Hızlı"],
    tagsEn: ["Lightweight", "Multilingual", "Fast"],
  },
  {
    id: "phi-3.5-mini-instruct",
    name: "Phi 3.5 Mini Instruct",
    repo: "bartowski/Phi-3.5-mini-instruct-GGUF",
    category: "lightweight",
    descriptionTr: "Microsoft'un yüksek kaliteli sentetik verilerle eğittiği 128k bağlamlı akıl yürütme modeli.",
    descriptionEn: "Microsoft's reasoning model with 128k context trained on high-quality synthetic datasets.",
    parameters: "3.8B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 2_390_000_000,
    minRamGb: 3.5,
    tagsTr: ["Microsoft", "128k", "Mantık"],
    tagsEn: ["Microsoft", "128k", "Logic"],
  },
  {
    id: "gemma-2-2b-it",
    name: "Google Gemma 2 2B Instruct",
    repo: "bartowski/gemma-2-2b-it-GGUF",
    category: "lightweight",
    descriptionTr: "Google'ın kompakt cihazlar için optimize edilmiş hafif ve akıllı modeli.",
    descriptionEn: "Google's smart and lightweight model optimized for compact devices.",
    parameters: "2.6B",
    contextLength: 8192,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 1_710_000_000,
    minRamGb: 2.5,
    tagsTr: ["Google", "Kompakt", "Hafif"],
    tagsEn: ["Google", "Compact", "Lightweight"],
  },
  {
    id: "smollm2-1.7b-instruct",
    name: "SmolLM2 1.7B Instruct",
    repo: "bartowski/SmolLM2-1.7B-Instruct-GGUF",
    category: "lightweight",
    descriptionTr: "Hugging Face tarafından mobil ve yerel cihazlar için özel tasarlanmış ultra verimli model.",
    descriptionEn: "Ultra-efficient model by Hugging Face specifically crafted for on-device and local tasks.",
    parameters: "1.7B",
    contextLength: 8192,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 1_080_000_000,
    minRamGb: 1.8,
    tagsTr: ["Hugging Face", "Mobil/Laptop", "Verimli"],
    tagsEn: ["Hugging Face", "Mobile/Laptop", "Efficient"],
  },

  // -- Büyük & İleri Düzey (Large & High Power) ------------------------------
  {
    id: "qwen2.5-14b-instruct",
    name: "Qwen 2.5 14B Instruct",
    repo: "bartowski/Qwen2.5-14B-Instruct-GGUF",
    category: "large",
    descriptionTr: "Geniş parametre kapasitesiyle derin analiz, karmaşık metin yazımı ve üstün zeka.",
    descriptionEn: "High-capacity parameter scaling for deep analysis, nuanced prose, and advanced intellect.",
    parameters: "14.8B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 8_990_000_000,
    minRamGb: 11.5,
    tagsTr: ["Yüksek Zekâ", "128k", "Geniş Bilgi"],
    tagsEn: ["High Intelligence", "128k", "Broad Knowledge"],
  },
  {
    id: "qwen2.5-32b-instruct",
    name: "Qwen 2.5 32B Instruct",
    repo: "bartowski/Qwen2.5-32B-Instruct-GGUF",
    category: "large",
    descriptionTr: "Ticari seviyede açık kaynaklı en iyi modellerden biri; 32B boyutuyla GPT-4 sınıfı performans.",
    descriptionEn: "One of the absolute best open-source models available; 32B scale with GPT-4 class capabilities.",
    parameters: "32.8B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 19_800_000_000,
    minRamGb: 24.0,
    tagsTr: ["En Üst Düzey", "GPT-4 Sınıfı", "Geniş Sistem"],
    tagsEn: ["Flagship Scale", "GPT-4 Class", "High-End"],
  },
  {
    id: "phi-4-14b",
    name: "Microsoft Phi-4 14B",
    repo: "bartowski/phi-4-GGUF",
    category: "large",
    descriptionTr: "Microsoft'un matematik, bilim ve akıl yürütme kıyaslamalarında rekor kıran son nesil modeli.",
    descriptionEn: "Microsoft's cutting-edge model breaking benchmarks in mathematics, science, and complex reasoning.",
    parameters: "14.7B",
    contextLength: 16384,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 9_130_000_000,
    minRamGb: 11.5,
    tagsTr: ["Microsoft", "Matematik", "Son Nesil"],
    tagsEn: ["Microsoft", "Math", "State of the Art"],
  },
  {
    id: "mistral-small-24b-instruct",
    name: "Mistral Small 24B Instruct",
    repo: "bartowski/Mistral-Small-24B-Instruct-2501-GGUF",
    category: "large",
    descriptionTr: "Mistral AI'ın kurumsal sınıf akıl yürütme, çok dillilik ve hızlı üretim sunan yeni 24B modeli.",
    descriptionEn: "Mistral AI's new 24B model offering enterprise-grade reasoning, multilingualism, and fast inference.",
    parameters: "24.0B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 14_500_000_000,
    minRamGb: 18.0,
    tagsTr: ["Mistral AI", "Kurumsal", "Güçlü"],
    tagsEn: ["Mistral AI", "Enterprise", "Powerful"],
  },
  {
    id: "llama-3.3-70b-instruct",
    name: "Meta Llama 3.3 70B Instruct",
    repo: "bartowski/Llama-3.3-70B-Instruct-GGUF",
    category: "large",
    descriptionTr: "Açık kaynak dünyasının en yetenekli dev amiral gemisi; 70B parametre ve 128k bağlam.",
    descriptionEn: "The premier open-weights flagship giant; 70B parameters and 128k context window.",
    parameters: "70.6B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 42_500_000_000,
    minRamGb: 48.0,
    tagsTr: ["Amiral Gemisi", "Dev Model", "128k"],
    tagsEn: ["Flagship Giant", "Massive", "128k"],
  },

  // -- Görsel & Çok Modlu (Multimodal / Vision) ------------------------------
  {
    id: "qwen2-vl-7b-instruct",
    name: "Qwen 2 VL 7B Instruct",
    repo: "bartowski/Qwen2-VL-7B-Instruct-GGUF",
    category: "vision",
    descriptionTr: "Görselleri anlama, belge ve grafik okuma, OCR ve çok modlu görsel sohbet.",
    descriptionEn: "Visual comprehension, document & chart analysis, OCR, and multimodal image chat.",
    parameters: "7.6B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_680_000_000,
    minRamGb: 6.5,
    tagsTr: ["Görsel Anlama", "OCR", "Çok Modlu"],
    tagsEn: ["Vision", "OCR", "Multimodal"],
    needsProjector: true,
  },
  {
    id: "llama-3.2-11b-vision-instruct",
    name: "Llama 3.2 11B Vision Instruct",
    repo: "leafspark/Llama-3.2-11B-Vision-Instruct-GGUF",
    category: "vision",
    descriptionTr: "Meta'nın görsel analizi ve metin üretimini bir araya getiren güçlü çok modlu modeli.",
    descriptionEn: "Meta's powerful multimodal model combining visual scene analysis and text generation.",
    parameters: "11.0B",
    contextLength: 131072,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 5_963_057_216,
    minRamGb: 9.5,
    tagsTr: ["Meta Vision", "Görsel + Metin", "128k"],
    tagsEn: ["Meta Vision", "Vision + Text", "128k"],
    needsProjector: true,
  },
  {
    id: "minicpm-v-2_6",
    name: "MiniCPM-V 2.6",
    repo: "bartowski/MiniCPM-V-2_6-gguf",
    category: "vision",
    descriptionTr: "GPT-4V kalitesinde tek kare ve video anlama yeteneği sunan kompakt görsel model.",
    descriptionEn: "Compact vision-language model offering GPT-4V caliber single-image and video understanding.",
    parameters: "8.0B",
    contextLength: 32768,
    preferredQuant: "Q4_K_M",
    approxSizeBytes: 4_681_089_792,
    minRamGb: 7.0,
    tagsTr: ["GPT-4V Benzeri", "Yüksek Çözünürlük"],
    tagsEn: ["GPT-4V Class", "High Resolution"],
    needsProjector: true,
  },

  // -- Gömme & Bilgi Tabanı (Embeddings & RAG) -------------------------------
  {
    id: "nomic-embed-text-v1.5",
    name: "Nomic Embed Text v1.5",
    repo: "nomic-ai/nomic-embed-text-v1.5-GGUF",
    category: "embedding",
    descriptionTr: "Bilgi tabanı (RAG) ve anlamsal belge araması için 8192 bağlamlı optimize edilmiş gömme modeli.",
    descriptionEn: "Optimized embedding model with 8192 context length for knowledge base (RAG) and semantic document retrieval.",
    parameters: "137M",
    contextLength: 8192,
    preferredQuant: "Q8_0",
    approxSizeBytes: 150_000_000,
    minRamGb: 0.5,
    tagsTr: ["Bilgi Tabanı", "RAG", "8k Bağlam", "Hızlı"],
    tagsEn: ["Knowledge Base", "RAG", "8k Context", "Fast"],
    isEmbedding: true,
  },
  {
    id: "bge-m3-multilingual",
    name: "BGE-M3 Multilingual Embed",
    repo: "gpustack/bge-m3-GGUF",
    category: "embedding",
    descriptionTr: "100'den fazla dilde (özellikle Türkçe) yoğun ve seyrek hibrit arama sunan en güçlü gömme modeli.",
    descriptionEn: "Top-tier embedding model supporting dense, sparse, and hybrid retrieval across 100+ languages.",
    parameters: "567M",
    contextLength: 8192,
    preferredQuant: "Q8_0",
    approxSizeBytes: 600_000_000,
    minRamGb: 1.0,
    tagsTr: ["Çok Dilli", "Türkçe Gömme", "Hibrit Arama"],
    tagsEn: ["Multilingual", "Hybrid Retrieval", "Dense+Sparse"],
    isEmbedding: true,
  },
  {
    id: "multilingual-e5-large",
    name: "Multilingual E5 Large",
    repo: "cstr/multilingual-e5-large-GGUF",
    category: "embedding",
    descriptionTr: "Çok dilli anlamsal benzerlik ve belge eşleştirmede yüksek doğruluklu gömme modeli.",
    descriptionEn: "High-accuracy embedding model for multilingual semantic similarity and document matching.",
    parameters: "560M",
    contextLength: 512,
    preferredQuant: "Q8_0",
    approxSizeBytes: 600_000_000,
    minRamGb: 1.0,
    tagsTr: ["Çok Dilli", "Anlamsal Benzerlik"],
    tagsEn: ["Multilingual", "Semantic Similarity"],
    isEmbedding: true,
  },
  {
    id: "bge-large-en-v1.5",
    name: "BGE Large EN v1.5",
    repo: "CompendiumLabs/bge-large-en-v1.5-gguf",
    category: "embedding",
    descriptionTr: "İngilizce teknik dokümanlar, makaleler ve bilgi tabanı için optimize edilmiş gömme modeli.",
    descriptionEn: "Optimized embedding model for English technical documents, manuals, and knowledge retrieval.",
    parameters: "335M",
    contextLength: 512,
    preferredQuant: "Q8_0",
    approxSizeBytes: 360_000_000,
    minRamGb: 0.8,
    tagsTr: ["İngilizce RAG", "Yüksek Başarım"],
    tagsEn: ["English RAG", "High Accuracy"],
    isEmbedding: true,
  },
];

export function getCatalog(lang: "tr" | "en" = "tr", freeBudgetMb = 8192): CatalogModelResponse[] {
  return CATALOG_MODELS.map((item) => {
    // Projektor de bellege giriyor; saymamak gorsel modelleri oldugundan
    // kucuk gosterirdi. Kaba bir pay yeterli: kesin sayi indirme aninda
    // Hugging Face'ten geliyor.
    const totalBytes = item.approxSizeBytes + (item.needsProjector ? 1_000_000_000 : 0);
    const estimatedMb = Math.round((totalBytes / (1024 * 1024)) * 1.2);
    const fits = freeBudgetMb >= estimatedMb;
    const gb = (estimatedMb / 1024).toFixed(1);
    const freeGb = (freeBudgetMb / 1024).toFixed(1);
    const fitsReason =
      lang === "tr"
        ? fits
          ? `Sisteminizde akıcı çalışır (~${gb} GB bellek)`
          : `Yüksek bellek gerektirir (~${gb} GB bellek, boşta ~${freeGb} GB)`
        : fits
          ? `Runs smoothly on your system (~${gb} GB RAM)`
          : `Requires high memory (~${gb} GB RAM, ~${freeGb} GB free)`;

    const { descriptionTr, descriptionEn, tagsTr, tagsEn, ...rest } = item;
    return {
      ...rest,
      description: lang === "tr" ? descriptionTr : descriptionEn,
      tags: lang === "tr" ? tagsTr : tagsEn,
      isEmbedding: item.isEmbedding ?? false,
      needsProjector: item.needsProjector ?? false,
      fits,
      fitsReason,
      estimatedMb,
    };
  });
}

export function findCatalogModel(id: string): CatalogModelItem | null {
  return CATALOG_MODELS.find((item) => item.id === id) ?? null;
}

/**
 * Katalog girdisini indirilebilir gercek dosyalara cozer.
 *
 * Dosya adi, boyut, adres ve SHA256 burada, Hugging Face'in kendi dosya
 * listesinden gelir. Katalogda sabit dosya adi tutmak surdurulemezdi: depo
 * sahipleri dosyalari yeniden adlandiriyor, parcaliyor, siliyor. Elle
 * yazilan 33 girdinin 9'u bir noktada 404 veriyordu ve bunu ancak kullanici
 * indirmeye basinca ogreniyorduk. Artik sabit olan tek sey depo kimligi;
 * depo da tasinirsa hata indirme baslamadan once ve anlasilir cikiyor.
 */
export async function resolveCatalogModel(
  id: string,
  budgetMb: number,
): Promise<ResolvedCatalogModel> {
  const item = findCatalogModel(id);
  if (!item) throw new CatalogResolveError(`Katalogda böyle bir model yok: ${id}`);

  let detail: HfModelDetail;
  try {
    detail = await getModelDetail(item.repo);
  } catch (err) {
    throw new CatalogResolveError(
      `${item.name} deposu okunamadı (${item.repo}): ${(err as Error).message}`,
    );
  }

  if (detail.files.length === 0) {
    throw new CatalogResolveError(
      `${item.name} deposunda tek dosyalık GGUF bulunamadı (${item.repo}).`,
    );
  }

  // Tercih edilen nicemleme varsa o, yoksa butceye sigan en iyisi. Tercih
  // bir istekten ibaret: depo o nicemlemeyi birakmis olabilir.
  const wanted = item.preferredQuant.toLowerCase();
  const preferred = detail.files.find((file) =>
    file.path.toLowerCase().includes(wanted),
  );
  const chosen = preferred ?? pickBestFit(detail.files, budgetMb) ?? detail.files[0];
  if (!chosen) throw new CatalogResolveError(`${item.name} için dosya seçilemedi.`);

  if (item.needsProjector && !detail.projector) {
    throw new CatalogResolveError(
      `${item.name} görsel bir model ama deposunda mmproj dosyası yok (${item.repo}).`,
    );
  }

  return {
    id: item.id,
    model: toResolved(chosen),
    projector: detail.projector ? toResolved(detail.projector) : null,
  };
}

function toResolved(file: HfFile): ResolvedFile {
  return {
    filename: file.path.split("/").pop() ?? file.path,
    downloadUrl: file.downloadUrl,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
  };
}
