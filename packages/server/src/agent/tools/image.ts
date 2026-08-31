import { z } from "zod";
import { loadedImageModel, sdBaseUrl } from "../../engines/sd.js";
import { startGeneration } from "../../images/generate.js";
import { defineTool, type Tool, type ToolResult } from "../types.js";

/**
 * Görsel üretimi ajana açılır.
 *
 * Risk `write`: dosya üretir, hızlandırıcıyı dakikalarca meşgul eder ve
 * istemi bir web sayfasından gelmiş olabilir. Onay kartı istemi olduğu
 * gibi gösterir -- kullanıcı neyin çizileceğini görmeden onaylamaz.
 */

export const generateImage: Tool<{
  prompt: string;
  negativePrompt?: string;
  width?: number;
  height?: number;
  steps?: number;
  count?: number;
}> = defineTool({
  name: "generate_image",
  description:
    "Metinden görsel üretir (yerel stable-diffusion.cpp). Üretilen görsel galeriye kaydedilir.",
  risk: "write",
  schema: z.object({
    prompt: z.string().min(1).max(2000).describe("Görselin İngilizce istemi"),
    negativePrompt: z.string().max(2000).optional().describe("İstenmeyen ögeler"),
    width: z.number().int().min(64).max(1024).optional(),
    height: z.number().int().min(64).max(1024).optional(),
    steps: z.number().int().min(1).max(60).optional(),
    count: z.number().int().min(1).max(4).optional().describe("Kaç görsel"),
  }),
  async run(input, context): Promise<ToolResult> {
    if (!sdBaseUrl()) {
      return {
        content:
          "Görsel motoru çalışmıyor. Kullanıcının Görsel sekmesinden bir model yüklemesi gerekiyor.",
        isError: true,
      };
    }

    const count = input.count ?? 1;
    const approved = await context.requestApproval({
      toolName: "generate_image",
      risk: "write",
      summary: `${count} görsel üret (${input.width ?? 512}x${input.height ?? 512}, ${loadedImageModel() ?? "?"})`,
      command: input.prompt,
      arguments: input,
    });
    if (!approved) {
      return { content: "Kullanıcı görsel üretimini reddetti.", isError: true };
    }

    const { done } = startGeneration({
      prompt: input.prompt,
      negativePrompt: input.negativePrompt ?? "",
      width: input.width ?? 512,
      height: input.height ?? 512,
      seed: -1,
      batchCount: count,
      sampling: { steps: input.steps ?? 20, cfgScale: 7 },
    });

    const images = await done;
    if (!images.length) {
      return { content: "Görsel üretilemedi; motor hata verdi.", isError: true };
    }
    return {
      content: images
        .map(
          (image) =>
            `Üretildi: ${image.filename} (${image.width}x${image.height}, tohum ${image.seed})`,
        )
        .join("\n"),
      detail: {
        images: images.map((image) => ({
          id: image.id,
          filename: image.filename,
          seed: image.seed,
        })),
      },
    };
  },
});

export const imageTools = [generateImage];
