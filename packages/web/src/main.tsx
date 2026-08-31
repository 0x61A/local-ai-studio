import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { useUi } from "./stores/ui";
import "./styles/app.css";

// Ilk boyamadan once tema ve dili koke uygula: yanip sonmeyi onler.
const { theme, language } = useUi.getState();
document.documentElement.dataset["theme"] = theme;
document.documentElement.lang = language;

const container = document.getElementById("root");
if (!container) throw new Error("#root bulunamadi");

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
