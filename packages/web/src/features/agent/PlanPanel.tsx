import type { TaskProgress } from "../../lib/api";
import { useUi } from "../../stores/ui";

/**
 * Uzun görev takip paneli.
 *
 * Plan kipinde ajan tek bir uzun akış değil, sırayla yürüyen adımlardır.
 * Akış yüzlerce satır sürdüğünde "neredeyiz" sorusunun cevabı yukarıda,
 * sabit bir yerde durmalı -- transkriptte yukarı kaydırarak aranmamalı.
 */
export function PlanPanel({ tasks }: { tasks: TaskProgress[] }) {
  const t = useUi((s) => s.t);
  if (tasks.length === 0) return null;

  const done = tasks.filter((task) => task.state === "done").length;

  return (
    <section className="plan" aria-label={t("agent.plan.title")}>
      <div className="plan__head">
        <h3 className="plan__title">{t("agent.plan.title")}</h3>
        <span className="plan__count">
          {t("agent.plan.progress", { done, total: tasks.length })}
        </span>
      </div>
      <ol className="plan__list">
        {tasks.map((task, index) => (
          <li key={task.id} className={`plan__task plan__task--${task.state}`}>
            <span className="plan__marker" aria-hidden="true">
              {task.state === "done"
                ? "✓"
                : task.state === "failed"
                  ? "✕"
                  : task.state === "running"
                    ? "◌"
                    : index + 1}
            </span>
            <span className="plan__label">{task.title}</span>
            {task.ms !== undefined && (
              <span className="plan__ms">{formatMs(task.ms)}</span>
            )}
            <span className="visually-hidden">{t(`agent.plan.state.${task.state}`)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}
