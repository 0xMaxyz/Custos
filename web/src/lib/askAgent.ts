// Conversational agent seam (ROADMAP A3.1).
//
// When VITE_AGENT_API_URL is set, questions POST to the agent's /ask endpoint
// and the model answers grounded in the live snapshot + recent decisions.
// Otherwise we serve the canned fixture answers so the panel works in the demo
// build. The agent is read-only and never executes from chat.

import { askAnswers } from "./data";

const AGENT_API_URL = (import.meta.env.VITE_AGENT_API_URL ?? "").replace(/\/$/, "");
export const isAgentLive = AGENT_API_URL.length > 0;

const FALLBACK =
  "I answer from decision history and the current snapshot. Try one of the suggested questions — I explain, but I never take orders or execute trades from chat.";

export interface AskResult {
  answer: string;
  /** true when the answer came from the live agent, false from fixtures. */
  live: boolean;
}

/**
 * Ask the agent a question. Live path hits POST /ask; demo path returns the
 * fixture answer (or a generic fallback). Never throws — network/agent errors
 * resolve to a friendly message so the chat UI stays responsive.
 */
export async function askAgent(question: string): Promise<AskResult> {
  if (!isAgentLive) {
    return { answer: askAnswers[question] ?? FALLBACK, live: false };
  }

  try {
    const res = await fetch(`${AGENT_API_URL}/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        answer:
          body.error ??
          "The agent couldn't answer that right now. It may still be warming up — try again shortly.",
        live: true,
      };
    }
    const data = (await res.json()) as { answer?: string };
    return { answer: data.answer ?? FALLBACK, live: true };
  } catch {
    return {
      answer: "I couldn't reach the agent. Check your connection and try again.",
      live: true,
    };
  }
}
