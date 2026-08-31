/** MB degerini okunur GB/MB metnine cevirir. */
export function formatGb(megabytes: number): string {
  if (megabytes <= 0) return "-";
  if (megabytes < 1024) return `${megabytes} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}
