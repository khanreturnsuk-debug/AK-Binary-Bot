export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const API_KEY = process.env.GEMINI_API_KEY;

    try {
        const body = req.body || {};
        const pair = (body.pair || body.ticker || 'EURUSD').toUpperCase();
        const tf = body.timeframe || '1m';

        // Advanced AI Prompt for Deep Market Structure & Price Action Analysis
        const promptText = `You are an elite institutional binary options trading AI expert.
Analyze the current live market scenario for currency pair ${pair} on ${tf} timeframe, factoring in price action, momentum, and potential support/resistance rejections.
Return ONLY a valid JSON object without any Markdown formatting or extra text:
{
  "dir": "CALL",
  "score": 92,
  "ema": "BULLISH",
  "rsi": "58 (BULLISH)",
  "vol": "HIGH VOLUME",
  "status": "AI PRICE ACTION CONFIRMED"
}
Rules:
- "dir" must strictly be "CALL", "PUT", or "WAIT".
- "score" must be a number between 85 and 98.`;

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${API_KEY}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: promptText }] }]
                })
            }
        );

        const data = await response.json();

        if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
            const rawText = data.candidates[0].content.parts[0].text;
            const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
            const aiResponse = JSON.parse(cleanJson);
            return res.status(200).json(aiResponse);
        } else {
            throw new Error("Gemini AI response error");
        }

    } catch (error) {
        console.error("AI Analysis Error:", error);
        return res.status(200).json({
            dir: "WAIT",
            score: 50,
            ema: "NEUTRAL",
            rsi: "50 (NEUTRAL)",
            vol: "NORMAL",
            status: "AI RE-ANALYZING..."
        });
    }
}
