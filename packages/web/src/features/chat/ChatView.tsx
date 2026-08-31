import { useEffect, useMemo, useRef, useState } from "react";
import { useChat } from "../../stores/chat";
import { useKnowledge } from "../../stores/knowledge";
import { useModels } from "../../stores/models";
import { useUi } from "../../stores/ui";
import { SourceList } from "../knowledge/SourceList";
import type { KnowledgeCollection } from "../../lib/api";

/**
 * Sabit boş dizi. Seçicinin her çağrıda yeni `[]` döndürmesi zustand'in
 * referans karşılaştırmasını her seferinde yanıltır ve sonsuz render
 * döngüsü açar.
 */
const NO_COLLECTIONS: KnowledgeCollection[] = [];
import { ConversationList } from "./ConversationList";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";

export function ChatView() {
  const t = useUi((s) => s.t);
  const {
    messages, sending, error, usage, sources, sourceError, collectionId,
    send, stop, loadConversations, setCollection,
  } = useChat();
  const { engine, providers, providerModels, refresh, loadProviderModels } = useModels();
  const collections = useKnowledge((s) => s.overview?.collections ?? NO_COLLECTIONS);
  const refreshKnowledge = useKnowledge((s) => s.refresh);

  const [provider, setProvider] = useState("llamacpp");
  const [model, setModel] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadConversations();
    void refresh();
    void refreshKnowledge();
  }, [loadConversations, refresh, refreshKnowledge]);

  useEffect(() => {
    void loadProviderModels(provider);
  }, [provider, loadProviderModels]);

  // Yerel motor için model adı llama-server tarafından yoksayılır ama
  // boş bırakılamaz; yüklü modelin adını kullanırız.
  const options = useMemo(() => {
    if (provider === "llamacpp") {
      return engine?.state === "ready" ? [{ id: engine.model, label: engine.model }] : [];
    }
    return (providerModels[provider] ?? []).map((m) => ({ id: m.id, label: m.label }));
  }, [provider, providerModels, engine]);

  useEffect(() => {
    if (options.length > 0 && !options.some((o) => o.id === model)) {
      setModel(options[0]!.id);
    }
    if (options.length === 0 && model) setModel("");
  }, [options, model]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages]);

  const ready = Boolean(model);
  const blockedReason =
    provider === "llamacpp" && engine?.state !== "ready"
      ? t("chat.loadModelFirst")
      : options.length === 0
        ? t("chat.noModels")
        : null;

  return (
    <div className="chat">
      <ConversationList />

      <div className="chat__main">
        <header className="chat__bar">
          <label className="field field--inline">
            <span className="field__label">{t("chat.provider")}</span>
            <select
              className="input input--compact"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              {providers.map((item) => (
                <option key={item.id} value={item.id} disabled={!item.hasKey}>
                  {item.label}
                  {item.hasKey ? "" : ` — ${t("chat.needsKey")}`}
                </option>
              ))}
            </select>
          </label>

          <label className="field field--inline field--grow">
            <span className="field__label">{t("chat.model")}</span>
            <select
              className="input input--compact"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={options.length === 0}
            >
              {options.length === 0 && <option value="">{t("chat.noModels")}</option>}
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          {collections.length > 0 && (
            <label className="field field--inline">
              <span className="field__label">{t("chat.knowledge")}</span>
              <select
                className="input input--compact"
                value={collectionId ?? ""}
                onChange={(event) => setCollection(event.target.value || null)}
              >
                <option value="">{t("chat.noKnowledge")}</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {usage && (
            <span className="chat__usage" title={t("chat.usageTitle")}>
              {usage.promptTokens} + {usage.completionTokens}
            </span>
          )}
        </header>

        <div className="chat__scroll">
          {messages.length === 0 && !blockedReason && (
            <p className="chat__empty">{t("chat.empty")}</p>
          )}
          {blockedReason && <p className="chat__empty">{blockedReason}</p>}
          <MessageList messages={messages} />
          {sourceError && <p className="chat__error" role="alert">{sourceError}</p>}
          {sources.length > 0 && (
            <details className="chat__sources">
              <summary>{t("chat.sourcesUsed", { n: sources.length })}</summary>
              <SourceList sources={sources} />
            </details>
          )}
          {error && <p className="chat__error" role="alert">{error}</p>}
          <div ref={bottomRef} />
        </div>

        <Composer
          disabled={!ready}
          sending={sending}
          onSend={(text) => void send(text, { provider, model })}
          onStop={stop}
        />
      </div>
    </div>
  );
}
