import { useEffect, useRef, useState } from "react";
import type { ChatImage } from "../../lib/api";
import { useUi } from "../../stores/ui";

/** Tarayici dosyayi zaten okuyabiliyor; sunucuya cozucu koymaya gerek yok. */
async function toChatImage(file: File): Promise<ChatImage & { preview: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Tek seferde apply etmek buyuk dosyada yigin sinirini asar.
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const base64 = btoa(binary);
  const mimeType = file.type || "image/png";
  return { base64, mimeType, preview: `data:${mimeType};base64,${base64}` };
}

export function Composer({
  disabled,
  sending,
  canSendImages,
  onSend,
  onStop,
}: {
  disabled: boolean;
  sending: boolean;
  /** Görsel gönderilebilir mi: yüklü modelde görüntü kodlayıcı var mı. */
  canSendImages?: boolean;
  onSend: (text: string, images: ChatImage[]) => void;
  onStop: () => void;
}) {
  const t = useUi((s) => s.t);
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<ChatImage & { preview: string }>>([]);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Model değişip görsel desteği kalkarsa ekli görseller sessizce gitmesin.
  useEffect(() => {
    if (!canSendImages) setImages([]);
  }, [canSendImages]);

  const attach = async (files: FileList | null) => {
    if (!files) return;
    const picked = Array.from(files).filter((file) => file.type.startsWith("image/"));
    const loaded = await Promise.all(picked.slice(0, 4).map(toChatImage));
    setImages((prev) => [...prev, ...loaded].slice(0, 4));
  };

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || sending) return;
    onSend(trimmed, images.map(({ base64, mimeType }) => ({ base64, mimeType })));
    setText("");
    setImages([]);
    // Yüksekliği sıfırla: otomatik büyüme birikmesin.
    if (areaRef.current) areaRef.current.style.height = "auto";
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {images.length > 0 && (
        <ul className="composer__thumbs">
          {images.map((image, index) => (
            <li key={image.preview.slice(-24) + index} className="composer__thumb">
              <img src={image.preview} alt="" />
              <button
                type="button"
                className="composer__thumb-remove"
                aria-label={t("chat.removeImage")}
                onClick={() => setImages((prev) => prev.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <textarea
        ref={areaRef}
        className="composer__input"
        value={text}
        rows={1}
        placeholder={disabled ? t("chat.blockedPlaceholder") : t("chat.placeholder")}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          const element = event.target;
          element.style.height = "auto";
          element.style.height = `${Math.min(element.scrollHeight, 220)}px`;
        }}
        onKeyDown={(event) => {
          // Enter gönderir, Shift+Enter satır atlar.
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        onPaste={(event) => {
          const files = event.clipboardData?.files;
          if (files?.length && canSendImages) void attach(files);
        }}
      />

      {canSendImages && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(event) => {
              void attach(event.target.files);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            className="button button--ghost"
            disabled={disabled || images.length >= 4}
            title={t("chat.attachImage")}
            aria-label={t("chat.attachImage")}
            onClick={() => fileRef.current?.click()}
          >
            +
          </button>
        </>
      )}
      {sending ? (
        <button type="button" className="button button--ghost" onClick={onStop}>
          {t("chat.stop")}
        </button>
      ) : (
        <button type="submit" className="button" disabled={disabled || !text.trim()}>
          {t("chat.send")}
        </button>
      )}
    </form>
  );
}
