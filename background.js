importScripts("config.js");
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "ASK") return;

  (async () => {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + GROQ_API_KEY,
        },
        body: JSON.stringify({
          model: "openai/gpt-oss-120b",
          reasoning_effort: "low",
          messages: msg.messages,
        }),
      });

      const data = await res.json();

      if (res.status === 401) {
        sendResponse({ error: "API key in background.js is wrong. Fix it and reload the extension." });
        return;
      }
      if (!res.ok) {
        sendResponse({ error: data.error?.message || "API error " + res.status });
        return;
      }

      sendResponse({ reply: data.choices[0].message.content });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  })();

  return true;
});