import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useChat } from "../../stores/chat";
import { useUi } from "../../stores/ui";

export function ConversationList() {
  const t = useUi((s) => s.t);
  const { conversations, activeId, openConversation, newConversation, removeConversation } =
    useChat();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Array<{ conversationId: string; snippet: string }>>([]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      return;
    }
    // Yazarken her tuşta istek atmamak için kısa gecikme.
    const timer = setTimeout(() => {
      void api
        .search(trimmed)
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const matched = new Set(hits.map((hit) => hit.conversationId));
  const visible = query.trim()
    ? conversations.filter((conversation) => matched.has(conversation.id))
    : conversations;

  return (
    <aside className="conversations">
      <button type="button" className="button button--block" onClick={newConversation}>
        {t("chat.new")}
      </button>

      <input
        className="input input--compact"
        type="search"
        value={query}
        placeholder={t("chat.search")}
        onChange={(event) => setQuery(event.target.value)}
      />

      <ul className="conversations__list">
        {visible.length === 0 && (
          <li className="conversations__empty">
            {query.trim() ? t("chat.noResults") : t("chat.noConversations")}
          </li>
        )}
        {visible.map((conversation) => (
          <li key={conversation.id} className="conversations__item">
            <button
              type="button"
              className="conversations__open"
              aria-current={conversation.id === activeId ? "true" : undefined}
              onClick={() => void openConversation(conversation.id)}
            >
              <span className="conversations__title">
                {conversation.title || t("chat.untitled")}
              </span>
              <span className="conversations__meta">
                {conversation.model || conversation.provider}
              </span>
            </button>
            <button
              type="button"
              className="conversations__delete"
              aria-label={t("chat.delete")}
              title={t("chat.delete")}
              onClick={() => void removeConversation(conversation.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
