const axios = require("axios");

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

function extractOpenRouterError(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.response?.data?.message ||
    error?.message ||
    "OpenRouter request failed"
  );
}

async function postChatCompletion(body, { apiKey, timeout = 55000 } = {}) {
  if (!apiKey) {
    throw new Error("Missing OPENROUTER_API_KEY");
  }

  try {
    const response = await axios.post(OPENROUTER_URL, body, {
      timeout,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/milwrite/a11y-checker",
        "X-Title": "a11y-checker",
      },
    });
    return response.data;
  } catch (error) {
    throw new Error(extractOpenRouterError(error));
  }
}

module.exports = { postChatCompletion };
