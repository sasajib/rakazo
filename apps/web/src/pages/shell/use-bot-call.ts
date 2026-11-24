import type { Bot, VoiceStatus } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { setCallMinimized, startCall, useCallSession } from "../../lib/calls/call-session";
import { voiceAgentConfigQuery } from "../../lib/calls/voice-agent";

/** The call in progress, and calling a bot from the chat. */
export function useBotCall({
  phoneCallsEnabled,
  voiceStatus,
  openVoiceSettings,
}: {
  phoneCallsEnabled: boolean;
  voiceStatus: VoiceStatus | null;
  openVoiceSettings: () => void;
}) {
  const call = useCallSession();
  // A LiveKit voice agent brings its own speech: the call needs no voice provider here.
  const livekitCalls = useQuery(voiceAgentConfigQuery(phoneCallsEnabled)).data?.mode === "livekit";
  /** Calls a bot, or opens voice settings first when no voice is connected. */
  function callBot(bot: Bot) {
    if (!phoneCallsEnabled) return;
    if (!livekitCalls && !voiceStatus?.ready) {
      openVoiceSettings();
      return;
    }
    startCall({
      botId: bot.id,
      botName: bot.name,
      botColor: bot.color,
      botAvatarSet: bot.avatarSet,
      transcribe: voiceStatus ? Boolean(voiceStatus.transcribe) : undefined,
      transport: livekitCalls ? "livekit" : "builtin",
    });
  }
  /** Returns to the call with this bot when there is one, or starts it. */
  function openCall(bot: Bot) {
    if (call?.botId === bot.id) {
      setCallMinimized(false);
      return;
    }
    callBot(bot);
  }
  return { call, callBot, openCall, livekitCalls };
}
