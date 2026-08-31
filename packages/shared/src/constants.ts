/**
 * Calisma zamaninda hem sunucu hem web tarafindan kullanilan sabitler.
 * Bu dosya bilerek bagimliliksizdir: web bundle'i zod'u cekmesin diye
 * semalardan ayri tutulur.
 */

/** Oturum token'i bu baslikta gonderilir. */
export const AUTH_HEADER = "authorization";

/** Launcher tarayiciyi bu fragment anahtariyla acar: #t=<token> */
export const TOKEN_FRAGMENT_KEY = "t";
