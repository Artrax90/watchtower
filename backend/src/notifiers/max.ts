export interface MaxConfig {
  botToken: string;
  chatId: string;
}

export async function sendMaxMessage(config: MaxConfig, text: string): Promise<{ success: boolean; error?: string }> {
  try {
    const chatId = config.chatId.trim();
    // MAX Bot API: POST https://platform-api2.max.ru/messages?chat_id={chat_id}
    const url = new URL('https://platform-api2.max.ru/messages');
    url.searchParams.append('chat_id', chatId);

    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Authorization': config.botToken.trim(),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: text
      })
    });

    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        success: false,
        error: data?.message || data?.error || `HTTP ${res.status}: ${res.statusText}`
      };
    }

    return { success: true };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Failed to send MAX messenger message'
    };
  }
}
