import { useState } from "react";
import type { TranscriptEntry } from "../../stores/agent";
import { useAgent } from "../../stores/agent";
import { useUi } from "../../stores/ui";

export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <ol className="transcript">
      {entries.map((entry) => (
        <li key={entry.id} className="transcript__item">
          {entry.kind === "text" && <TextEntry entry={entry} />}
          {entry.kind === "tool" && <ToolEntry entry={entry} />}
          {entry.kind === "approval" && <ApprovalCard entry={entry} />}
          {entry.kind === "error" && (
            <p className="chat__error" role="alert">{entry.content}</p>
          )}
        </li>
      ))}
    </ol>
  );
}

function TextEntry({ entry }: { entry: TranscriptEntry }) {
  return (
    <div className="message__body">
      {entry.content}
      {entry.streaming && <span className="message__caret" aria-hidden="true" />}
    </div>
  );
}

function ToolEntry({ entry }: { entry: TranscriptEntry }) {
  const t = useUi((s) => s.t);
  const [open, setOpen] = useState(false);
  const failed = entry.toolResult?.isError === true;

  return (
    <div className={`tool ${failed ? "tool--error" : ""}`}>
      <button
        type="button"
        className="tool__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <span className="tool__icon" aria-hidden="true">
          {entry.streaming ? "◌" : failed ? "✕" : "✓"}
        </span>
        <code className="tool__name">{entry.toolName}</code>
        <span className="tool__summary">{summarize(entry)}</span>
        {entry.ms !== undefined && <span className="tool__ms">{entry.ms} ms</span>}
      </button>

      {open && (
        <div className="tool__detail">
          <p className="tool__label">{t("agent.arguments")}</p>
          <pre className="tool__pre">{JSON.stringify(entry.toolArgs, null, 2)}</pre>
          {entry.toolResult && (
            <>
              <p className="tool__label">{t("agent.result")}</p>
              <pre className="tool__pre">{entry.toolResult.content}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function summarize(entry: TranscriptEntry): string {
  const args = entry.toolArgs as Record<string, unknown> | undefined;
  if (!args) return "";
  const first = args["path"] ?? args["query"] ?? args["url"] ?? args["command"];
  return first === undefined ? "" : String(first).slice(0, 80);
}

function ApprovalCard({ entry }: { entry: TranscriptEntry }) {
  const t = useUi((s) => s.t);
  const approve = useAgent((s) => s.approve);
  const request = entry.request;
  if (!request) return null;

  const decided = entry.approved !== null && entry.approved !== undefined;

  return (
    <div
      className={`approval approval--${
        decided ? (entry.approved ? "approved" : "rejected") : "pending"
      }`}
    >
      <div className="approval__head">
        <span className={`approval__risk approval__risk--${request.risk}`}>
          {t(`agent.risk.${request.risk}`)}
        </span>
        <span className="approval__summary">{request.summary}</span>
      </div>

      {request.command && (
        <pre className="approval__command">{request.command}</pre>
      )}
      {request.diff && <pre className="approval__diff">{colorize(request.diff)}</pre>}

      {decided ? (
        <p className="approval__decided">
          {entry.approved ? t("agent.approved") : t("agent.rejected")}
        </p>
      ) : (
        <div className="approval__actions">
          <button
            type="button"
            className="button button--small"
            onClick={() => void approve(entry.id, true)}
          >
            {t("agent.allow")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void approve(entry.id, true, true)}
          >
            {t("agent.allowAlways")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void approve(entry.id, false)}
          >
            {t("agent.deny")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Fark satırlarını renklendirir; içerik metin olarak kalır. */
function colorize(diff: string) {
  return diff.split("\n").map((line, index) => (
    <span
      key={index}
      className={
        line.startsWith("+")
          ? "diff diff--add"
          : line.startsWith("-")
            ? "diff diff--remove"
            : line.startsWith("@@")
              ? "diff diff--hunk"
              : "diff"
      }
    >
      {line}
      {"\n"}
    </span>
  ));
}
