import { describe, expect, it } from "vitest";
import { encodeWav, toBase64 } from "../src/lib/audio";

describe("WAV kodlama", () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1]);
  const wav = () => encodeWav(samples, 16000);

  it("RIFF/WAVE başlığı yazar", () => {
    const bytes = wav();
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...bytes.subarray(36, 40))).toBe("data");
  });

  it("whisper'ın beklediği biçimi bildirir: 16 kHz, tek kanal, 16 bit", () => {
    const view = new DataView(wav().buffer);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // kanal
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
  });

  it("boyutlar örnek sayısıyla tutarlı", () => {
    const bytes = wav();
    const view = new DataView(bytes.buffer);
    expect(bytes.length).toBe(44 + samples.length * 2);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
  });

  it("örnekleri 16 bit'e çevirir", () => {
    const view = new DataView(wav().buffer);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(48, true)).toBe(Math.round(-0.5 * 32767));
  });

  it("1'i aşan değeri kırpar", () => {
    // Kırpmazsak taşan değer işaret değiştirip cızırtı üretir.
    const view = new DataView(encodeWav(Float32Array.from([1.4, -1.4]), 16000).buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32767);
  });

  it("boş kayıtta yalnızca başlık üretir", () => {
    expect(encodeWav(new Float32Array(0), 16000).length).toBe(44);
  });
});

describe("base64", () => {
  it("büyük diziyi yığın taşırmadan çevirir", () => {
    const big = new Uint8Array(200_000).fill(65);
    const encoded = toBase64(big);
    expect(atob(encoded).length).toBe(big.length);
  });
});
