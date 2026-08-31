"use client";

import { useEffect, useState } from "react";

const API = process.env.NODE_ENV === "production" ? "http://127.0.0.1:8788/api" : "/api";

export default function OpenRouterCallbackPage() {
  const [message, setMessage] = useState("Connecting OpenRouter…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get("code");
    const state = parameters.get("mosaic_state");
    if (!code || !state) {
      queueMicrotask(() => {
        setFailed(true);
        setMessage("The OpenRouter callback is incomplete. Close this window and try again.");
      });
      return;
    }
    void fetch(`${API}/ai/openrouter/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    }).then(async (response) => {
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error || "OpenRouter connection failed.");
      setMessage("OpenRouter connected. Choose a model in MosAIc.");
      if (window.opener) {
        window.opener.postMessage({ type: "mosaic:openrouter-connected" }, window.location.origin);
        window.setTimeout(() => window.close(), 700);
      } else {
        window.setTimeout(() => window.location.replace("/"), 900);
      }
    }).catch((error) => {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "OpenRouter connection failed.");
    });
  }, []);

  return <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#f7f3eb", color: "#2c2823", fontFamily: "Arial, sans-serif" }}>
    <section style={{ width: "min(420px, calc(100vw - 32px))", padding: 28, borderRadius: 24, background: "#fffdf8", boxShadow: "0 22px 70px #392b1d18", textAlign: "center" }}>
      <b style={{ display: "block", marginBottom: 10, color: failed ? "#b13d31" : "#d9281c", fontFamily: "Georgia, serif", fontSize: 28 }}>MosAIc</b>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>{message}</p>
    </section>
  </main>;
}
