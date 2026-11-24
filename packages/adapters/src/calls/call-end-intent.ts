/**
 * A bot may end a live call only when the caller asked for it. Left to the model, it hung up on
 * "Okay", on greetings and on silence even with a standing rule against it (twice on 11-16), so the
 * rule is enforced here: no hang-up words in the caller's latest turn, no end_call.
 */
const HANG_UP =
  /\b(hang\s?up|end (the |this |our )?call|close (the |this )?call|cut (the )?call|stop (the )?call|disconnect|bye|good\s?bye|good night|see you|talk to you later|speak to you later|talk later|that'?s (all|it)|that will be all|that is all|we'?re done|we are done|i'?m done|i am done|you can go|allah hafez|khoda hafez)\b|(?:রাখি|রাখছি|বিদায়|আল্লাহ হাফেজ|খোদা হাফেজ)/i;

export function callEndRequested(callerText: string | null | undefined): boolean {
  return HANG_UP.test(callerText ?? "");
}

export const CALL_END_NOT_ASKED =
  "Not ended: the caller has not asked to end the call (standing order r3-never-end-call). Keep the call open. If nothing is pending, ask briefly whether they need anything else.";
