import { useEffect, useState } from "react";
import { fetchImageObjectUrl } from "../../lib/api";

/**
 * Görseli yetkili istekle çeker.
 *
 * `<img src="/api/...">` oturum token'ını gönderemez; dosyayı `fetch` ile
 * alıp nesne URL'i üretiyoruz. Token'ı adres çubuğuna koymamanın bedeli
 * bu bileşen, ve ucuz.
 */
export function GalleryImage({
  filename,
  alt,
  className,
}: {
  filename: string;
  alt: string;
  className?: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;
    setFailed(false);

    void fetchImageObjectUrl(filename)
      .then((value) => {
        if (revoked) {
          URL.revokeObjectURL(value);
          return;
        }
        objectUrl = value;
        setUrl(value);
      })
      .catch(() => setFailed(true));

    return () => {
      revoked = true;
      setUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filename]);

  if (failed) return <div className={`thumb thumb--failed ${className ?? ""}`} />;
  if (!url) return <div className={`thumb thumb--loading ${className ?? ""}`} />;
  return <img className={className} src={url} alt={alt} loading="lazy" />;
}
