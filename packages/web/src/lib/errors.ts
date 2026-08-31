import { ApiRequestError } from "./api";
import { useUi } from "../stores/ui";

/**
 * Sunucu hata kodunu yerelleştirilmiş metne çevirir.
 * Sunucu i18n yapmaz: kod gönderir, dil seçimi istemcide olur.
 * Bilinmeyen kod için sunucunun kendi mesajı gösterilir.
 */
export function describeError(error: unknown): string {
  const t = useUi.getState().t;
  if (error instanceof ApiRequestError) {
    const localized = t(`error.${error.code}`);
    return localized === `error.${error.code}` ? error.message : localized;
  }
  if (error instanceof Error) return error.message;
  return t("error.internal_error");
}
