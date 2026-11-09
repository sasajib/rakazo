# Voice and calls

Talk to your bots instead of typing, have them read replies aloud, or call them.

## Set up a voice provider

Open **Settings → Voice**, pick a **Provider** and add its **API key**:

- **ElevenLabs**, **OpenAI**, **Fish Audio** and **xAI** can speak and transcribe. If xAI is
  connected in **Models**, with a SuperGrok or X Premium sign-in or a key, leave the **API key**
  empty to use that connection.
- **Cartesia** speaks only.
- **Self-hosted** uses your own OpenAI-compatible speech server, such as Kokoro or Whisper. Enter its
  **Server URL**.
- **macOS** uses the voices installed on the Mac running your server, with no key. It appears only
  when the server runs on a Mac.

Then choose a **Voice**, and use **Hear a sample** to check it. **Speech model** and
**Transcription model** let you pick the provider's models.

Voice settings apply to every [space](./spaces.md). A space can customize them in its settings.

## Talk instead of typing

Hold the microphone in the composer and speak; release to send. Slide up to lock recording so you
don't have to keep holding.

## Hear replies

- To hear one reply, choose **Speak this reply** on the message.
- To hear every reply from a bot, open its settings, expand **Advanced**, and turn on
  **Read replies aloud**. The **Voice** next to it overrides your default voice for that bot.

## Call a bot

Choose **Call** at the top of the chat to talk with the bot in real time. During a call you can
**Mute**, open the **Transcript**, minimize the call and keep using the app, or **Hang up**. The
transcript stays in the chat afterwards.

Bots can call you too: ask "call me at 5 to go over the day", or a bot may call when you've missed
the same reminder several times. You'll see that the bot is calling you; answer or **Decline**. A
missed call shows **Call back** in the chat.

## Duplex calls with a LiveKit agent

The built-in call takes turns: it listens until you pause, sends what it heard, and speaks the
reply once the bot is done. A self-hosted deployment can hand the whole conversation to a
[LiveKit](https://livekit.io) voice agent instead, so you can talk over the bot and hear replies as
they stream. The reference agent lives in `examples/livekit-voice-agent/`; it speaks to the bot's
thread on your behalf, publishes live captions, and closes the call for you when you hang up.

Set `VOICE_AGENT_URL` on the API to the agent's token server. **Call** then asks the API for a
room token, joins the agent's room from the browser, and shows the same call window: **Mute**
turns your microphone off, the **Transcript** fills from the agent's captions, and **Hang up**
leaves the room. Add the LiveKit server's `wss://` origin to `RAKAZO_CSP_CONNECT_SRC` on the web
service so the browser may open the signalling connection. Unset `VOICE_AGENT_URL` to go back to
the built-in call; nothing else changes.

Bots that call you ring in the app exactly as before. **Answer** then opens a room with the agent
instead of the built-in call: the room keeps the call's id, so the agent's turns and the call's
record land in the same call as the request, and the agent speaks the bot's opening line first
(the API hands it to the token server with the call id, which it accepts only for a call you have
just answered). **Decline** and a call that rings out behave the same on either transport.

## On mobile

The mobile app uses your phone's own speech recognition and voices for calls. Pick a
**Device voice** in a bot's settings. On Android, a call keeps going with the screen off.
