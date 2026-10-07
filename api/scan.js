export default async function handler(req, res) {
    // CORS Headers allow karne ke liye
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    // Preflight request handle karne ke liye
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const body = req.body || {};
        const pair = (body.pair || body.ticker || 'EURUSD').toUpperCase();
        const tf = body.timeframe || '1m';

        // TradingView Symbol Format Fix
        let symbol = pair.includes("USDT") ? `BINANCE:${pair}` : `FX_IDC:${pair}`;
        
        // TradingView Scanner Query
        const tvQuery = {
            symbols: { tickers: [symbol], query: { types: [] } },
            columns: [
                "RSI",          // Relative Strength Index
                "EMA9",         // Moving Average 9
                "EMA21",        // Moving Average 21
                "Recommend.All",// Combined TradingView Rating (-1 to 1)
                "volume"        // Live Volume
            ]
        };

        // Fetch Data from TradingView Crypto Scanner
        let tvResponse = await fetch(`https://scanner.tradingview.com/crypto/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(tvQuery)
        });

        let tvData = await tvResponse.json();

        // Agar Forex symbol crypto scanner par na miley to Forex scanner try karein
        if (!tvData.data || tvData.data.length === 0) {
            tvResponse = await fetch(`https://scanner.tradingview.com/forex/scan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(tvQuery)
            });
            tvData = await tvResponse.json();
        }

        // Fallback agar TradingView se
