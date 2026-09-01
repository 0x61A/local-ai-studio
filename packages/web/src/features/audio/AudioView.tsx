import { useEffect, useRef, useState } from "react";
import { formatGb } from "../../lib/format";
import { useAudio } from "../../stores/audio";
import { useUi } from "../../stores/ui";
import { AudioPlayer } from "./AudioPlayer";
import { Recorder } from "./Recorder";
import { setupCommand } from "../../lib/platform";

const LANGUAGES = ["auto", "tr", "en", "de", "fr", "es", "ar", "ru"];

export function AudioView() {
  const t = useUi((s) => s.t);
  const { overview, error, refresh, clearError } = useAudio();

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="main__inner">
      <h1 className="page-title">{t("nav.audio")}</h1>

      {error && (
        <p className="chat__error" role="alert" onClick={clearError}>
          {error}
        </p>
      )}

      <SpeechToText />
      <TextToSpeech />

      {(overview?.outputs.length ?? 0) > 0 && <Outputs />}
    </div>
  );
}

function SpeechToText() {
  const t = useUi((s) => s.t);
  const { overview, transcript, transcribing, transcribeBlob, clearTranscript } = useAudio();
  const input = useRef<HTMLInputElement>(null);

  const speech = overview?.speech;
  const models = speech?.models ?? [];
  const localReady = Boolean(speech?.binary) && models.length > 0;
  const cloudReady = speech?.cloudAvailable ?? false;

  const [provider, setProvider] = useState<"local" | "openai">("local");
  const [model, setModel] = useState("");
  const [language, setLanguage] = useState("auto");
  const [translate, setTranslate] = useState(false);

  useEffect(() => {
    if (!model && models[0]) setModel(models[0].filename);
  }, [models, model]);

  useEffect(() => {
    if (!localReady && cloudReady) setProvider("openai");
  }, [localReady, cloudReady]);

  const run = (blob: Blob) => {
    void transcribeBlob(blob, {
      provider,
      model: provider === "local" ? model : "whisper-1",
      language,
      translate,
    });
  };

  const ready = provider === "local" ? localReady : cloudReady;

  return (
    <section className="card">
      <h2 className="card__title">{t("audio.stt")}</h2>

      {!localReady && (
        <p className="facts__note">
          {speech?.binary
            ? t("audio.noSpeechModels", { dir: speech.modelsDir })
            : t("audio.noWhisper", { command: setupCommand("whisper") })}
        </p>
      )}

      <div className="grid-form">
        <label className="field">
          <span className="field__label">{t("audio.provider")}</span>
          <select
            className="input"
            value={provider}
            onChange={(event) => setProvider(event.target.value as "local" | "openai")}
          >
            <option value="local" disabled={!localReady}>
              {t("audio.localWhisper")}
            </option>
            <option value="openai" disabled={!cloudReady}>
              {t("audio.cloudWhisper")}
            </option>
          </select>
        </label>

        {provider === "local" && (
          <label className="field">
            <span className="field__label">{t("audio.model")}</span>
            <select
              className="input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((entry) => (
                <option key={entry.filename} value={entry.filename}>
                  {entry.filename} ({formatGb(entry.sizeBytes / 1048576)})
                </option>
              ))}
            </select>
          </label>
        )}

        <label className="field">
          <span className="field__label">{t("audio.language")}</span>
          <select
            className="input"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {LANGUAGES.map((code) => (
              <option key={code} value={code}>
                {code === "auto" ? t("audio.autoLanguage") : code}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="toggles">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={translate}
            onChange={(event) => setTranslate(event.target.checked)}
          />
          <span>{t("audio.translate")}</span>
        </label>
      </div>

      <div className="recorder-row">
        <Recorder disabled={!ready || transcribing} onRecorded={run} />
        <input
          ref={input}
          type="file"
          accept="audio/*"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) run(file);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="button button--ghost"
          disabled={!ready || transcribing}
          onClick={() => input.current?.click()}
        >
          {t("audio.chooseFile")}
        </button>
        {transcribing && <span className="facts__note">{t("audio.transcribing")}</span>}
      </div>

      {transcript && (
        <div className="transcript-box">
          <div className="gallery__bar">
            <span className="facts__note">
              {t("audio.detected", {
                lang: transcript.language || "?",
                ms: Math.round(transcript.ms / 100) / 10,
              })}
            </span>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={clearTranscript}
            >
              {t("image.close")}
            </button>
          </div>
          <p className="transcript-box__text">{transcript.text}</p>
          {transcript.segments.length > 1 && (
            <ul className="segments">
              {transcript.segments.map((segment, index) => (
                <li key={index} className="segment">
                  <span className="segment__time">{formatTime(segment.start)}</span>
                  <span>{segment.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function TextToSpeech() {
  const t = useUi((s) => s.t);
  const { overview, speaking, speak } = useAudio();
  const voices = overview?.tts.voices ?? [];
  const available = overview?.tts.available ?? false;

  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(0);

  if (!available) {
    return (
      <section className="card">
        <h2 className="card__title">{t("audio.tts")}</h2>
        <p className="facts__note">{t("audio.ttsUnavailable")}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="card__title">{t("audio.tts")}</h2>

      <label className="field">
        <span className="field__label">{t("audio.text")}</span>
        <textarea
          className="input composer__input"
          rows={3}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={t("audio.textPlaceholder")}
        />
      </label>

      <div className="grid-form">
        <label className="field">
          <span className="field__label">{t("audio.voice")}</span>
          <select
            className="input"
            value={voice}
            onChange={(event) => setVoice(event.target.value)}
          >
            <option value="">{t("audio.defaultVoice")}</option>
            {voices.map((entry) => (
              <option key={`${entry.name}-${entry.locale}`} value={entry.name}>
                {entry.name} — {entry.locale}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">{t("audio.rate")}</span>
          <input
            className="input"
            type="number"
            min={0}
            max={500}
            step={10}
            value={rate}
            onChange={(event) => setRate(Number(event.target.value))}
            placeholder={t("audio.rateDefault")}
          />
        </label>
      </div>

      <button
        type="button"
        className="button"
        disabled={speaking || !text.trim()}
        onClick={() => void speak(text.trim(), voice, rate)}
      >
        {speaking ? t("audio.speaking") : t("audio.speakButton")}
      </button>
    </section>
  );
}

function Outputs() {
  const t = useUi((s) => s.t);
  const { overview, removeOutput } = useAudio();

  return (
    <section className="card">
      <h2 className="card__title">{t("audio.outputs")}</h2>
      <ul className="file-list">
        {(overview?.outputs ?? []).map((output) => (
          <li className="file file--doc" key={output.filename}>
            <span className="file__badge">wav</span>
            <AudioPlayer filename={output.filename} />
            <span className="file__size">{Math.round(output.sizeBytes / 1024)} KB</span>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => void removeOutput(output.filename)}
            >
              {t("image.delete")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}
