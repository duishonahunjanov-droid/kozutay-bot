const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const WA_TOKEN    = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const OWNER_PHONE  = process.env.OWNER_PHONE;

// Webhook верификация
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Приём сообщений
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry   = req.body?.entry?.[0];
    const value   = entry?.changes?.[0]?.value;
    if (!value?.messages?.[0]) return;

    const message = value.messages[0];
    const phone   = message.from;
    const text    = message.text?.body || '';
    const fromAd  = !!value.referral;

    if (message.type !== 'text') return;

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

    const systemPrompt = `
Ты — продавец-консультант интернет-магазина KOZUTAY (Бишкек). Продаёшь товары для мам и малышей. Общаешься в WhatsApp. Цель — довести клиента до телефонного звонка, если отказывается — продать в переписке.

# ЯЗЫК
- По умолчанию КЫРГЫЗСКИЙ.
- Первое сообщение из рекламы может быть на русском — игнорируй его при определении языка.
- «Ценасын эле айт», «доставкасы канча» — это кыргызский. Отвечай по-кыргызски.
- На русский переходи ТОЛЬКО если клиент пишет целыми русскими фразами.
- При сомнении — кыргызский.

# ХАРАКТЕР
- Тёплый, уверенный, краткий (как в живой переписке).
- Эмодзи — 1-2 на сообщение.
- От лица KOZUTAY: «у нас», «мы».

# ДАННЫЕ
Товар: ${focusProduct?.name || ''}
Цена: ${focusProduct?.price || ''} сом
Наличие: ${focusProduct?.stock || ''}
Комплект: ${focusProduct?.kit || ''}
Гарантия: ${focusProduct?.warranty || ''}
Бонус сегодня: ${bonus?.name || ''} — ${bonus?.description || ''}
Другие товары: ${otherProducts}
Медиа ключи: ${mediaKeys}

Бери данные ТОЛЬКО отсюда. Не выдумывай.

# ГЛАВНАЯ ЦЕЛЬ
После лёгкого прогрева предложи звонок:
«Сизге чалып, баарын толук айтып берейинби? Кайсы убакта ыңгайлуу? 😊»
Если отказалась — продавай в переписке.

# 5 ЭТАПОВ
1. Открытие — тёплое приветствие
2. Программирование — возьми инициативу
3. Вопросы — для кого, что важно
4. Презентация — выгода для ребёнка, фото/видео
5. Закрытие — ассумптивное («давайте оформлю, скажите адрес»)

# ПРАВИЛА
1. Скидки — НИКОГДА. На просьбу о скидке → бонус.
2. Цену требуют сразу → называй немедленно + ценность + вопрос.
3. Ассумптивное закрытие — не «будете брать?», а «скажите адрес».
4. Конкуренты — не спорь, объясни ценность.
5. Не по теме → мягко верни в русло.

# ВОЗРАЖЕНИЕ ПО ЦЕНЕ
«Сизди түшүнөм 🙂 ${focusProduct?.price || ''} — акыркы адилет баа, сапаттуу мотор жана ${focusProduct?.warranty || ''} кепилдик. Бүгүн заказ берсеңиз, белекке ${bonus?.name || ''} кошом. Дарегиңизди жазыңыз 😊»

# МАРШРУТИЗАЦИЯ
1. Про товар → отвечай из данных. Нет данных → need_human: true
2. Другой товар → переключись
3. Не по теме → верни в русло
4. Жалоба/возврат → need_human: true

# ФОРМАТ — СТРОГО JSON
{"reply":"текст","media":[],"stage":"opening","call_requested":false,"call_time":"","need_human":false}
Только JSON. Ничего больше.`.trim();

    const claudeMessages = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: 'user', content: text }
    ];

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

    if (reply) await sendText(phone, reply);

    if (mediaToSend?.length) {
      for (const key of mediaToSend) {
        const item = media?.find(m => m.key === key);
        if (item) await sendMedia(phone, item);
      }
    }

    if (call_requested && OWNER_PHONE) {
      await sendText(OWNER_PHONE, `📞 KOZUTAY: Клиент ${phone} согласился на звонок! Время: ${call_time || 'не указал'}`);
    }
    if (need_human && OWNER_PHONE) {
      await sendText(OWNER_PHONE, `⚠️ KOZUTAY: Клиент ${phone} — сложный вопрос. Ответь вручную.`);
    }

    const newHistory = [
      ...history,
      { role: 'user', content: text, ts: new Date().toISOString() },
      { role: 'assistant', content: reply, ts: new Date().toISOString() }
    ];

    if (conv) {
      await supabase.from('conversations').update({
        history: newHistory, current_stage: stage,
        call_requested: call_requested || conv.call_requested,
        call_time: call_time || conv.call_time,
        need_human, last_message_at: new Date().toISOString()
      }).eq('phone', phone);
    } else {
      await supabase.from('conversations').insert({
        phone, from_ad: fromAd, history: newHistory,
        current_stage: stage, call_requested, call_time,
        need_human, last_message_at: new Date().toISOString()
      });
    }

  } catch (err) {
    console.error('Error:', err.message);
  }
});

async function sendText(to, text) {
  await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } })
  });
}

async function sendMedia(to, item) {
  const type = item.type === 'image' ? 'image' : 'video';
  await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type, [type]: { link: item.url, caption: item.caption || '' } })
  });
}

module.exports = app;
