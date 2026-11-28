// Fork (FORK.md 1.42): message routing, concurrent chat tasks, transient retry.

export type { SupersededRequest } from "../../messaging/bot-supersede.js";
export { cancelReplacedRequest, finishReplacedRequest } from "../../messaging/bot-supersede.js";
export {
  chatTaskBlock,
  chatTaskLine,
  countsAsChatTask,
  separateChatTasks,
} from "./chat-task-gate.js";
export type { RoutingConfig } from "./routing-config.js";
export { routingConfig } from "./routing-config.js";
export { judgeMessageRoute, routingJudgeEndpoint } from "./routing-judge.js";
