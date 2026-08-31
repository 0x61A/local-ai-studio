import { z } from "zod";
import { HttpError } from "../http/errors.js";
import type { Router } from "../http/router.js";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  listMessages,
  searchMessages,
  setTags,
  updateConversation,
} from "../store/conversations.js";

const CreateBody = z.object({
  title: z.string().max(300).optional(),
  provider: z.string().max(50).optional(),
  model: z.string().max(200).optional(),
});

const UpdateBody = z.object({
  title: z.string().max(300).optional(),
  archived: z.boolean().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export function registerConversationRoutes(router: Router): void {
  router.get(
    "/api/conversations",
    { query: z.object({ archived: z.string().optional() }) },
    ({ query }) =>
      listConversations({ includeArchived: query.archived === "1" }),
  );

  router.post("/api/conversations", { body: CreateBody }, ({ body }) =>
    createConversation(body),
  );

  router.get("/api/conversations/:id", {}, ({ params }) => {
    const id = params["id"] as string;
    const conversation = getConversation(id);
    if (!conversation) throw HttpError.notFound("Konuşma bulunamadı.");
    return { conversation, messages: listMessages(id) };
  });

  router.post("/api/conversations/:id", { body: UpdateBody }, ({ params, body }) => {
    const id = params["id"] as string;
    if (!getConversation(id)) throw HttpError.notFound("Konuşma bulunamadı.");
    const { tags, ...patch } = body;
    updateConversation(id, patch);
    if (tags) setTags(id, tags);
    return getConversation(id);
  });

  router.del("/api/conversations/:id", {}, ({ params }) => {
    deleteConversation(params["id"] as string);
    return { ok: true };
  });

  router.get(
    "/api/search",
    { query: z.object({ q: z.string().min(1).max(200) }) },
    ({ query }) => searchMessages(query.q, 50),
  );
}
