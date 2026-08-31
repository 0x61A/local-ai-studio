import { useRef, useState } from "react";
import { useUi } from "../../stores/ui";

export function Composer({
  disabled,
  sending,
  onSend,
  onStop,
}: {
  disabled: boolean;
  sending: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const t = useUi((s) => s.t);
  const [text, setText] = useState("");
  const areaRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || sending) return;
    onSend(trimmed);
    setText("");
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
      />
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
