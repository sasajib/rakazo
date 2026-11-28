/**
 * Fork (1.39): what a delegated bot's requester reads when the request was stopped without a
 * result: the user stopped it, or answered its open question with a new message in that chat
 * (which retires the waiting run and starts a new one that owes the requester nothing). The
 * request's short id keeps two notices apart (an identical message would be taken for a repeat).
 */
export function botMessageStoppedText(runId: string): string {
  return `Your request ${runId.slice(0, 8)} was stopped before it finished, so no result will come back from it: the user stopped it or replied in my chat directly instead. Treat it as closed. Do not send it again unless the user asks for it; carry on without the result, or tell the user it was not done.`;
}
