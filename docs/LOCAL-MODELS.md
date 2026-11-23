# Local models and app connectors

## Grok 4.6 vs Qwen3.8-27B

| | Grok 4.6 | Qwen3.8-27B |
| --- | --- | --- |
| Where it runs | Hosted xAI API | Your PC or another machine you control |
| Cost | Requires an xAI API key and usage billing | No per-token model API fee when self-hosted. Hardware, storage and electricity still matter. |
| Desktop work | Hosted image understanding and function calling. xAI additionally offers hosted web and X search. | Local image understanding and tool calling depend on a compatible runtime, vision weights and model template. The bot can use its Docker browser. |
| Context | The repository's Nov 9, 2026 xAI pricing research lists 500k tokens. | Qwen's official vLLM example configures 262,144 tokens. Set a much lower limit to start on a PC. |
| Best fit for Marion Agent | Optional, explicitly approved second opinion and hosted voice through the existing xAI integration | Primary chat and tool-calling model if it runs at an acceptable speed on your hardware |

No comparable head-to-head score or measured speed on your PC was verified. For a practical test, run the same desktop task with each model and compare successful tool calls, screenshot interpretation, latency, and recovery from errors. Four-bit 27B weights alone are roughly 13.5 GB before quantization overhead, vision weights, context cache and runtime memory. A 24 GB GPU is a practical starting target. CPU or partial GPU offload can work more slowly. Keep context modest at first, especially while Docker desktops are running.

- [Qwen official repository and serving recipes](https://github.com/QwenLM/Qwen3.5)
- [Qwen3.8-27B model card](https://huggingface.co/Qwen/Qwen3.8-27B)
- [xAI API pricing](https://docs.x.ai/developers/pricing)

## Connecting your local runtime

The server must expose streaming `POST /v1/responses`, support function calls and replay their outputs, and accept image inputs for desktop work. Use a current [Ollama release](https://docs.ollama.com/api/openai-compatibility) or a compatible server. Use `ollama list` or your server's `GET /v1/models` to verify the exact model ID. Marion Agent's default is `qwen3.8:27b`. That particular Ollama registry tag was not verified here. Qwen's official repository documents serving the model as `Qwen/Qwen3.8-27B` with vLLM or SGLang. The published examples assume multiple GPUs. On a single Windows PC, select a compatible quantized deployment for your hardware.

For Ollama on the same PC as Marion Agent:

```dotenv
MARION_LOCAL_MODEL_URL=http://127.0.0.1:11434/v1
MARION_LOCAL_MODEL=qwen3.8:27b
```

Replace the model name with the one your runtime reports and restart Marion Agent. Leaving `XAI_API_KEY` blank keeps Grok and xAI voice off. A local model server and Docker desktop server can run independently. Earlier xAI-encrypted reasoning and compacted context cannot be replayed locally. The original chat transcript remains in SQLite.

## Free Composio workflow

The repository's Nov 9, 2026 pricing research recorded a **$0 Hobby plan**, with up to **100,000 tool calls per month** and **50,000 trigger deliveries per month**. The corresponding managed-app sublimits were **20,000 calls** and **10,000 deliveries**. Usage paused at the cap. The live pricing site was blocked from this environment, so check current limits in your project before relying on them. The public SDK provides a toolkit catalog, authentication and execution integration. Catalog discovery and a free hosted quota do not grant free access to every upstream app or unlimited execution.

1. Create a Composio Hobby project and add its project key as `COMPOSIO_API_KEY` in Marion Agent's server-side `.env`.
2. Restart Marion Agent, retain email sign-in for local use, and open **Connect apps**. Start with one toolkit your existing account can authorize. Some apps require your own OAuth setup or their own paid API plan.
3. Use the existing discovery and execution tools from your local Qwen agent. Start with a read-only action such as listing your own calendar events. Check usage in Composio. Leave triggers off until needed.
4. For an integration that needs to avoid Composio's quota entirely, implement a narrow connector against the app's API or use a trustworthy app-specific MCP server. The app's own OAuth and rate limits still apply. These direct connectors are a future option.

- [Composio pricing](https://composio.dev/pricing)
- [Composio toolkit catalog](https://docs.composio.dev/toolkits)
- [Composio SDK and session documentation](https://github.com/ComposioHQ/composio)
