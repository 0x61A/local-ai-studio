import { useEffect, useState } from "react";
import { fetchAudioObjectUrl } from "../../lib/api";

/** Ses dosyasını yetkili istekle çeker; bkz. GalleryImage. */
export function AudioPlayer({ filename }: { filename: string }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let objectUrl: string | null = null;

    void fetchAudioObjectUrl(filename)
      .then((value) => {
        if (revoked) {
          URL.revokeObjectURL(value);
          return;
        }
        objectUrl = value;
        setUrl(value);
      })
      .catch(() => setUrl(null));

    return () => {
      revoked = true;
      setUrl(null);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [filename]);

  if (!url) return <span className="facts__note">…</span>;
  return <audio className="player" controls src={url} preload="none" />;
}
