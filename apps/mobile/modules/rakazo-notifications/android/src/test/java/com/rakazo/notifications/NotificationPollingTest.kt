package com.rakazo.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPollingTest {
  @Test
  fun `restart retains a reply missing from the next full recent page and posts it once`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    assertEquals(listOf(reply), completions.page(listOf(reply)))
    // No completion: the old job is still fetching when the next generation polls.
    val nextPage = (1..20).map { run("new-$it") }
    val pending = completions.page(nextPage)
    assertTrue("the replacement poller must retain the displaced reply", reply in pending)
    assertFalse("reply" in seen)
    var notifications = 0
    completions.complete(reply, alreadyPosted = { false }) {
      assertFalse("reply" in seen)
      notifications++
    }
    assertTrue("reply" in seen)
    assertFalse(reply in completions.page(nextPage))
    completions.complete(reply, alreadyPosted = { false }) { notifications++ }
    assertEquals(1, notifications)
  }

  @Test
  fun `active notification after process death suppresses another alert and records the run seen`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    completions.page(listOf(reply))
    var notifications = 0
    completions.complete(reply, alreadyPosted = { true }) { notifications++ }
    assertEquals(0, notifications)
    assertTrue("reply" in seen)
    assertTrue(completions.page(listOf(reply)).isEmpty())
  }

  @Test
  fun `pending replies are bounded and the oldest is skipped on overflow`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val replies = (1..101).map { run("reply-$it") }
    var pending = emptyList<RunRecord>()
    for (reply in replies) pending = completions.page(listOf(reply))
    assertEquals(100, pending.size)
    assertFalse(replies.first() in pending)
    assertTrue(replies.last() in pending)
    var notifications = 0
    completions.complete(replies.first(), alreadyPosted = { false }) { notifications++ }
    assertEquals(0, notifications)
  }

  @Test
  fun `pending replies stay in the same session and clear on each session boundary`() {
    val changes = listOf(
      listOf("https://other.test", "space", "token", "0"),
      listOf("https://example.test", "other-space", "token", "0"),
      listOf("https://example.test", "space", "other-token", "0"),
      listOf("https://example.test", "space", "token", "1"),
    )
    for ((endpoint, spaceId, token, epoch) in changes) {
      val completions = PollCompletions(mutableSetOf())
      completions.useSession("https://example.test", "space", "token", 0)
      val reply = run("reply")
      completions.page(listOf(reply))
      completions.useSession("https://example.test", "space", "token", 0)
      assertEquals(listOf(reply), completions.page(emptyList()))
      completions.useSession(endpoint, spaceId, token, epoch.toLong())
      assertTrue(completions.page(emptyList()).isEmpty())
    }
  }

  @Test
  fun `history seeding suppresses old replies and pending replies honour settings and open threads`() {
    val settings = listOf(
      NotificationSettings(messages = false) to run("message"),
      NotificationSettings(scheduledTasks = false) to run("routine").copy(trigger = "routine"),
    )
    for ((disabled, reply) in settings) {
      val seen = mutableSetOf<String>()
      val completions = PollCompletions(seen)
      assertTrue(completions.page(listOf(reply), seeded = false).isEmpty())
      assertTrue(completions.page(listOf(reply)).isEmpty())
      assertTrue(reply.runId in seen)
      val pending = reply.copy(runId = "new")
      completions.page(listOf(pending))
      assertTrue(completions.page(listOf(pending), settings = disabled).isEmpty())
      assertTrue("new" in seen)
      val open = reply.copy(runId = "open")
      completions.page(listOf(open))
      assertTrue(completions.page(listOf(open), openThreadId = open.threadId).isEmpty())
      assertTrue("open" in seen)
    }
  }

  @Test
  fun `muting drops a pending direct reply missing from recent but preserves groups and other bots`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val direct = run("muted")
    val group = run("group").copy(groupId = "group-1")
    val other = run("other").copy(botId = "other-bot")
    completions.page(listOf(direct, group, other))
    val recent = (1..20).map { run("new-$it").copy(botId = "other-bot") }
    assertTrue(direct in completions.page(recent))

    completions.muteBot("bot") {}
    val afterMute = completions.page(recent)
    assertFalse("the muted reply must be discarded even when absent from recent", direct in afterMute)
    assertTrue(group in afterMute)
    assertTrue(other in afterMute)
    val posted = mutableListOf<String>()
    // The pre-mute fetch may still return with its old RunRecord.
    completions.complete(direct, alreadyPosted = { false }) { posted += direct.runId }
    completions.complete(group, alreadyPosted = { false }) { posted += group.runId }
    completions.complete(other, alreadyPosted = { false }) { posted += other.runId }
    assertEquals(listOf("group", "other"), posted)
  }

  @Test
  fun `muting persists the discarded reply so a restart cannot repost it after unmute`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persistSeen = { history.persistIfChanged(true, seen) { writes.add(it) } }
    val muted = run("muted")
    // The completed run waits for its reply lookup; the poll iteration persisted.
    assertEquals(listOf(muted), completions.page(listOf(muted)))
    persistSeen()

    // The user mutes the bot; the poller can stop before another iteration persists.
    completions.muteBot("bot", persistSeen)

    // A restart rebuilds the seen set from the last persisted snapshot, and the
    // unmuted bot's run returns on the recent page with notificationsEnabled=true.
    val restarted = PollCompletions(mutableSetOf<String>().apply { addAll(writes.last()) })
    assertTrue("restart must keep the muted reply suppressed", restarted.page(listOf(muted)).isEmpty())
    var notifications = 0
    restarted.complete(muted, alreadyPosted = { false }) { notifications++ }
    assertEquals(0, notifications)
  }

  @Test
  fun `a sign-out before the mute leaves the cleared history alone`() {
    // Sign-out clears the stored space id; the old session must not write its seen set back.
    assertFalse(ownsStoredHistory(storedSpaceId = null, sessionSpaceId = "space-1"))
    assertFalse(ownsStoredHistory(storedSpaceId = "space-2", sessionSpaceId = "space-1"))
    assertFalse(ownsStoredHistory(storedSpaceId = null, sessionSpaceId = null))
    assertTrue(ownsStoredHistory(storedSpaceId = "space-1", sessionSpaceId = "space-1"))
  }

  @Test
  fun `muting with no discarded direct reply writes no history`() {
    val completions = PollCompletions(mutableSetOf())
    completions.page(listOf(run("group").copy(groupId = "group-1")))
    var writes = 0
    completions.muteBot("bot") { writes++ }
    assertEquals(0, writes)
  }

  @Test
  fun `failed post keeps the pending reply available outside the recent page`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    completions.page(listOf(reply))
    assertThrows(IllegalStateException::class.java) {
      completions.complete(reply, alreadyPosted = { false }) { error("notification failed") }
    }
    assertFalse("reply" in seen)
    assertEquals(listOf(reply), completions.page(emptyList()))
    completions.complete(reply, alreadyPosted = { false }) {}
    assertTrue("reply" in seen)
    assertTrue(completions.page(emptyList()).isEmpty())
  }

  @Test
  fun `completion is remembered only after posting and is not handled again`() {
    val seen = mutableSetOf<String>()
    var notifications = 0
    handleUnseenCompletion("reply", seen) {
      assertFalse("reply" in seen)
      notifications++
      true
    }
    assertEquals(setOf("reply"), seen)
    handleUnseenCompletion("reply", seen) { error("already posted") }
    assertEquals(1, notifications)
  }

  @Test
  fun `failed posting leaves the completion unseen`() {
    val seen = mutableSetOf<String>()
    assertThrows(IllegalStateException::class.java) {
      handleUnseenCompletion("reply", seen) { error("notification failed") }
    }
    assertTrue(seen.isEmpty())
    handleUnseenCompletion("reply", seen) { true }
    assertEquals(setOf("reply"), seen)
  }

  @Test
  fun `an agent-to-agent turn is left to the server push and never posted`() {
    val seen = mutableSetOf<String>()
    val completions = PollCompletions(seen)
    val peer = run("peer").copy(trigger = "bot_message")
    assertTrue(completions.page(listOf(peer)).isEmpty())
    assertTrue("peer" in seen)
  }

  @Test
  fun `deliberately skipped completion is remembered without posting`() {
    val seen = mutableSetOf<String>()
    handleUnseenCompletion("reply", seen) { true }
    assertEquals(setOf("reply"), seen)
    handleUnseenCompletion("reply", seen) { error("already skipped") }
  }

  @Test
  fun `token is loaded once until reset`() {
    val cache = PollTokenCache()
    var reads = 0
    val load = { reads++; "token-$reads" }
    val commit: (() -> Unit) -> Boolean = { it(); true }

    assertEquals("token-1", cache.getOrLoad(load, commit))
    repeat(5) { assertEquals("token-1", cache.getOrLoad(load, commit)) }
    assertEquals(1, reads)
    cache.reset()
    assertEquals("token-2", cache.getOrLoad(load, commit))
    assertEquals(2, reads)
  }

  @Test
  fun `obsolete generation cannot cache a token loaded during reset`() {
    val cache = PollTokenCache()
    assertNull(cache.getOrLoad({ cache.reset(); "obsolete" }) { false })
    assertEquals("current", cache.getOrLoad({ "current" }) { it(); true })
    assertEquals("current", cache.getOrLoad({ error("must reuse token") }) { it(); true })
  }

  @Test
  fun `blank tokens remain cached until reset`() {
    val cache = PollTokenCache()
    assertEquals("", cache.getOrLoad({ "" }) { it(); true })
    assertEquals("", cache.getOrLoad({ error("must reuse blank token") }) { it(); true })
    cache.reset()
    assertEquals("new", cache.getOrLoad({ "new" }) { it(); true })
  }

  @Test
  fun `unchanged history is not rewritten but added and removed runs are`() {
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persist: (Set<String>) -> Unit = { writes.add(it) }

    history.persistIfChanged(false, setOf("a", "b"), persist)
    repeat(5) { history.persistIfChanged(true, setOf("b", "a"), persist) }
    assertEquals(listOf(setOf("a", "b")), writes)
    history.persistIfChanged(true, setOf("a", "b", "c"), persist)
    history.persistIfChanged(true, setOf("c"), persist)
    history.persistIfChanged(true, emptySet(), persist)
    history.persistIfChanged(true, emptySet(), persist)
    assertEquals(listOf(setOf("a", "b"), setOf("a", "b", "c"), setOf("c"), emptySet<String>()), writes)
  }

  @Test
  fun `history snapshots survive caller mutation and reset for a new space`() {
    val history = PollHistoryWrites()
    val writes = mutableListOf<Set<String>>()
    val persist: (Set<String>) -> Unit = { writes.add(it) }
    val seen = mutableSetOf("a")
    history.persistIfChanged(true, seen, persist)
    seen.add("b")
    history.persistIfChanged(true, seen, persist)
    assertEquals(listOf(setOf("a"), setOf("a", "b")), writes)
    history.reset()
    history.persistIfChanged(true, seen, persist)
    assertEquals(3, writes.size)
    history.persistIfChanged(false, seen, persist)
    assertEquals(4, writes.size)
  }

  @Test
  fun `failed history write is retried`() {
    val history = PollHistoryWrites()
    try {
      history.persistIfChanged(true, setOf("a")) { throw IllegalStateException() }
    } catch (_: IllegalStateException) {
      // A failed persistence attempt must not advance the snapshot.
    }
    var writes = 0
    history.persistIfChanged(true, setOf("a")) { writes++ }
    assertEquals(1, writes)
  }

  @Test
  fun `failures grow backoff to its cap and success resets it`() {
    val cadence = PollCadence()
    assertFalse(cadence.hasFailures)
    cadence.failure()
    assertTrue(cadence.hasFailures)
    assertEquals(60_000L, cadence.delayMs(0, true, 0))
    cadence.failure()
    assertEquals(120_000L, cadence.delayMs(0, true, 0))
    repeat(20) {
      cadence.failure()
      assertEquals(120_999L, cadence.delayMs(90_000, false, 999))
    }
    cadence.success()
    assertFalse(cadence.hasFailures)
    assertEquals(30_000L, cadence.delayMs(90_000, false, 999))
    cadence.failure()
    assertEquals(60_000L, cadence.delayMs(90_000, false, 0))
    cadence.success()
    assertEquals(8_000L, cadence.delayMs(0, false, 0))
  }

  @Test
  fun `success uses fast window or busy recent page then slow cadence`() {
    val cadence = PollCadence()
    assertEquals(8_000L, cadence.delayMs(59_999, false, 0))
    assertEquals(30_000L, cadence.delayMs(60_000, false, 0))
    assertEquals(8_000L, cadence.delayMs(90_000, true, 0))
  }


  // Fork (1.41): an old completion is never posted again, however the recent page moves.

  @Test
  fun `a run that leaves a page of more than 20 chats and comes back is not posted again`() {
    val seen = linkedSetOf<String>()
    val posted = mutableListOf<String>()
    val completions = PollCompletions(seen)
    val old = (1..20).map { run("old-$it").copy(botId = "bot-$it", threadId = "thread-$it") }
    completions.page(old, seeded = false)
    // 20 newer chats (agents created for a test) push every old chat off the page ...
    val newer = (1..20).map { run("new-$it").copy(botId = "test-$it", threadId = "test-thread-$it") }
    completions.page(newer).forEach { completions.complete(it, { false }) { posted += it.runId } }
    assertEquals(newer.map { it.runId }.reversed(), posted)
    // ... the test agents are removed, and the old chats are the page again.
    posted.clear()
    completions.page(old).forEach { completions.complete(it, { false }) { posted += it.runId } }
    assertEquals(emptyList<String>(), posted)
    assertTrue(old.all { it.runId in seen })
  }

  @Test
  fun `a deleted newer run does not bring the chat's old reply back`() {
    val seen = linkedSetOf<String>()
    val marks = linkedMapOf<String, Long>()
    val completions = PollCompletions(seen, marks)
    val old = run("old").copy(updatedAtMs = 1_000)
    completions.page(listOf(old), seeded = false)
    val newer = run("newer").copy(updatedAtMs = 2_000)
    var posts = 0
    completions.page(listOf(newer)).forEach { completions.complete(it, { false }) { posts++ } }
    assertEquals(1, posts)
    assertTrue(completions.page(listOf(old)).isEmpty())
    // Even with the id gone from the bounded seen set, the chat's watermark keeps it out.
    val forgetful = PollCompletions(linkedSetOf(), linkedMapOf<String, Long>().apply { putAll(marks) })
    assertTrue(forgetful.page(listOf(old)).isEmpty())
    // A different, older run of the same chat that the device never saw is not news either.
    assertTrue(forgetful.page(listOf(run("older").copy(updatedAtMs = 1_500))).isEmpty())
  }

  @Test
  fun `a removed chat leaves the other chats alone and its replies are not posted again`() {
    val seen = linkedSetOf<String>()
    val completions = PollCompletions(seen, linkedMapOf())
    val kept = run("kept").copy(botId = "kept-bot", threadId = "kept-thread", updatedAtMs = 1_000)
    val removed = run("removed").copy(botId = "removed-bot", threadId = "removed-thread", updatedAtMs = 2_000)
    completions.page(listOf(removed, kept), seeded = false)
    assertTrue(completions.page(listOf(kept)).isEmpty())
    val reply = run("reply").copy(botId = "kept-bot", threadId = "kept-thread", updatedAtMs = 3_000)
    assertEquals(listOf(reply), completions.page(listOf(reply)))
    var posts = 0
    completions.complete(reply, { false }) { posts++ }
    assertEquals(1, posts)
    assertTrue(completions.page(listOf(reply)).isEmpty())
  }

  @Test
  fun `a restarted poller keeps its history and leaves replies that finished while it was off to the push`() {
    val seen = linkedSetOf<String>()
    val marks = linkedMapOf<String, Long>()
    val writes = mutableListOf<PollState>()
    val history = PollHistoryWrites()
    val first = PollCompletions(seen, marks, { 10_000 })
    val morning = run("morning").copy(botId = "umar", threadId = "umar-thread", updatedAtMs = 9_000)
    val jobs = run("jobs").copy(botId = "jobs", threadId = "jobs-thread", updatedAtMs = 9_500)
    first.page(listOf(morning, jobs), seeded = false)
    history.persistSnapshot(false, PollState(seen.toList(), marks.toMap(), emptyList())) { writes += it }

    // Hours later a routine finished and its push was shown; the app starts a new poller.
    val stored = writes.last()
    val restartedSeen = decodeIds(encodeIds(stored.seen))
    val restartedMarks = decodeWatermarks(encodeWatermarks(stored.watermarks))
    assertEquals(stored.watermarks, restartedMarks)
    val logs = mutableListOf<String>()
    val restarted = PollCompletions(restartedSeen, restartedMarks, { 50_000 }, { logs += it })
    val routine = run("routine").copy(botId = "umar", threadId = "umar-thread", updatedAtMs = 40_000)
    assertTrue(restarted.page(listOf(routine, jobs)).isEmpty())
    assertTrue("routine" in restartedSeen)
    assertTrue(logs.any { it == "skip run=routine reason=before_poller" })
    // A reply that finishes while this poller runs is posted, once.
    val live = run("live").copy(botId = "umar", threadId = "umar-thread", updatedAtMs = 60_000)
    var posts = 0
    restarted.page(listOf(live, jobs)).forEach { restarted.complete(it, { false }) { posts++ } }
    restarted.page(listOf(live, jobs)).forEach { restarted.complete(it, { false }) { posts++ } }
    assertEquals(1, posts)
    assertTrue(logs.any { it.startsWith("post run=live reason=new_completion") })
  }

  @Test
  fun `a reply a push announced is never posted by the poller`() {
    val seen = linkedSetOf<String>()
    val completions = PollCompletions(seen)
    val reply = run("reply")
    assertEquals(listOf(reply), completions.page(listOf(reply)))
    completions.pushed("reply")
    var posts = 0
    completions.complete(reply, { false }) { posts++ }
    assertEquals(0, posts)
    assertTrue(completions.page(listOf(reply)).isEmpty())
  }

  @Test
  fun `an old failure is not alerted again after a restart`() {
    val attention = mutableListOf<String>()
    val completions = PollCompletions(linkedSetOf("old-failure"), linkedMapOf(), { 5_000 })
    val old = run("old-failure").copy(status = "failed", updatedAtMs = 1_000)
    val earlier = run("earlier-failure").copy(status = "failed", updatedAtMs = 2_000, botId = "other")
    completions.prepare(listOf(old, earlier), true, NotificationSettings(), { false }) { attention += it.runId }
    assertEquals(emptyList<String>(), attention)
    val fresh = run("fresh-failure").copy(status = "failed", updatedAtMs = 9_000, botId = "third")
    completions.prepare(listOf(fresh), true, NotificationSettings(), { false }) { attention += it.runId }
    assertEquals(listOf("fresh-failure"), attention)
  }

  @Test
  fun `the seen set is bounded and keeps the newest ids`() {
    val seen = linkedSetOf<String>()
    repeat(PollCompletions.MAX_SEEN + 5) { seen.addBounded("run-$it", PollCompletions.MAX_SEEN) }
    assertEquals(PollCompletions.MAX_SEEN, seen.size)
    assertFalse("run-0" in seen)
    assertTrue("run-${PollCompletions.MAX_SEEN + 4}" in seen)
    seen.addBounded("run-5", PollCompletions.MAX_SEEN)
    assertEquals("run-5", seen.last())
  }

  @Test
  fun `a wait alerts once across restarts and again only for a new wait`() {
    val alerted = linkedSetOf<String>()
    val wait = run("asks").copy(status = "waiting_input", updatedAtMs = 10_000)
    assertEquals(listOf(wait), AttentionAlerts(alerted, { 5_000 }).due(listOf(wait)))
    assertTrue(AttentionAlerts(alerted, { 5_000 }).due(listOf(wait)).isEmpty())
    // A new service reloads the persisted keys.
    val reloaded = AttentionAlerts(decodeIds(encodeIds(alerted)), { 20_000 })
    assertTrue(reloaded.due(listOf(wait)).isEmpty())
    val again = wait.copy(updatedAtMs = 30_000)
    assertEquals(listOf(again), reloaded.due(listOf(again)))
    // A wait that began before this poller started was the push's to announce.
    val logs = mutableListOf<String>()
    val older = run("older").copy(status = "waiting_takeover", updatedAtMs = 1_000)
    assertTrue(AttentionAlerts(linkedSetOf(), { 20_000 }, { logs += it }).due(listOf(older)).isEmpty())
    assertEquals(listOf("skip run=older reason=wait_before_poller status=waiting_takeover"), logs)
    // Muted chats and finished runs never alert.
    assertTrue(AttentionAlerts(linkedSetOf()).due(listOf(wait.copy(notificationsEnabled = false), run("done"))).isEmpty())
  }

  @Test
  fun `a push key is taken once and falls back to the delivery id`() {
    val repeats = PushRepeats(linkedSetOf())
    assertEquals("completion:run-1", PushRepeats.key("completion:run-1", "d-1"))
    assertEquals("delivery:d-1", PushRepeats.key("", "d-1"))
    assertEquals("", PushRepeats.key("", ""))
    assertTrue(repeats.firstTime("completion:run-1"))
    assertFalse(repeats.firstTime("completion:run-1"))
    assertTrue(repeats.firstTime(""))
    assertTrue(repeats.firstTime(""))
  }

  @Test
  fun `server times parse from toISOString and anything else is ignored`() {
    assertEquals(1_764_288_000_123L, parseServerTime("2025-11-28T00:00:00.123Z"))
    assertNull(parseServerTime("yesterday"))
    assertNull(parseServerTime(null))
    assertEquals(mapOf("group:g=1" to 5L, "bot:b" to 7L), decodeWatermarks("group:g=1=5\nbot:b=7\nbroken"))
  }

  private fun run(id: String) = RunRecord(
    runId = id,
    spaceId = "space",
    botId = "bot",
    botName = "Bot",
    groupId = null,
    groupName = null,
    threadId = "thread-$id",
    status = "completed",
    prompt = "Prompt",
    trigger = "message",
    notificationsEnabled = true,
  )

  private fun PollCompletions.page(
    recent: List<RunRecord>,
    seeded: Boolean = true,
    settings: NotificationSettings = NotificationSettings(),
    openThreadId: String? = null,
  ): List<RunRecord> = prepare(recent, seeded, settings, { it.threadId == openThreadId }) {
    error("unexpected attention notification")
  }
}
