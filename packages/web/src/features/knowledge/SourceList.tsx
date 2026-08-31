import type { SourceRef } from "../../lib/api";
import { useUi } from "../../stores/ui";

/**
 * Kaynak listesi. Sohbette de bilgi tabanı sekmesinde de aynı gösterim
 * kullanılır: kullanıcı cevaptaki [1] atfını burada birebir bulmalı.
 */
export function SourceList({ sources }: { sources: SourceRef[] }) {
  const t = useUi((s) => s.t);
  if (!sources.length) return null;

  return (
    <ol className="sources">
      {sources.map((source) => (
        <li className="source" key={`${source.documentId}-${source.index}`}>
          <div className="source__head">
            <span className="source__index">[{source.index}]</span>
            <span className="source__name">{source.documentName}</span>
            {source.page > 1 && (
              <span className="source__page">{t("knowledge.page", { n: source.page })}</span>
            )}
            {source.heading && <span className="source__heading">{source.heading}</span>}
            <span className={`source__match source__match--${source.matchedBy}`}>
              {t(`knowledge.matchedBy.${source.matchedBy}`)}
            </span>
          </div>
          <p className="source__snippet">{source.snippet}</p>
        </li>
      ))}
    </ol>
  );
}
