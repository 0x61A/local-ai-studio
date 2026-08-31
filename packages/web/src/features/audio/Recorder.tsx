import { useEffect, useRef, useState } from "react";
import { useUi } from "../../stores/ui";

/**
 * Mikrofon kaydı. MediaRecorder ne verirse alırız (webm/opus, mp4/aac);
 * 16 kHz mono WAV'a çevirme işi `lib/audio.ts`'de, tarayıcıda yapılır.
 */
export function Recorder({
  disabled,
  onRecorded,
}: {
  disabled: boolean;
  onRecorded: (blob: Blob) => void;
}) {
  const t = useUi((s) => s.t);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);

  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [recording]);

  // Bileşen kaldırılırsa mikrofon açık kalmasın.
  useEffect(
    () => () => {
      recorder.current?.stream.getTracks().forEach((track) => track.stop());
    },
    [],
  );

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const instance = new MediaRecorder(stream);
      chunks.current = [];
      instance.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.current.push(event.data);
      };
      instance.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks.current, { type: instance.mimeType });
        if (blob.size > 0) onRecorded(blob);
      };
      instance.start();
      recorder.current = instance;
      setSeconds(0);
      setRecording(true);
    } catch (err) {
      setError(
        (err as Error).name === "NotAllowedError"
          ? t("audio.micDenied")
          : (err as Error).message,
      );
    }
  };

  const stop = () => {
    recorder.current?.stop();
    recorder.current = null;
    setRecording(false);
  };

  return (
    <div className="recorder">
      <button
        type="button"
        className={recording ? "button button--danger" : "button"}
        disabled={disabled}
        onClick={() => (recording ? stop() : void start())}
      >
        {recording ? t("audio.stopRecording") : t("audio.record")}
      </button>
      {recording && (
        <span className="recorder__timer">
          ● {String(Math.floor(seconds / 60)).padStart(2, "0")}:
          {String(seconds % 60).padStart(2, "0")}
        </span>
      )}
      {error && <span className="model__error">{error}</span>}
    </div>
  );
}
