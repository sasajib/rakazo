package com.rakazo.notifications

import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

internal data class RunRecord(
  val runId: String,
  val spaceId: String,
  val botId: String,
  val botName: String,
  val groupId: String?,
  val groupName: String?,
  val threadId: String,
  val status: String,
  val prompt: String,
  val trigger: String,
  val notificationsEnabled: Boolean,
  /**
   * The API's `updatedAt` in epoch ms: when a finished run completed (recent page) or when an
   * active run last changed (a wait keeps it, so it names the wait). Null when the server sent none.
   */
  val updatedAtMs: Long? = null,
)

/** One chat as the activity list keys it: a group, or a bot's own chat. */
internal fun chatKey(run: RunRecord): String =
  run.groupId?.let { "group:$it" } ?: "bot:${run.botId}"

/** `Date.toISOString()` output; null for anything else, so a bad value only drops the time checks. */
internal fun parseServerTime(value: String?): Long? {
  if (value.isNullOrBlank()) return null
  return runCatching {
    SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
      isLenient = false
    }.parse(value)?.time
  }.getOrNull()
}

/** Keeps insertion order and drops the oldest entries beyond [max]. */
internal fun <T> MutableSet<T>.addBounded(value: T, max: Int) {
  remove(value)
  add(value)
  val extra = size - max
  if (extra > 0) {
    val iterator = iterator()
    repeat(extra) {
      iterator.next()
      iterator.remove()
    }
  }
}

/**
 * Fork (1.41): a finished run is posted at most once per device, however the recent page moves.
 *
 * The old seen set was trimmed to the current page, so a run that left the page and came back
 * (a newer run in its chat deleted, more than 20 chats and back, any reordering) was posted
 * again with its old reply. Now three things keep an old completion from being posted again,
 * all persisted by the service so a restart keeps them:
 *  - `seen`: every run id posted or deliberately skipped, bounded to [MAX_SEEN], never trimmed
 *    to the page;
 *  - `watermarks`: per chat, the newest completion time handled, so nothing older in that chat
 *    is posted after it (a deleted newer run brings no old reply back);
 *  - `notBeforeMs`: when this poller started. Push owns the work that finished while no poller ran
 *    (the service stops while nothing works), so a new poller does not post those replies again.
 * Runs without a time (old servers) keep the id check only.
 */
internal class PollCompletions(
  private val seen: MutableSet<String>,
  private val watermarks: MutableMap<String, Long> = linkedMapOf(),
  private val notBeforeMs: () -> Long = { Long.MIN_VALUE },
  private val log: (String) -> Unit = {},
) {
  private data class Session(val endpoint: String, val spaceId: String, val token: String, val epoch: Long)
  private var session: Session? = null
  private val pending = linkedMapOf<String, RunRecord>()
  /** Runs whose already-seen skip was logged; once per run per service, so polls do not spam. */
  private val loggedSkips = mutableSetOf<String>()

  // The discard must reach storage before the poller can stop: a restart reloads
  // only what persisted, and would repost the muted reply once the bot is unmuted.
  fun muteBot(botId: String, persistSeen: () -> Unit) {
    val muted = pending.values.filter { it.botId == botId && it.groupId == null }
    muted.forEach { run ->
      pending.remove(run.runId)
      remember(run)
      log("skip run=${run.runId} reason=muted")
    }
    if (muted.isNotEmpty()) persistSeen()
  }

  /** A push for this run reached the device (posted, or dropped on purpose): never post it again. */
  fun pushed(runId: String) {
    if (runId in seen) return
    seen.addBounded(runId, MAX_SEEN)
    pending.remove(runId)
    log("skip run=$runId reason=push_delivered")
  }

  private fun remember(run: RunRecord) {
    seen.addBounded(run.runId, MAX_SEEN)
    val at = run.updatedAtMs ?: return
    val key = chatKey(run)
    if ((watermarks[key] ?: Long.MIN_VALUE) < at) {
      watermarks.remove(key)
      watermarks[key] = at
      while (watermarks.size > MAX_WATERMARKS) watermarks.remove(watermarks.keys.first())
    }
  }

  /** Why an unseen run is too old to post, or null when it may be posted. */
  private fun tooOld(run: RunRecord): String? {
    val at = run.updatedAtMs ?: return null
    val mark = watermarks[chatKey(run)]
    if (mark != null && at < mark) return "older_than_chat"
    if (at < notBeforeMs()) return "before_poller"
    return null
  }

  private fun handle(run: RunRecord, decide: () -> Boolean) {
    if (run.runId in seen) {
      if (loggedSkips.add(run.runId)) log("skip run=${run.runId} reason=seen")
      return
    }
    tooOld(run)?.let { reason ->
      remember(run)
      log("skip run=${run.runId} reason=$reason")
      return
    }
    if (decide()) remember(run)
  }

  fun useSession(endpoint: String, spaceId: String, token: String, epoch: Long) {
    val next = Session(endpoint, spaceId, token, epoch)
    if (session != next) {
      pending.clear()
      session = next
    }
  }

  fun prepare(
    recent: List<RunRecord>,
    seeded: Boolean,
    settings: NotificationSettings,
    isOpenThread: (RunRecord) -> Boolean,
    attention: (RunRecord) -> Unit,
  ): List<RunRecord> {
    val candidates = LinkedHashMap(pending)
    recent.asReversed().forEach { candidates[it.runId] = it }
    pending.clear()
    if (!seeded) {
      recent.forEach(::remember)
    } else {
      candidates.values.forEach { run ->
        handle(run) {
          when {
            !run.notificationsEnabled || isOpenThread(run) -> true
            // Only the server knows which agent-to-agent replies the user reads; it pushes those.
            run.trigger == "bot_message" && run.status == "completed" -> true
            run.status == "failed" && settings.needsAttention -> {
              log("post run=${run.runId} reason=attention status=failed")
              attention(run)
              true
            }
            run.status != "completed" -> true
            run.trigger == "routine" && !settings.scheduledTasks -> true
            run.trigger != "routine" && !settings.messages -> true
            else -> {
              pending[run.runId] = run
              false
            }
          }
        }
      }
    }
    // Retain at most 100 reply records across generations, independently of the recent page.
    while (pending.size > 100) {
      val oldest = pending.values.first()
      pending.remove(oldest.runId)
      remember(oldest)
      log("skip run=${oldest.runId} reason=pending_overflow")
    }
    // The seen set is NOT trimmed to the page: a run that leaves it and comes back stays seen.
    return pending.values.toList()
  }

  fun complete(run: RunRecord, alreadyPosted: () -> Boolean, post: () -> Unit) {
    if (run.runId !in pending) return
    handle(run) {
      if (alreadyPosted()) {
        log("skip run=${run.runId} reason=already_showing")
      } else {
        post()
        log("post run=${run.runId} reason=new_completion chat=${chatKey(run)}")
      }
      true
    }
    pending.remove(run.runId)
  }

  companion object {
    /** Ids kept across restarts; far more than one page, so a returning run is still known. */
    const val MAX_SEEN = 1_000
    const val MAX_WATERMARKS = 500
  }
}

/**
 * Fork (1.41): a wait (question, takeover) alerts once per episode, across service restarts.
 * The old in-memory set was cleared with each new service, and the service stops whenever no
 * run works, so every app start alerted every open wait again. The key carries the wait's
 * `updatedAt`, so a new wait of the same run alerts again; a wait that began before this poller
 * started was announced by the server's push.
 */
internal class AttentionAlerts(
  private val alerted: MutableSet<String>,
  private val notBeforeMs: () -> Long = { Long.MIN_VALUE },
  private val log: (String) -> Unit = {},
) {
  fun due(active: List<RunRecord>): List<RunRecord> =
    active.filter { it.status == "waiting_input" || it.status == "waiting_takeover" }
      .filter { it.notificationsEnabled }
      .filter { run ->
        val key = "${run.runId}:${run.status}:${run.updatedAtMs ?: ""}"
        when {
          key in alerted -> false
          (run.updatedAtMs ?: Long.MAX_VALUE) < notBeforeMs() -> {
            alerted.addBounded(key, MAX_ALERTED)
            log("skip run=${run.runId} reason=wait_before_poller status=${run.status}")
            false
          }
          else -> {
            alerted.addBounded(key, MAX_ALERTED)
            log("post run=${run.runId} reason=attention status=${run.status}")
            true
          }
        }
      }

  companion object {
    const val MAX_ALERTED = 200
  }
}

/**
 * Fork (1.41): the same push delivered twice is shown once. The key is the server's `noticeKey`
 * (kind + run, or kind + message) or, from older servers, the per-send `deliveryId`, which an
 * Expo/FCM retry of one send repeats.
 */
internal class PushRepeats(private val recent: MutableSet<String>) {
  fun firstTime(key: String): Boolean {
    if (key.isBlank()) return true
    if (key in recent) return false
    recent.addBounded(key, MAX_KEYS)
    return true
  }

  companion object {
    const val MAX_KEYS = 300

    fun key(noticeKey: String, deliveryId: String): String =
      noticeKey.ifBlank { deliveryId.takeIf(String::isNotBlank)?.let { "delivery:$it" }.orEmpty() }
  }
}

/** Newline-separated ids, in order; ids never contain a newline. */
internal fun encodeIds(ids: Collection<String>): String = ids.joinToString("\n")

internal fun decodeIds(value: String?): LinkedHashSet<String> =
  value.orEmpty().split("\n").filter(String::isNotBlank).toCollection(LinkedHashSet())

internal fun encodeWatermarks(marks: Map<String, Long>): String =
  marks.entries.joinToString("\n") { "${it.key}=${it.value}" }

internal fun decodeWatermarks(value: String?): LinkedHashMap<String, Long> {
  val marks = LinkedHashMap<String, Long>()
  value.orEmpty().split("\n").forEach { line ->
    val at = line.lastIndexOf('=')
    if (at > 0) line.substring(at + 1).toLongOrNull()?.let { marks[line.substring(0, at)] = it }
  }
  return marks
}

internal fun handleUnseenCompletion(
  runId: String,
  seen: MutableSet<String>,
  handle: () -> Boolean,
) {
  // Deferred reply lookups return false; only a posted or deliberately skipped run is seen.
  if (runId !in seen && handle()) seen.add(runId)
}

internal class PollTokenCache {
  @Volatile private var token: String? = null

  // The service commits under its generation lock after the expensive read.
  fun getOrLoad(load: () -> String, commit: (() -> Unit) -> Boolean): String? {
    token?.let { return it }
    val loaded = load()
    return if (commit { token = loaded }) loaded else null
  }

  fun reset() {
    token = null
  }
}

/** Sign-out clears the stored space id; only the session that still owns the history may write it. */
internal fun ownsStoredHistory(storedSpaceId: String?, sessionSpaceId: String?): Boolean =
  sessionSpaceId != null && storedSpaceId == sessionSpaceId

internal class PollHistoryWrites {
  private var persisted: Any? = null

  fun persistIfChanged(seeded: Boolean, seen: Set<String>, persist: (Set<String>) -> Unit) =
    persistSnapshot(seeded, seen.toSet(), persist)

  /** [snapshot] must be a copy: it is compared with the next one to skip unchanged writes. */
  fun <T : Any> persistSnapshot(seeded: Boolean, snapshot: T, persist: (T) -> Unit) {
    if (!seeded || snapshot != persisted) {
      persist(snapshot)
      persisted = snapshot
    }
  }

  fun reset() {
    persisted = null
  }
}

/** What the poller persists: every list in order, so the bounds drop the oldest entries. */
internal data class PollState(
  val seen: List<String>,
  val watermarks: Map<String, Long>,
  val alerted: List<String>,
)

internal class PollCadence {
  private var failures = 0
  val hasFailures: Boolean get() = failures > 0

  fun failure() {
    failures = (failures + 1).coerceAtMost(3)
  }

  fun success() {
    failures = 0
  }

  fun delayMs(elapsedMs: Long, recentPageBusy: Boolean, jitterMs: Long): Long =
    if (hasFailures) {
      minOf(120_000L, 30_000L * (1L shl failures)) + jitterMs
    } else {
      if (recentPageBusy || elapsedMs < 60_000L) 8_000L else 30_000L
    }
}
