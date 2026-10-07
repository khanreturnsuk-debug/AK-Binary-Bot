import express from 'express';
import cors from 'cors';
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/', (req, res) => {
    res.send("AK Scalper Bot AI Backend is Running!");
});

app.post('/api/scan', async (req, res) => {
    const { ticker } = req.body;

    try {
        // 1. Fetch Accurate Technical Analysis Data from TradingView
        const symbolParts = ticker.split(':');
        const exchange = symbolParts.length > 1 ? symbolParts[0] : "FX_IDC";
        const pair = symbolParts.length > 1 ? symbolParts[1] : ticker;

        const tvResponse = await fetch('https://scanner.tradingview.com/forex/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                symbols: { tickers: [`${exchange}:${pair}`] },
                columns: ["RSI", "EMA10", "EMA20", "Recommend.All"]
            })
        });

        const tvJson = await tvResponse.json();
        
        let rsi = 50, ema10 = 0, ema20 = 0, summaryScore = 0;

        if (tvJson.data && tvJson.data.length > 0) {
            const values = tvJson.data[0].s ? tvJson.data[0].d : [];
            rsi = Math.round(values[0] || 50);
            ema10 = values[1] || 0;
            ema20 = values[2] || 0;
            summaryScore = values[3] || 0;
        }

        // 2. Process Market Conditions using Gemini AI Engine
        const model = genAI.getGenerativeModel({ 
            model: "gemini-1.5-flash",
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
        You are an elite Institutional Binary Options Scalping AI Engine.
        Analyze live technical indicator state for ticker ${ticker}:
        - RSI (14): ${rsi}
        - EMA 10: ${ema10} vs EMA 20: ${ema20}
        - TradingView Summary Recommendation (-1 to +1): ${summaryScore}

        Binary Options Scalping Rules:
        - Output CALL if RSI is between 50-70 AND EMA10 > EMA20 AND Recommendation > 0.2 (Strong Momentum).
        - Output PUT if RSI is between 30-50 AND EMA10 < EMA20 AND Recommendation < -0.2 (Strong Downtrend).
        - Output WAIT if RSI is Overbought (>70) or Oversold (<30) or trend signals conflict.

        Required Output Schema (JSON only):
        {
            "dir": "CALL" | "PUT" | "WAIT",
            "score": number between 75 and 98,
            "status": "Short reason in 3-4 words"
        }
        `;

        const result = await model.generateContent(prompt);
        let rawText = result.response.text().trim();
        
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const aiData = JSON.parse(rawText);

        return res.status(200).json({
            success: true,
            data: {
                summary: summaryScore,
                rsi: rsi,
                ema10: ema10,
                ema20: ema20,
                dir: aiData.dir,
                score: aiData.score,
                status: aiData.status
            }
        });

    } catch (error) {
        console.error("AI Scan Server Error:", error);
        return res.status(500).json({
            success: false,
            message: "AI Processing Error",
            data: {
                summary: 0,
                rsi: 50,
                ema10: 0,
                ema20: 0,
                dir: "WAIT",
                score: 0,
                status: "AI SERVICE TIMEOUT"
            }
        });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

export default app;
