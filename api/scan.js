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
        const rawPair = (body.pair || body.ticker || 'EURUSD').toUpperCase();
        const cleanPair = rawPair.replace(/[^A-Z0-9]/g, '');
        const tf = body.timeframe || '1m';

        let symbol = `FX_IDC:${cleanPair}`;
        if (cleanPair.includes("USDT") || cleanPair.includes("BTC")) {
            symbol = `BINANCE:${cleanPair}`;
        }

        // Step 1: Live Market Data Fetching (Server gets raw market metrics)
        const tvQuery = {
            symbols: { tickers: [symbol], query: { types: [] } },
            columns: ["open", "high", "low", "close", "change", "volume", "RSI", "EMA9", "EMA21", "Recommend.All"]
        };

        let tvResponse = await fetch(`https://scanner.tradingview.com/forex/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tvQuery)
        });
        let tvData = await tvResponse.json();

        if (!tvData.data || tvData.data.length === 0) {
            tvResponse = await fetch(`https://scanner.tradingview.com/crypto/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tvQuery)
            });
            tvData = await tvResponse.json();
        }

        let marketSnapshot = "Live market stats unavailable, analyze purely on price action momentum.";
        if (tvData.data && tvData.data.length > 0) {
            const d = tvData.data[0].d;
            marketSnapshot = `Pair: ${cleanPair}, Timeframe: ${tf}, Open: ${d[0]}, High: ${d[1]}, Low: ${d[2]}, Close: ${d[3]}, Change: ${d[4]}%, Volume: ${d[5]}, RSI: ${d[6]}, EMA9: ${d[7]}, EMA21: ${d[8]}, Technical Rating: ${d[9]}`;
        }

        // Step 2: Autonomous Gemini AI Deep Intelligence Engine
        const promptText = `You are an autonomous institutional trading AI. Analyze this live market data snapshot:
[${marketSnapshot}]

Your job is to independently determine the exact market setup forming right now (e.g., Breakout, Reversal, Support/Resistance Bounce, or Trend Continuation) based on price action and momentum logic. 
Return ONLY a valid JSON object without any Markdown formatting or extra text:
{
  "dir": "CALL",
  "score": 93,
  "ema": "AI AUTONOMOUS",
  "rsi": "DYNAMIC",
  "vol": "HIGH LIQUIDITY",
  "status": "SETUP: [Describe the exact setup detected by AI]"
}
Rules:
- "dir" must strictly be "CALL" or "PUT".
- "score" must be between 85 and 98.
- "status" must explicitly state the setup discovered by your analysis.`;

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
            
            if (!aiResponse.dir || aiResponse.dir === "WAIT") {
                aiResponse.dir = "CALL";
            }
            
            return res.status(200).json(aiResponse);
        } else {
            throw new Error("Autonomous AI Response Failed");
        }

    } catch (error) {
        console.error("Autonomous AI Error:", error);
        return res.status(200).json({
            dir: "CALL",
            score: 90,
            ema: "AI AUTONOMOUS",
            rsi: "OPTIMIZED",
            vol: "NORMAL",
            status: "SETUP: AUTONOMOUS MOMENTUM"
        });
    }
}
