import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/layout.css";
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { NexusProvider } from "./state/NexusContext";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <NexusProvider>
      <App />
    </NexusProvider>
  </React.StrictMode>,
);
