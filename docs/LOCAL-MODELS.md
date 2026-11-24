# Local models and speech

Marion's local agent needs an OpenAI-compatible server with streaming `POST /v1/responses` and function calling. Desktop screenshot interpretation also needs vision support. Use `ollama list` or `GET /v1/models` to find the exact model ID your runtime exposes.

```dotenv
MARION_LOCAL_MODEL_URL=http://127.0.0.1:11434/v1
MARION_LOCAL_MODEL=your-installed-model-id
```

Restart Marion, then check the list under **Settings → Models**. A local model server and Docker run independently. [Ollama's OpenAI compatibility guide](https://docs.ollama.com/api/openai-compatibility)

With `XAI_API_KEY` configured, Marion can ask Grok for a second opinion with your approval or use hosted transcription and voice. Local inference and on-device speech avoid those provider calls. [xAI pricing](https://docs.x.ai/developers/pricing)

## Local transcription

The native app supports on-device dictation on macOS 26 and later. A fallback speech backend must accept multipart Whisper-compatible audio and return a JSON object with a `text` field. For example, start Speaches after starting Docker.

```sh
docker run --rm -p 127.0.0.1:8001:8000 -v marion-speech-models:/home/ubuntu/.cache/huggingface/hub ghcr.io/speaches-ai/speaches:latest-cpu
```

Then set these values in the local configuration and restart Marion.

```dotenv
MARION_STT_URL=http://127.0.0.1:8001/v1/audio/transcriptions
MARION_STT_MODEL=Systran/faster-distil-whisper-small.en
```

The first recording can take longer while the speech backend prepares the model. Local calls use the selected chat model for replies and play them with the device's voice. Choose **Play reply** if the browser blocks automatic playback. [Speaches](https://github.com/speaches-ai/speaches)
