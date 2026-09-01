import { describe, expect, it } from "vitest";
import {
  parseCpuinfoPhysicalCores,
  parseMemAvailableMb,
  parseNvidiaSmi,
  parseWindowsGpu,
} from "../src/hardware/detect.js";
import { describeExit, parseTasklistImage } from "../src/engines/supervisor.js";
import {
  buildEspeakArgs,
  parseEspeakVoices,
  parsePipeVoices,
  sapiRate,
} from "../src/audio/tts.js";

/**
 * Faz 6: Windows ve Linux dallarinin ayristiricilari. Bu kodun cogu
 * gelistirme makinesinde (macOS) hic calismaz -- dogru davrandigini
 * gosterecek tek sey gercek cikti orneklerine karsi yazilmis testler.
 */

describe("nvidia-smi", () => {
  it("ad, toplam ve bos VRAM'i okur", () => {
    const parsed = parseNvidiaSmi("NVIDIA GeForce RTX 4070, 12282, 11534\n");
    expect(parsed).toEqual({
      name: "NVIDIA GeForce RTX 4070",
      vramTotalMb: 12282,
      vramFreeMb: 11534,
    });
  });

  it("çoklu GPU'da ilk kartı alır", () => {
    const parsed = parseNvidiaSmi("NVIDIA A100, 40960, 40000\nNVIDIA A100, 40960, 512\n");
    expect(parsed?.vramFreeMb).toBe(40000);
  });

  it("araç yoksa (boş çıktı) null döner", () => {
    expect(parseNvidiaSmi("")).toBeNull();
  });

  it("beklenmedik biçimi yutmaz", () => {
    expect(parseNvidiaSmi("Failed to initialize NVML\n")).toBeNull();
  });
});

describe("Windows GPU (Win32_VideoController)", () => {
  it("adı ve VRAM'i okur", () => {
    expect(parseWindowsGpu("Intel(R) Arc(TM) A380|2147483648\n")).toEqual({
      name: "Intel(R) Arc(TM) A380",
      vramTotalMb: 2048,
    });
  });

  it("32 bitte kırpılmış 4 GB değerine güvenmez", () => {
    // AdapterRAM uint32; 8 GB kart da 4294967295 bildirir. Yanlış bir VRAM
    // sayısı katman planını bozar, bilinmiyor demek daha güvenli.
    expect(parseWindowsGpu("NVIDIA GeForce RTX 3070|4294967295")?.vramTotalMb).toBe(0);
  });

  it("adında boru işareti olan kartı bozmaz", () => {
    expect(parseWindowsGpu("Acme GPU | Pro|1073741824")).toEqual({
      name: "Acme GPU | Pro",
      vramTotalMb: 1024,
    });
  });

  it("boş çıktıda null döner", () => {
    expect(parseWindowsGpu("")).toBeNull();
  });
});

describe("/proc/meminfo", () => {
  const SAMPLE = `MemTotal:       32695420 kB
MemFree:          812304 kB
MemAvailable:   18446744 kB
Buffers:          195012 kB
`;

  it("MemAvailable'ı MB'a çevirir", () => {
    expect(parseMemAvailableMb(SAMPLE)).toBe(18014);
  });

  it("MemFree ile karıştırmaz", () => {
    expect(parseMemAvailableMb(SAMPLE)).not.toBe(793);
  });

  it("alan yoksa null döner", () => {
    expect(parseMemAvailableMb("MemTotal: 100 kB\n")).toBeNull();
  });
});

describe("/proc/cpuinfo", () => {
  it("hyper-threading'de fiziksel çekirdeği sayar", () => {
    // İki mantıksal, tek fiziksel çekirdek.
    const sample = `processor\t: 0
physical id\t: 0
core id\t\t: 0
cpu cores\t: 1

processor\t: 1
physical id\t: 0
core id\t\t: 0
cpu cores\t: 1
`;
    expect(parseCpuinfoPhysicalCores(sample)).toBe(1);
  });

  it("iki yuvayı ayrı sayar", () => {
    const sample = `physical id\t: 0
core id\t\t: 0

physical id\t: 1
core id\t\t: 0
`;
    expect(parseCpuinfoPhysicalCores(sample)).toBe(2);
  });

  it("ARM'de alanlar yoksa cpu cores satırına düşer", () => {
    expect(parseCpuinfoPhysicalCores("processor\t: 0\ncpu cores\t: 4\n")).toBe(4);
  });

  it("hiçbiri yoksa null döner", () => {
    expect(parseCpuinfoPhysicalCores("processor\t: 0\n")).toBeNull();
  });
});

describe("tasklist", () => {
  it("imaj adını okur", () => {
    const output = '"llama-server.exe","4242","Console","1","1.245.000 K"\n';
    expect(parseTasklistImage(output)).toBe("llama-server.exe");
  });

  it("süreç yoksa null döner", () => {
    expect(parseTasklistImage("INFO: No tasks are running which match.\n")).toBeNull();
  });
});

describe("çıkış kodu teşhisi", () => {
  it("Windows'ta eksik DLL'i CUDA kurulumuna bağlar", () => {
    const message = describeExit("C:\\x\\llama-server.exe", 3221225781, null);
    expect(message).toContain("DLL");
    expect(message).toContain("cudart");
  });

  it("mimari uyuşmazlığını ayırt eder", () => {
    expect(describeExit("C:\\x\\sd-server.exe", 3221225595, null)).toContain("uyumsuz");
  });

  it("ikili adını Windows yolundan da çıkarır", () => {
    expect(describeExit("C:\\Users\\a\\llama-server.exe", 1, null)).toContain(
      "llama-server.exe",
    );
  });
});

describe("SAPI sesleri (Windows)", () => {
  it("ad, yerel ayar ve açıklamayı ayırır", () => {
    const output = "Microsoft Tolga|tr-TR|Male, Adult\nMicrosoft Zira|en-US|Female, Adult\n";
    expect(parsePipeVoices(output)).toEqual([
      { name: "Microsoft Tolga", locale: "tr-TR", sample: "Male, Adult" },
      { name: "Microsoft Zira", locale: "en-US", sample: "Female, Adult" },
    ]);
  });

  it("eksik satırı atlar", () => {
    expect(parsePipeVoices("bozuk satır\n")).toEqual([]);
  });

  it("kelime/dakikayı SAPI'nin -10..10 aralığına çevirir", () => {
    expect(sapiRate(175)).toBe(0);
    expect(sapiRate(350)).toBe(10);
    expect(sapiRate(80)).toBe(-5);
    // Aralık dışına taşmaz: SAPI 10'dan büyük değeri reddeder.
    expect(sapiRate(5000)).toBe(10);
    expect(sapiRate(1)).toBe(-10);
  });
});

describe("espeak-ng (Linux)", () => {
  const SAMPLE = `Pty Language Age/Gender VoiceName          File                 Other Languages
 5  tr             --/M      turkish            gmw/tr
 5  en-gb          --/M      english            gmw/en
bozuk satır
`;

  it("başlık satırını atlar, sesleri okur", () => {
    const voices = parseEspeakVoices(SAMPLE);
    expect(voices).toHaveLength(2);
    expect(voices[0]).toMatchObject({ name: "turkish", locale: "tr" });
    expect(voices[1]).toMatchObject({ name: "english", locale: "en-gb" });
  });

  it("metni argüman olarak değil dosyadan verir", () => {
    const args = buildEspeakArgs("/tmp/metin.txt", "/tmp/ses.wav", "turkish", 200);
    expect(args).toContain("-f");
    expect(args).toContain("/tmp/metin.txt");
    expect(args.join(" ")).not.toContain("Merhaba");
  });

  it("ses verilmezse -v eklemez", () => {
    expect(buildEspeakArgs("/tmp/a.txt", "/tmp/b.wav", null)).not.toContain("-v");
  });

  it("aralık dışı hızı yok sayar", () => {
    expect(buildEspeakArgs("/tmp/a.txt", "/tmp/b.wav", null, 9000)).not.toContain("-s");
  });
});
