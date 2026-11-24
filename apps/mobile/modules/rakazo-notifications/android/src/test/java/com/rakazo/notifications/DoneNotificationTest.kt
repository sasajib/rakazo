package com.rakazo.notifications

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DoneNotificationTest {
  private fun push(vararg extra: Pair<String, String>) = JSONObject(
    mapOf("kind" to "completion", "botId" to "bot-1", "threadId" to "thread-1", "messageId" to "msg-1") + extra,
  )

  @Test
  fun `finished work with a message ticks that message for the bot's chat`() {
    val input = DoneNotification.reactionInput(push(), "done-1")!!
    assertEquals("bot-1", input.getString("botId"))
    assertEquals("msg-1", input.getString("messageId"))
    assertEquals("\u2705", input.getString("reaction"))
    assertEquals("done-1", input.getString("clientNonce"))
    assertEquals(false, input.has("groupId"))
  }

  @Test
  fun `a group chat is addressed by its group`() {
    val input = DoneNotification.reactionInput(push("groupId" to "group-1"), "n")!!
    assertEquals("group-1", input.getString("groupId"))
    assertEquals(false, input.has("botId"))
  }

  @Test
  fun `there is nothing to tick without a message, and failures and questions get no button`() {
    assertNull(DoneNotification.reactionInput(JSONObject(mapOf("kind" to "completion", "botId" to "b")), "n"))
    assertNull(DoneNotification.reactionInput(push("kind" to "failure"), "n"))
    assertNull(DoneNotification.reactionInput(push("kind" to "help"), "n"))
  }

  @Test
  fun `each notification gets its own nonce`() {
    assertNotEquals(DoneNotification.newNonce(), DoneNotification.newNonce())
  }
}
