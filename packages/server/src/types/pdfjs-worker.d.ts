/**
 * pdf.js işçi modülünün tip bildirimi yok; paketin içine gömülüp
 * `globalThis.pdfjsWorker` olarak verildiği için yalnızca varlığı yeterli.
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs";
