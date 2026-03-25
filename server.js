import Anthropic from "@anthropic-ai/sdk";
import cors from "cors";
import express from "express";

const app = express();
const port = process.env.PORT || 3000;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/api/chat", async (req, res) => {
  const { messages, system } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "messages must be an array" });
  }

  try {
    const params = {
      model: "claude-sonnet-4-20250514",
      max_tokens: 8096,
      messages,
    };

    if (system) {
      params.system = system;
    }

    const response = await client.messages.create(params);
    res.json(response);
  } catch (error) {
    if (error instanceof Anthropic.APIError) {
      return res.status(error.status || 500).json({ error: error.message });
    }
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`Centro de Control backend corriendo en puerto ${port}`);
});
