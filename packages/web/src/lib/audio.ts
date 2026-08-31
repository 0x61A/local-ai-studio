/**
 * Ses dönüştürme tarayıcıda yapılır.
 *
 * whisper.cpp 16 kHz mono WAV bekler; mikrofon kaydı ise webm/opus gelir.
 * Sunucuya ffmpeg koymak sıfır-kurulum vaadini bozardı -- oysa tarayıcı
 * mp3, m4a, ogg, webm, flac hepsini zaten çözebiliyor. Kodek olarak
 * tarayıcıyı kullanmak hem bedava hem taşınabilir.
 */

const TARGET_SAMPLE_RATE = 16000;

export async function toWav16k(input: Blob): Promise<Uint8Array> {
  const raw = await input.arrayBuffer();
  if (raw.byteLength === 0) throw new Error("Ses verisi boş.");

  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(raw);
  } catch {
    throw new Error("Ses dosyası çözülemedi. Desteklenmeyen bir biçim olabilir.");
  } finally {
    void context.close();
  }

  // Tek kanallı hedef bağlam çok kanallı kaydı kendisi karıştırır.
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();

  return encodeWav(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
}

/** 16-bit PCM, tek kanal, 44 baytlık standart RIFF başlığı. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // PCM alt parça boyu
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // kanal
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bayt/saniye
  view.setUint16(32, 2, true); // blok hizası
  view.setUint16(34, 16, true); // bit/örnek
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    // Kırpma şart: rendering hafifçe 1'i aşabilir ve taşan değer
    // 16-bit'e çevrilirken işaret değiştirip cızırtı üretir.
    const clamped = Math.max(-1, Math.min(1, samples[index] as number));
    view.setInt16(44 + index * 2, Math.round(clamped * 32767), true);
  }
  return bytes;
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

/** Uint8Array -> base64. Büyük dizide tek seferde spread yığını taşırır. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let at = 0; at < bytes.length; at += step) {
    binary += String.fromCharCode(...bytes.subarray(at, at + step));
  }
  return btoa(binary);
}
