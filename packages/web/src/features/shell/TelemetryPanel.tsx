import type { Telemetry } from "@studio/shared";
import { useUi } from "../../stores/ui";
import { formatGb } from "../../lib/format";

export function TelemetryPanel({ telemetry }: { telemetry: Telemetry | null }) {
  const t = useUi((s) => s.t);
  if (!telemetry) return null;

  const memoryPercent =
    telemetry.memoryTotalMb > 0
      ? (telemetry.memoryUsedMb / telemetry.memoryTotalMb) * 100
      : 0;

  return (
    <section className="card">
      <h2 className="card__title">{t("telemetry.title")}</h2>
      <div className="facts">
        <Meter
          label={t("telemetry.cpu")}
          value={`${telemetry.cpuUsagePercent.toFixed(1)}%`}
          percent={telemetry.cpuUsagePercent}
        />
        <Meter
          label={t("telemetry.memory")}
          value={`${formatGb(telemetry.memoryUsedMb)} / ${formatGb(telemetry.memoryTotalMb)}`}
          percent={memoryPercent}
        />
        <div className="facts__row">
          <span className="facts__label">{t("telemetry.uptime")}</span>
          <span className="facts__value">
            {t("telemetry.seconds", { count: telemetry.uptimeSeconds })}
          </span>
        </div>
      </div>
    </section>
  );
}

function Meter({
  label,
  value,
  percent,
}: {
  label: string;
  value: string;
  percent: number;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="meter">
      <div className="meter__head">
        <span>{label}</span>
        <span className="meter__value">{value}</span>
      </div>
      <div
        className="meter__track"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(clamped)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="meter__fill" style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
