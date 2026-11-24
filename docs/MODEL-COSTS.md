# Model performance and cost

## Performance for desktop tasks

| Task | Qwen3.8-27B on your computer | Grok 4.6 hosted |
| --- | --- | --- |
| Short chat and simple tool calls | No inference network round trip. Good first workload for a 4-bit build with most layers on the GPU. | Network latency on each request. No need to load a model or allocate a local GPU. |
| Screenshot interpretation and browser navigation | Requires a vision-capable quantization and runtime. Test whether it identifies UI controls correctly after each screenshot, particularly on busy pages. | Hosted image and function support. Test on the same workflow before assuming higher click accuracy. |
| Long, multi-step jobs | Model load, CPU offload, vision processing and a growing context can each slow a turn. A 24 GB GPU is a practical starting point, with a modest context first. | Usually easier to provision at longer context. Each tool round can add more input, latency and API cost. |
| Failure recovery | Depends on the quantization, tool-call parser and whether the model understands the screenshot or tool error. | Also capable of selecting the wrong action or misinterpreting an error. Use the same completion criteria. |

No hardware-matched benchmark or comparable public Grok 4.6 versus Qwen3.8-27B score was verified. Qwen's published benchmark and serving recipes are vendor results, and hosted Grok's latency also depends on network and service conditions. Run the same tasks on your own machine. Track success, extra tool attempts, elapsed time and whether anything needed correction. Start with 10 normal tasks such as saving a file, extracting a page title, or checking a schedule. Keep Qwen for the tasks it completes reliably and reserve hosted calls for the cases that benefit.

- [Qwen3.8 model release and benchmarks](https://github.com/QwenLM/Qwen3.5)
- [xAI model documentation](https://docs.x.ai/developers/models)

## Estimated hosted costs in USD

The November 9, 2026 source snapshot in this repository lists Grok 4.6 at **$2 input / $6 output per million tokens** and Grok 4.3 at **$1.25 input / $2.50 output**. Direct access to the current pricing page was blocked during this review. The estimates below assume uncached input at the standard tier below its long-prompt pricing threshold. Tool loops, screenshot tokens, reasoning output, searches and voice can materially change the bill.

| Monthly usage billed by the provider | Grok 4.6 | Grok 4.3 |
| --- | ---: | ---: |
| 300 short turns at 5,000 input + 1,000 output each | $4.80 | $2.63 |
| 3,000 similar turns, about 100/day | $48.00 | $26.25 |
| 1,000 heavier turns at 20,000 input + 2,000 output each | $52.00 | $30.00 |
| 100 occasional calls at 5,000 input + 1,000 output each | $1.60 | $0.88 |

Formula is input millions × input rate plus output millions × output rate. The same snapshot quoted hosted realtime voice at **$0.08/minute**, or about **$12 for 150 minutes** before extras. Local Whisper and the device's local text-to-speech voice avoid these hosted voice charges.

Grok 4.3 is a candidate for cheaper hosted text. Matching or exceeding Grok 4.6 on Marion Agent's screenshot and tool tests has not been verified. To try it only for optional second opinions, set `XAI_MODEL=grok-4.3`. Marion continues to run its main loop locally. The Grokbot comparison depends on how many tool rounds and voice minutes each app actually uses. No Grokbot invoice or workload was available for a dollar-for-dollar comparison.

- [Current xAI pricing](https://docs.x.ai/developers/pricing)
- [Dated xAI pricing research](xai-and-composio.md#a1-models-context-pricing-reasoning-images)
