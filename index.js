const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

// ── Клиенты ──────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WA_TOKEN     = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN; // любая строка, придумай сам
const OWNER_PHONE  = process.env.OWNER_PHONE; // твой номер WhatsApp: 996XXXXXXXXX

// ── Webhook верификация (Meta требует при подключении) ────
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── Приём сообщений ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // отвечаем Meta немедленно

  try {
    const entry   = req.body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;

    if (!value?.messages?.[0]) return;

    const message   = value.messages[0];
    const phone     = message.from;          // номер клиента
    const text      = message.text?.body || '';
    const fromAd    = !!value.referral;      // пришёл из рекламы

    if (message.type !== 'text') return;     // пока только текст

    // ── Загрузить данные из Supabase ──────────────────────
    const [
      { data: products },
      { data: bonuses  },
      { data: media    },
      { data: convRows }
    ] = await Promise.all([
      supabase.from('products').select('*').eq('active', true),
      supabase.from('bonuses').select('*').eq('active', true),
      supabase.from('media').select('*').eq('active', true),
      supabase.from('conversations').select('*').eq('phone', phone)
    ]);

    const focusProduct  = products?.find(p => p.is_focus) || products?.[0];
    const otherProducts = products?.filter(p => !p.is_focus).map(p => p.name).join(', ') || '';
    const bonus         = bonuses?.[0];
    const mediaKeys     = media?.map(m => m.key).join(', ') || '';
    const conv          = convRows?.[0];
    const history       = conv?.history || [];

    // ── Собрать system prompt ─────────────────────────────
    const systemPrompt = `
Ты — продавец-консультант интернет-магазина KOZUTAY (Бишкек). Ты продаёшь товары для мам и малышей. Ты общаешься с клиентом в WhatsApp. Твоя цель — довести клиента до телефонного звонка с владельцем, а если отказывается от звонка — продать в переписке.

# ЯЗЫК
- По умолчанию отвечай на КЫРГЫЗСКОМ языке.
- Первое сообщение из рекламы может быть на русском — это НЕ выбор клиента. Определяй язык по тому, что клиент пишет сам.
- Русские слова внутри кыргызской фразы («ценасын эле айт», «доставкасы канча», «заказ берсем болобу») — это кыргызский. Отвечай по-кыргызски.
- Переходи на русский ТОЛЬКО если клиент пишет целыми русскими фразами с русской грамматикой.
- При сомнении — кыргызский.

# ТВОЙ ХАРАКТЕР
- Тёплый, доброжелательный, уверенный.
- Эмодзи умеренно (1-2 на сообщение).
- Сообщения короткие, как в живой переписке.
- Говори от лица KOZUTAY: «у нас», «мы».

# ДАННЫЕ О ТОВАРАХ
Текущий товар в фокусе: ${focusProduct?.name || ''}
Цена: ${focusProduct?.price || ''} сом
В наличии: ${focusProduct?.stock || ''}
Комплект: ${focusProduct?.kit || ''}
Гарантия: ${focusProduct?.warranty || ''}
Бонус за заказ сегодня: ${bonus?.name || ''} — ${bonus?.description || ''}
Другие товары магазина: ${otherProducts}
Доступные медиа (ключи): ${mediaKeys}

ВАЖНО: Бери данные ТОЛЬКО из блока выше. Никогда не выдумывай цифры.

# ГЛАВНАЯ ЦЕЛЬ
Приоритет — довести клиента до ТЕЛЕФОННОГО ЗВОНКА. После лёгкого прогрева (приветствие, пара вопросов) мягко предложи звонок:
«Сизге чалып, баарын толук айтып берейинби? Кайсы убакта ыңгайлуу — азырбы же кечкисинби? 😊»
Если отказалась — не настаивай, продолжай продавать в переписке.

# СКРИПТ — 5 ЭТАПОВ
1. ОТКРЫТИЕ — тёплое приветствие
2. ПРОГРАММИРОВАНИЕ — возьми инициативу: «пара вопросов, чтобы подобрать лучшее»
3. ВОПРОСЫ — для кого товар, что важно
4. ПРЕЗЕНТАЦИЯ — выгода для ребёнка, здесь можно отправить фото/видео
5. ЗАКРЫТИЕ — ассумптивное: «давайте оформлю, скажите адрес» или предложи звонок

# ПРАВИЛА
1. СКИДКИ: никогда не снижай цену. На просьбу о скидке → бонус («${bonus?.name || ''}»), не скидка.
2. ЦЕНА СРАЗУ: если требуют — называй немедленно, оберни в ценность, верни в скрипт вопросом.
3. АССУМПТИВНОЕ ЗАКРЫТИЕ: не «будете брать?», а «давайте оформлю, скажите адрес».
4. КОНКУРЕНТЫ: не спорь, объясни за что цена (тихий мотор, гарантия).
5. НЕ ПО ТЕМЕ: мягко верни в русло.

# ВОЗРАЖЕНИЕ ПО ЦЕНЕ
«Сизди түшүнөм 🙂 Баанын өзүн түшүрө албайм — ${focusProduct?.price || ''} акыркы адилет баа, себеби сапаттуу мотор жана ${focusProduct?.warranty || ''} кепилдик. Бирок бүгүн заказ берсеңиз, белекке ${bonus?.name || ''} кошом — ${bonus?.description || ''}. Дарегиңизди жазыңыз, бүгүн жөнөтөйүн 😊»

# МАРШРУТИЗАЦИЯ
1. Про товар → отвечай из данных. Нет данных → need_human: true.
2. Другой товар → переключись и продавай его.
3. Не по теме → мягко верни в русло.
4. Жалоба/возврат/спор → need_human: true, скажи «секунду, уточню».

# МЕДИА
Чтобы отправить фото/видео — укажи ключ в поле "media". Уместно на этапе презентации или когда спрашивают «как выглядит».

# ФОРМАТ ОТВЕТА — СТРОГО JSON
{
  "reply": "текст клиенту",
  "media": [],
  "stage": "opening",
  "call_requested": false,
  "call_time": "",
  "need_human": false
}
Только JSON, без markdown, без пояснений.
`.trim();

    // ── Добавить сообщение клиента в историю ─────────────
    const updatedHistory = [
      ...history,
      { role: 'user', content: text, ts: new Date().toISOString() }
    ];

    // ── Запрос к Claude ───────────────────────────────────
    const claudeMessages = updatedHistory.map(m => ({
      role: m.role,
      content: m.content
    }));

    const claudeResp = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: systemPrompt,
      messages: claudeMessages
    });

    const rawText = claudeResp.content[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { reply: rawText, media: [], stage: 'unknown', call_requested: false, call_time: '', need_human: false };
    }

    const { reply, media: mediaToSend, stage, call_requested, call_time, need_human } = parsed;

    // ── Отправить текстовый ответ клиенту ─────────────────
    if (reply) {
      await sendWhatsAppText(phone, reply);
    }

    // ── Отправить медиа если нужно ────────────────────────
    if (mediaToSend?.length) {
      for (const key of mediaToSend) {
        const mediaItem = media?.find(m => m.key === key);
        if (mediaItem) {
          await sendWhatsAppMedia(phone, mediaItem);
        }
      }
    }

    // ── Уведомить тебя если нужен звонок или человек ──────
    if (call_requested) {
      await sendWhatsAppText(OWNER_PHONE,
        `📞 КОЗУТАЙ БОТ: Клиент ${phone} согласился на звонок!\nУдобное время: ${call_time || 'не указал'}\nПозвони ему.`
      );
    }
    if (need_human) {
      await sendWhatsAppText(OWNER_PHONE,
        `⚠️ КОЗУТАЙ БОТ: Клиент ${phone} задал сложный вопрос.\nБот ждёт тебя. Зайди в WhatsApp и ответь.`
      );
    }

    // ── Сохранить историю в Supabase ─────────────────────
    const newHistory = [
      ...updatedHistory,
      { role: 'assistant', content: reply, ts: new Date().toISOString() }
    ];

    if (conv) {
      await supabase.from('conversations').update({
        history: newHistory,
        current_stage: stage,
        call_requested: call_requested || conv.call_requested,
        call_time: call_time || conv.call_time,
        need_human,
        last_message_at: new Date().toISOString()
      }).eq('phone', phone);
    } else {
      await supabase.from('conversations').insert({
        phone,
        from_ad: fromAd,
        history: newHistory,
        current_stage: stage,
        call_requested,
        call_time,
        need_human,
        last_message_at: new Date().toISOString()
      });
    }

  } catch (err) {
    console.error('Webhook error:', err);
  }
});

// ── Вспомогательные функции ───────────────────────────────
async function sendWhatsAppText(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: text }
    })
  });
}

async function sendWhatsAppMedia(to, mediaItem) {
  const type = mediaItem.type === 'image' ? 'image' : 'video';
  await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${WA_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type,
      [type]: {
        link: mediaItem.url,
        caption: mediaItem.caption || ''
      }
    })
  });
}

// ── Старт ─────────────────────────────────────────────────
module.exports = app;
