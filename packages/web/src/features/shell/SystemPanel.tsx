import type { SystemInfo } from "@studio/shared";
import { useUi } from "../../stores/ui";
import { formatGb } from "../../lib/format";

export function SystemPanel({ system }: { system: SystemInfo | null }) {
  const t = useUi((s) => s.t);

  if (!system) {
    return (
      <section className="card">
        <p className="facts__note">{t("system.loading")}</p>
      </section>
    );
  }

  const rows: Array<[string, string, string?]> = [
    [t("system.os"), `${system.os.platform} ${system.os.release} (${system.os.arch})`],
    [
      t("system.cpu"),
      system.cpu.model,
      t("system.cores", {
        physical: system.cpu.physicalCores,
        logical: system.cpu.logicalCores,
      }),
    ],
    [t("system.memory"), formatGb(system.memory.totalMb)],
    [t("system.gpu"), system.gpu.name],
    [t("system.accelerator"), system.gpu.accelerator],
    [t("system.vram"), formatGb(system.gpu.vramTotalMb)],
    [t("system.runtime"), `Node ${system.node} / Studio ${system.appVersion}`],
  ];

  return (
    <section className="card">
      <h2 className="card__title">{t("system.title")}</h2>
      <dl className="facts">
        {rows.map(([label, value, note]) => (
          <div className="facts__row" key={label}>
            <dt className="facts__label">{label}</dt>
            <dd className="facts__value" style={{ margin: 0 }}>
              {value}
              {note && (
                <>
                  <br />
                  <span className="facts__note">{note}</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
