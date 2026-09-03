/** MB degerini okunur GB/MB metnine cevirir. */
export function formatGb(megabytes: number): string {
  if (megabytes <= 0) return "-";
  // Yuvarlamadan basmak "139.3760986328125 MB" gibi bir sey uretiyordu:
  // deger bayttan bolunerek geliyor, tam sayi degil.
  if (megabytes < 1024) return `${Math.round(megabytes)} MB`;
  return `${(megabytes / 1024).toFixed(1)} GB`;
}
