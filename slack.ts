// Slack notifications via Incoming Webhooks.
// Configure by setting the WEBHOOK_URL env variable (https://hooks.slack.com/services/...).
// If unset, all notifications are silently skipped.

const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (WEBHOOK_URL && !/^https:\/\/hooks\.slack\.com\/services\//.test(WEBHOOK_URL)) {
  console.warn("Warning: WEBHOOK_URL does not look like a Slack webhook URL, notifications may fail.");
}

export type Block = Record<string, unknown>;

export function section(text: string): Block {
  return { type: "section", text: { type: "mrkdwn", text } };
}

export function fields(...items: string[]): Block {
  return {
    type: "section",
    fields: items.map((text) => ({ type: "mrkdwn", text })),
  };
}

export async function notify(text: string, ...blocks: Block[]): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, blocks }),
    });
    if (!response.ok) {
      console.error(`Slack notification failed: HTTP ${response.status} ${await response.text()}`);
    }
  } catch (error) {
    console.error("Slack notification failed:", error);
  }
}
