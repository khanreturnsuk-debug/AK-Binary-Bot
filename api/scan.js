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

    try {
        const body = req.body || {};
        const rawPair = (body.pair || body.ticker || 'EURUSD').toUpperCase();
        // Clean pair format for TradingView (e.g. USD/JPY -> USDJPY)
        const cleanPair = rawPair.replace(/[^A-Z0-9]/g, '');

        let symbol = `FX_IDC:${cleanPair}`;
        if (cleanPair.includes("USDT") || cleanPair.includes("BTC") || cleanPair.includes("ETH")) {
            symbol = `BINANCE:${cleanPair}`;
        }

        const tvQuery = {
            symbols: { tickers: [symbol], query: { types: [] } },
            columns: ["RSI", "EMA9", "EMA21", "Recommend.All", "volume"]
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

        if (tvData.data && tvData.data.length > 0) {
            const indicators = tvData.data[0].d;
            const rsiVal = indicators[0] ? Math.round(indicators[0]) : 50;
            const ema9 = indicators[1];
            const ema21 = indicators[2];
            const recAll = indicators[3]; // -1 to 1

            let direction = "WAIT";
            let statusText = "NEUTRAL MARKET";

            if (recAll > 0.1 || (ema9 > ema21 && rsiVal > 50)) {
                direction = "CALL";
                statusText = "BULLISH MOMENTUM";
            } else if (recAll < -0.1 || (ema9 < ema21 && rsiVal < 50)) {
                direction = "PUT";
                statusText = "BEARISH MOMENTUM";
            }

            const confidence = Math.min(Math.floor(75 + Math.abs(recAll) * 20), 98);

            return res.status(200).json({
                dir: direction,
                score: confidence,
                ema: ema9 > ema21 ? "BULLISH" : "BEARISH",
                rsi: `${rsiVal} (${rsiVal > 50 ? "BULLISH" : "BEARISH"})`,
                vol: "HIGH VOLUME",
                status: statusText
            });
        }

        throw new Error("No TradingView data found");

    } catch (error) {
        console.error("Scanner Error:", error);
        return res.status(200).json({
            dir: "WAIT",
            score: 50,
            ema: "NEUTRAL",
            rsi: "50 (NEUTRAL)",
            vol: "NORMAL",
            status: "MARKET SCANNING..."
        });
    }
}
