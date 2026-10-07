const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/scan', async (req, res) => {
    try {
        const { ticker } = req.body;

        if (!ticker) {
            return res.status(400).json({ success: false, message: "Ticker is required" });
        }

        const tvResponse = await axios.post('https://scanner.tradingview.com/forex/scan', {
            symbols: { tickers: [ticker] },
            columns: ["Recommend.All", "RSI", "EMA10", "EMA20", "Recommend.Other"]
        }, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Content-Type': 'application/json'
            },
            timeout: 8000
        });

        if (tvResponse.data && tvResponse.data.data && tvResponse.data.data.length > 0) {
            const d = tvResponse.data.data[0].d;
            return res.json({
                success: true,
                data: {
                    summary: d[0] || 0,
                    rsi: d[1] || 50,
                    ema10: d[2] || 0,
                    ema20: d[3] || 0,
                    osculators: d[4] || 0
                }
            });
        } else {
            return res.status(404).json({ success: false, message: "Data not found" });
        }
    } catch (error) {
        console.error("TradingView Error:", error.message);
        return res.status(500).json({ success: false, message: "Backend fetch failed", error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
module.exports = app;
