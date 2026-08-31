import { useState } from "react";
import type { DisplayMessage } from "../../stores/chat";
import { useUi } from "../../stores/ui";

export function MessageList({ messages }: { messages: DisplayMessage[] }) {
  return (
    <ol className="messages">
      {messages
        .filter((message) => message.role !== "system")
        .map((message) => (
          <Message key={message.id} message={message} />
        ))}
    </ol>
  );
}

function Message({ message }: { message: DisplayMessage }) {
  const t = useUi((s) => s.t);
  const [showReasoning, setShowReasoning] = useState(false);
  const isUser = message.role === "user";

  return (
    <li className={`message message--${isUser ? "user" : "assistant"}`}>
      <span className="message__role">
        {isUser ? t("chat.you") : t("chat.assistant")}
      </span>

      {message.reasoning && (
        <div className="message__reasoning">
          <button
            type="button"
            className="message__reasoning-toggle"
            onClick={() => setShowReasoning((value) => !value)}
            aria-expanded={showReasoning}
          >
            {showReasoning ? "▾" : "▸"} {t("chat.reasoning")}
          </button>
          {showReasoning && <pre className="message__reasoning-body">{message.reasoning}</pre>}
        </div>
      )}

      <div className="message__body">
        {message.content}
        {message.streaming && <span className="message__caret" aria-hidden="true" />}
      </div>
    </li>
  );
}
