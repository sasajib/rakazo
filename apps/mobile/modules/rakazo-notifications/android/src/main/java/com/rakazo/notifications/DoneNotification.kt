package com.rakazo.notifications

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import org.json.JSONObject
import java.util.UUID

/**
 * The Done button on a finished-work notification: it records the same ✅ the app's Done button does
 * (`threads/react`), which never wakes a bot, then clears the notification. It needs the stored session,
 * so a signed-out phone shows no button and a failed send leaves the notification to try again.
 */
internal object DoneNotification {
  const val ACTION = "com.rakazo.notifications.DONE"
  const val EXTRA_INPUT = "input"
  const val EXTRA_SPACE = "spaceId"
  const val EXTRA_NOTIFICATION = "notificationId"

  /** The request body for the push, or null when there is nothing to tick (no message, or not finished work). */
  fun reactionInput(data: JSONObject, nonce: String): JSONObject? {
    if (data.optString("kind") != "completion") return null
    val messageId = data.optString("messageId").takeIf(String::isNotBlank) ?: return null
    val groupId = data.optString("groupId")
    val botId = data.optString("botId")
    val input = JSONObject()
    when {
      groupId.isNotBlank() -> input.put("groupId", groupId)
      botId.isNotBlank() -> input.put("botId", botId)
      else -> return null
    }
    return input.put("messageId", messageId).put("reaction", "\u2705").put("clientNonce", nonce)
  }

  fun newNonce(): String = "done-" + UUID.randomUUID()
}

class DoneNotificationReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != DoneNotification.ACTION) return
    val input = runCatching { JSONObject(intent.getStringExtra(DoneNotification.EXTRA_INPUT) ?: "") }.getOrNull() ?: return
    val notificationId = intent.getIntExtra(DoneNotification.EXTRA_NOTIFICATION, 0)
    val spaceFromPush = intent.getStringExtra(DoneNotification.EXTRA_SPACE).orEmpty()
    val pending = goAsync()
    Thread {
      try {
        val storage = NotificationStorage(context)
        val token = storage.token
        if (token.isNotBlank()) {
          // The same nonce is reused on a retry, so a second tap cannot record two ticks.
          rpc(storage.endpoint, token, spaceFromPush.ifBlank { storage.spaceId }, storage.headers, "threads/react", input)
          context.getSystemService(NotificationManager::class.java).cancel(notificationId)
        }
      } catch (error: Exception) {
        // Left in place: the notification stays so the tick can be tried again.
        Log.w("RakazoNotifications", "Could not record Done", error)
      } finally {
        pending.finish()
      }
    }.start()
  }
}
