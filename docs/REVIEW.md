# Marion Agent review

The review followed sign-in, the local inference pipeline, app connector setup, the Docker desktop and Library, the installable front end, and audio from browser capture to response.

| Finding | Status |
| --- | --- |
| The app catalog looked empty when no project key was configured. The OAuth callback could show success before checking whether the app was linked. | The catalog links to project setup. Settings verify the key with Composio before saving it. The callback accepts a single-use, expiring link attempt tied to the signed-in user and verifies the specific active account. |
| Local model changes previously required changing environment variables and restarting. | Model settings read the existing server's model catalog and persist an account-level selection. Chat and memory use that selection. |
| Both recording paths previously used the system microphone. A late permission response could keep a microphone open after leaving the composer. | Settings list and test inputs. Recording paths use the saved input, and cancelled recordings discard a late stream or transcript. |
| Speech required an xAI key and there was no standalone install behavior. | Local speech uses a configurable transcription server and system voice. Realtime xAI remains available. The web app has install metadata, launch scripts and reload shortcuts. |
| No external HTTPS preview is configured in this cloud instance. | The loopback server can be tested in Chromium. A public or forwarded preview needs a platform HTTP port and a secure origin for audio. Avoid exposing local passwordless sign-in. |

The browser and API smoke tests use a real browser and desktop where available. Model, speech, realtime voice WebSocket, and Composio credential responses in the settings test are simulated. Live Composio consent, realtime xAI billing and credentials, a physical microphone on the user's computer, and macOS/Windows launcher behavior require testing on those systems. See [Security](../SECURITY.md) before using the app on a shared computer or over the Internet.
