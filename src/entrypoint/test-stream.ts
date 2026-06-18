import "dotenv/config";

import { streamMessage } from "../services/api/stream.js";

const gen = streamMessage({
  messages: [{ role: "user", content: "用一句话解释什么是 Agentic Loop" }],
  system: "You are a helpful assistant. Reply in Chinese.",
});

const result = await consumeStream();

console.log(`Stop reason: ${result.stopReason || "unknown"}`);

async function consumeStream() {
  while (true) {
    const { value, done } = await gen.next();

    if (done) {
      return value;
    }

    switch (value.type) {
      case "text":
        process.stdout.write(value.text);
        break;
      case "message_done":
        console.log(
          `\nTokens: ${value.usage.input_tokens} in / ${value.usage.output_tokens} out`,
        );
        break;
      case "error":
        console.error(`\nStream error: ${value.error.message}`);
        break;
    }
  }
}
