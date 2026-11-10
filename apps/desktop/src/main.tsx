import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { applyTheme, getInitialTheme } from "./design-system/theme.ts";
import "./design-system/tokens.css";
import "./styles.css";

// 首帧前落主题，避免深浅色闪烁
applyTheme(getInitialTheme());

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
