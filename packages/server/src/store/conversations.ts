import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { all, db, one, run } from "./db.js";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export interface StoredMessage {
  id: string;
  role: MessageRole;
  content: string;
  reasoning: string;
  createdAt: number;
  seq: number;
}

export interface StoredConversation {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  tags: string[];
}

interface ConversationRow {
  id: string;
  title: string;
  provider: string;
  model: string;
  created_at: number;
  updated_at: number;
  archived: number;
}

interface MessageRow {
  id: string;
  role: string;
  content: string;
  reasoning: string;
  created_at: number;
  seq: number;
}

export function createConversation(
  input: { title?: string; provider?: string; model?: string } = {},
  database: DatabaseSync = db(),
): StoredConversation {
  const now = Date.now();
  const id = crypto.randomUUID();
  run(
    database,
    `INSERT INTO conversations(id, title, provider, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.title ?? "",
    input.provider ?? "",
    input.model ?? "",
    now,
    now,
  );
  return {
    id,
    title: input.title ?? "",
    provider: input.provider ?? "",
    model: input.model ?? "",
    createdAt: now,
    updatedAt: now,
    archived: false,
    tags: [],
  };
}

export function getConversation(
  id: string,
  database: DatabaseSync = db(),
): StoredConversation | null {
  const row = one<ConversationRow>(
    database,
    "SELECT * FROM conversations WHERE id = ?",
    id,
  );
  return row ? toConversation(row, listTags(id, database)) : null;
}

export function listConversations(
  options: { includeArchived?: boolean; limit?: number } = {},
  database: DatabaseSync = db(),
): StoredConversation[] {
  const limit = Math.max(1, Math.min(500, options.limit ?? 100));
  const rows = all<ConversationRow>(
    database,
    `SELECT * FROM conversations
     WHERE (? = 1 OR archived = 0)
     ORDER BY updated_at DESC LIMIT ?`,
    options.includeArchived ? 1 : 0,
    limit,
  );
  return rows.map((row) => toConversation(row, listTags(row.id, database)));
}

export function updateConversation(
  id: string,
  patch: { title?: string; provider?: string; model?: string; archived?: boolean },
  database: DatabaseSync = db(),
): void {
  const current = one<ConversationRow>(
    database,
    "SELECT * FROM conversations WHERE id = ?",
    id,
  );
  if (!current) return;
  run(
    database,
    `UPDATE conversations
     SET title = ?, provider = ?, model = ?, archived = ?, updated_at = ?
     WHERE id = ?`,
    patch.title ?? current.title,
    patch.provider ?? current.provider,
    patch.model ?? current.model,
    patch.archived === undefined ? current.archived : patch.archived ? 1 : 0,
    Date.now(),
    id,
  );
}

export function deleteConversation(id: string, database: DatabaseSync = db()): void {
  // Mesajlar ve etiketler ON DELETE CASCADE ile gider; FTS tetikleyicisi temizler.
  run(database, "DELETE FROM conversations WHERE id = ?", id);
}

export function appendMessage(
  conversationId: string,
  message: { role: MessageRole; content: string; reasoning?: string },
  database: DatabaseSync = db(),
): StoredMessage {
  const now = Date.now();
  const id = crypto.randomUUID();
  const next = one<{ seq: number }>(
    database,
    "SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM messages WHERE conversation_id = ?",
    conversationId,
  ) ?? { seq: 0 };

  run(
    database,
    `INSERT INTO messages(id, conversation_id, role, content, reasoning, created_at, seq)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    conversationId,
    message.role,
    message.content,
    message.reasoning ?? "",
    now,
    next.seq,
  );
  run(database, "UPDATE conversations SET updated_at = ? WHERE id = ?", now, conversationId);

  return {
    id,
    role: message.role,
    content: message.content,
    reasoning: message.reasoning ?? "",
    createdAt: now,
    seq: next.seq,
  };
}

export function listMessages(
  conversationId: string,
  database: DatabaseSync = db(),
): StoredMessage[] {
  const rows = all<MessageRow>(
    database,
    `SELECT id, role, content, reasoning, created_at, seq
     FROM messages WHERE conversation_id = ? ORDER BY seq`,
    conversationId,
  );
  return rows.map((row) => ({
    id: row.id,
    role: row.role as MessageRole,
    content: row.content,
    reasoning: row.reasoning,
    createdAt: row.created_at,
    seq: row.seq,
  }));
}

export function setTags(
  conversationId: string,
  tags: string[],
  database: DatabaseSync = db(),
): void {
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  run(database, "DELETE FROM conversation_tags WHERE conversation_id = ?", conversationId);
  for (const tag of cleaned) {
    run(
      database,
      "INSERT INTO conversation_tags(conversation_id, tag) VALUES (?, ?)",
      conversationId,
      tag,
    );
  }
}

export function listTags(
  conversationId: string,
  database: DatabaseSync = db(),
): string[] {
  const rows = all<{ tag: string }>(
    database,
    "SELECT tag FROM conversation_tags WHERE conversation_id = ? ORDER BY tag",
    conversationId,
  );
  return rows.map((row) => row.tag);
}

export interface SearchHit {
  conversationId: string;
  title: string;
  messageId: string;
  snippet: string;
  createdAt: number;
}

/**
 * Mesaj gövdelerinde tam metin arama (FTS5).
 * Kullanıcı girdisi FTS sözdizimi olarak yorumlanmaz: her sözcük tırnak
 * içine alınıp öneke çevrilir, böylece `*` veya `NEAR` gibi işleçler
 * sorguyu kıramaz.
 */
export function searchMessages(
  query: string,
  limit = 50,
  database: DatabaseSync = db(),
): SearchHit[] {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replace(/"/g, "").trim())
    .filter(Boolean)
    .map((term) => `"${term}"*`);
  if (terms.length === 0) return [];

  const rows = all<{
    message_id: string;
    conversation_id: string;
    created_at: number;
    title: string;
    snippet: string;
  }>(
    database,
    `SELECT m.id AS message_id, m.conversation_id, m.created_at,
            c.title,
            snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
     FROM messages_fts
     JOIN messages m ON m.rowid = messages_fts.rowid
     JOIN conversations c ON c.id = m.conversation_id
     WHERE messages_fts MATCH ?
     ORDER BY rank
     LIMIT ?`,
    terms.join(" "),
    Math.max(1, Math.min(200, limit)),
  );

  return rows.map((row) => ({
    conversationId: row.conversation_id,
    title: row.title,
    messageId: row.message_id,
    snippet: row.snippet,
    createdAt: row.created_at,
  }));
}

function toConversation(row: ConversationRow, tags: string[]): StoredConversation {
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: row.archived === 1,
    tags,
  };
}
