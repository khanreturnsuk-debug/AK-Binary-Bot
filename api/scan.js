export default async function handler(req, res) {
    // =========================================================
    // CORS
    // =========================================================
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
        "Access-Control-Allow-Methods",
        "GET,OPTIONS,PATCH,DELETE,POST,PUT"
    );
    res.setHeader(
        "Access-Control-Allow-Headers",
        "X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version"
    );

    if (req.method === "OPTIONS") {
        return res.status(200).end();
    }

    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const GEMINI_MODEL =
        process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

    // =========================================================
    // BASIC HELPERS
    // =========================================================

    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    const clamp = (n, min, max) =>
        Math.max(min, Math.min(max, n));

    const round = (n, d = 5) =>
        Number(Number(n).toFixed(d));

    const sleep = (ms) =>
        new Promise(resolve => setTimeout(resolve, ms));

    // =========================================================
    // PAIR / SYMBOL
    // =========================================================

    function normalizePair(input) {
        return String(input || "EURUSD")
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, "")
            .replace(/^FX/, "");
    }

    function isCrypto(pair) {
        return (
            pair.endsWith("USDT") ||
            pair.endsWith("USDC") ||
            pair.includes("BTC") ||
            pair.includes("ETH") ||
            pair.includes("SOL")
        );
    }

    function yahooSymbol(pair) {
        // EURUSD -> EURUSD=X
        // EURJPY -> EURJPY=X
        return `${pair}=X`;
    }

    function binanceSymbol(pair) {
        return pair;
    }

    // =========================================================
    // TIMEFRAME
    // =========================================================

    function normalizeTimeframe(tf) {
        const allowed = ["1m", "5m", "15m", "30m", "1h"];

        if (!allowed.includes(tf)) {
            return "1m";
        }

        return tf;
    }

    function yahooConfig(tf) {
        switch (tf) {
            case "1m":
                return {
                    interval: "1m",
                    range: "1d"
                };

            case "5m":
                return {
                    interval: "5m",
                    range: "5d"
                };

            case "15m":
                return {
                    interval: "15m",
                    range: "60d"
                };

            case "30m":
                return {
                    interval: "30m",
                    range: "60d"
                };

            case "1h":
                return {
                    interval: "1h",
                    range: "730d"
                };

            default:
                return {
                    interval: "1m",
                    range: "1d"
                };
        }
    }

    // =========================================================
    // FETCH CRYPTO CANDLES
    // =========================================================

    async function fetchBinanceCandles(pair, tf) {
        const intervalMap = {
            "1m": "1m",
            "5m": "5m",
            "15m": "15m",
            "30m": "30m",
            "1h": "1h"
        };

        const interval = intervalMap[tf] || "1m";

        const url =
            `https://api.binance.com/api/v3/klines` +
            `?symbol=${encodeURIComponent(binanceSymbol(pair))}` +
            `&interval=${interval}` +
            `&limit=250`;

        const response = await fetch(url, {
            headers: {
                "User-Agent": "AK-Trader-Bot/1.0"
            }
        });

        if (!response.ok) {
            throw new Error(`Binance HTTP ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data) || data.length < 80) {
            throw new Error("Insufficient Binance candles");
        }

        return data.map(c => ({
            time: Number(c[0]),
            open: Number(c[1]),
            high: Number(c[2]),
            low: Number(c[3]),
            close: Number(c[4]),
            volume: Number(c[5])
        }));
    }

    // =========================================================
    // FETCH FOREX CANDLES
    // =========================================================

    async function fetchYahooCandles(pair, tf) {
        const cfg = yahooConfig(tf);

        const url =
            `https://query1.finance.yahoo.com/v8/finance/chart/` +
            `${encodeURIComponent(yahooSymbol(pair))}` +
            `?interval=${cfg.interval}&range=${cfg.range}`;

        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        if (!response.ok) {
            throw new Error(`Yahoo HTTP ${response.status}`);
        }

        const data = await response.json();

        const result = data?.chart?.result?.[0];

        if (!result) {
            throw new Error("Yahoo returned no chart data");
        }

        const timestamps = result.timestamp || [];
        const q = result.indicators?.quote?.[0];

        if (!q) {
            throw new Error("Yahoo quote data missing");
        }

        const candles = [];

        for (let i = 0; i < timestamps.length; i++) {
            const open = num(q.open?.[i]);
            const high = num(q.high?.[i]);
            const low = num(q.low?.[i]);
            const close = num(q.close?.[i]);
            const volume = num(q.volume?.[i]) || 0;

            if (
                open !== null &&
                high !== null &&
                low !== null &&
                close !== null
            ) {
                candles.push({
                    time: timestamps[i] * 1000,
                    open,
                    high,
                    low,
                    close,
                    volume
                });
            }
        }

        if (candles.length < 80) {
            throw new Error(
                `Only ${candles.length} valid candles received`
            );
        }

        return candles.slice(-250);
    }

    // =========================================================
    // EMA
    // =========================================================

    function ema(values, period) {
        if (values.length < period) return null;

        const multiplier = 2 / (period + 1);

        let result =
            values
                .slice(0, period)
                .reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < values.length; i++) {
            result =
                (values[i] - result) * multiplier + result;
        }

        return result;
    }

    // =========================================================
    // RSI
    // =========================================================

    function calculateRSI(closes, period = 14) {
        if (closes.length <= period) return null;

        let gains = 0;
        let losses = 0;

        for (let i = 1; i <= period; i++) {
            const change = closes[i] - closes[i - 1];

            if (change >= 0) {
                gains += change;
            } else {
                losses += Math.abs(change);
            }
        }

        let avgGain = gains / period;
        let avgLoss = losses / period;

        for (let i = period + 1; i < closes.length; i++) {
            const change = closes[i] - closes[i - 1];

            const gain = change > 0 ? change : 0;
            const loss = change < 0 ? Math.abs(change) : 0;

            avgGain =
                (avgGain * (period - 1) + gain) / period;

            avgLoss =
                (avgLoss * (period - 1) + loss) / period;
        }

        if (avgLoss === 0) return 100;

        const rs = avgGain / avgLoss;

        return 100 - 100 / (1 + rs);
    }

    // =========================================================
    // ATR
    // =========================================================

    function calculateATR(candles, period = 14) {
        if (candles.length <= period) return null;

        const trs = [];

        for (let i = 1; i < candles.length; i++) {
            const current = candles[i];
            const previous = candles[i - 1];

            const tr = Math.max(
                current.high - current.low,
                Math.abs(current.high - previous.close),
                Math.abs(current.low - previous.close)
            );

            trs.push(tr);
        }

        if (trs.length < period) return null;

        let atr =
            trs
                .slice(0, period)
                .reduce((a, b) => a + b, 0) / period;

        for (let i = period; i < trs.length; i++) {
            atr =
                (atr * (period - 1) + trs[i]) / period;
        }

        return atr;
    }

    // =========================================================
    // MACD
    // =========================================================

    function calculateMACD(closes) {
        const fast = ema(closes, 12);
        const slow = ema(closes, 26);

        if (fast === null || slow === null) {
            return {
                macd: null,
                signal: null,
                histogram: null
            };
        }

        // Approximate MACD signal from recent MACD sequence
        const macdSeries = [];

        for (let i = 26; i <= closes.length; i++) {
            const slice = closes.slice(0, i);

            const e12 = ema(slice, 12);
            const e26 = ema(slice, 26);

            if (e12 !== null && e26 !== null) {
                macdSeries.push(e12 - e26);
            }
        }

        const signal = ema(macdSeries, 9);

        const macd = fast - slow;

        return {
            macd,
            signal,
            histogram:
                signal === null ? null : macd - signal
        };
    }

    // =========================================================
    // CANDLE ANALYSIS
    // =========================================================

    function candleInfo(candle) {
        const range = candle.high - candle.low;

        if (range <= 0) {
            return {
                body: 0,
                upperWick: 0,
                lowerWick: 0,
                bodyRatio: 0,
                bullish: false,
                bearish: false
            };
        }

        const body = Math.abs(
            candle.close - candle.open
        );

        const upperWick =
            candle.high -
            Math.max(candle.open, candle.close);

        const lowerWick =
            Math.min(candle.open, candle.close) -
            candle.low;

        return {
            body,
            upperWick,
            lowerWick,
            bodyRatio: body / range,
            bullish: candle.close > candle.open,
            bearish: candle.close < candle.open
        };
    }

    // =========================================================
    // SUPPORT / RESISTANCE
    // =========================================================

    function calculateLevels(candles) {
        const recent = candles.slice(-80);

        const highs = recent.map(c => c.high);
        const lows = recent.map(c => c.low);

        const resistance =
            Math.max(...highs);

        const support =
            Math.min(...lows);

        const current =
            candles[candles.length - 1].close;

        // Local swing levels
        const swingHighs = [];
        const swingLows = [];

        for (let i = 2; i < recent.length - 2; i++) {
            const c = recent[i];

            if (
                c.high > recent[i - 1].high &&
                c.high > recent[i - 2].high &&
                c.high > recent[i + 1].high &&
                c.high > recent[i + 2].high
            ) {
                swingHighs.push(c.high);
            }

            if (
                c.low < recent[i - 1].low &&
                c.low < recent[i - 2].low &&
                c.low < recent[i + 1].low &&
                c.low < recent[i + 2].low
            ) {
                swingLows.push(c.low);
            }
        }

        const nearestResistance =
            swingHighs.length
                ? Math.min(
                      ...swingHighs.filter(
                          x => x >= current
                      )
                  )
                : resistance;

        const nearestSupport =
            swingLows.length
                ? Math.max(
                      ...swingLows.filter(
                          x => x <= current
                      )
                  )
                : support;

        return {
            support:
                Number.isFinite(nearestSupport)
                    ? nearestSupport
                    : support,

            resistance:
                Number.isFinite(nearestResistance)
                    ? nearestResistance
                    : resistance
        };
    }

    // =========================================================
    // MARKET STRUCTURE
    // =========================================================

    function marketStructure(candles) {
        const closes = candles.map(c => c.close);

        const current = closes[closes.length - 1];

        const ema9 = ema(closes, 9);
        const ema21 = ema(closes, 21);
        const ema50 = ema(closes, 50);

        const previous21 =
            ema(closes.slice(0, -5), 21);

        let trend = "SIDEWAYS";

        if (
            ema9 !== null &&
            ema21 !== null &&
            ema50 !== null
        ) {
            if (
                ema9 > ema21 &&
                ema21 > ema50 &&
                current > ema9
            ) {
                trend = "UPTREND";
            } else if (
                ema9 < ema21 &&
                ema21 < ema50 &&
                current < ema9
            ) {
                trend = "DOWNTREND";
            }
        }

        let emaSlope = "FLAT";

        if (
            previous21 !== null &&
            ema21 !== null
        ) {
            const difference =
                ema21 - previous21;

            if (difference > 0) {
                emaSlope = "UP";
            } else if (difference < 0) {
                emaSlope = "DOWN";
            }
        }

        return {
            trend,
            ema9,
            ema21,
            ema50,
            emaSlope
        };
    }

    // =========================================================
    // TECHNICAL ENGINE
    // =========================================================

    function analyzeMarket(candles) {
        const closes =
            candles.map(c => c.close);

        const current =
            closes[closes.length - 1];

        const previous =
            candles[candles.length - 2];

        const last =
            candles[candles.length - 1];

        const previous2 =
            candles[candles.length - 3];

        const rsi =
            calculateRSI(closes, 14);

        const atr =
            calculateATR(candles, 14);

        const macd =
            calculateMACD(closes);

        const structure =
            marketStructure(candles);

        const levels =
            calculateLevels(candles);

        const candle =
            candleInfo(previous);

        const currentCandle =
            candleInfo(last);

        // =====================================================
        // SCORE
        // =====================================================

        let callScore = 0;
        let putScore = 0;

        const reasons = [];

        // -----------------------------
        // TREND
        // -----------------------------

        if (structure.trend === "UPTREND") {
            callScore += 20;
            reasons.push("EMA trend bullish");
        }

        if (structure.trend === "DOWNTREND") {
            putScore += 20;
            reasons.push("EMA trend bearish");
        }

        // -----------------------------
        // EMA SLOPE
        // -----------------------------

        if (structure.emaSlope === "UP") {
            callScore += 8;
        }

        if (structure.emaSlope === "DOWN") {
            putScore += 8;
        }

        // -----------------------------
        // RSI
        // -----------------------------

        if (rsi !== null) {
            if (rsi >= 50 && rsi <= 68) {
                callScore += 12;
                reasons.push("RSI bullish zone");
            }

            if (rsi <= 50 && rsi >= 32) {
                putScore += 12;
                reasons.push("RSI bearish zone");
            }

            // Extreme zones reduce continuation confidence
            if (rsi > 75) {
                callScore -= 12;
            }

            if (rsi < 25) {
                putScore -= 12;
            }
        }

        // -----------------------------
        // MACD
        // -----------------------------

        if (
            macd.histogram !== null &&
            macd.histogram > 0
        ) {
            callScore += 12;
            reasons.push("MACD positive");
        }

        if (
            macd.histogram !== null &&
            macd.histogram < 0
        ) {
            putScore += 12;
            reasons.push("MACD negative");
        }

        // -----------------------------
        // CANDLE MOMENTUM
        // -----------------------------

        if (
            candle.bullish &&
            candle.bodyRatio >= 0.55
        ) {
            callScore += 10;
            reasons.push("bullish momentum candle");
        }

        if (
            candle.bearish &&
            candle.bodyRatio >= 0.55
        ) {
            putScore += 10;
            reasons.push("bearish momentum candle");
        }

        // -----------------------------
        // WICK REJECTION
        // -----------------------------

        if (
            candle.lowerWick > candle.body * 1.5 &&
            candle.bullish
        ) {
            callScore += 10;
            reasons.push("lower-wick rejection");
        }

        if (
            candle.upperWick > candle.body * 1.5 &&
            candle.bearish
        ) {
            putScore += 10;
            reasons.push("upper-wick rejection");
        }

        // -----------------------------
        // SUPPORT / RESISTANCE
        // -----------------------------

        const range =
            levels.resistance -
            levels.support;

        const supportDistance =
            Math.abs(
                current - levels.support
            );

        const resistanceDistance =
            Math.abs(
                current - levels.resistance
            );

        if (
            range > 0 &&
            supportDistance / range < 0.15
        ) {
            callScore += 12;
            reasons.push("near support");
        }

        if (
            range > 0 &&
            resistanceDistance / range < 0.15
        ) {
            putScore += 12;
            reasons.push("near resistance");
        }

        // -----------------------------
        // RECENT MOMENTUM
        // -----------------------------

        if (
            previous.close > previous2.close &&
            current > previous.close
        ) {
            callScore += 8;
        }

        if (
            previous.close < previous2.close &&
            current < previous.close
        ) {
            putScore += 8;
        }

        // -----------------------------
        // FINAL TECHNICAL SCORE
        // -----------------------------

        callScore = clamp(callScore, 0, 100);
        putScore = clamp(putScore, 0, 100);

        const difference =
            Math.abs(callScore - putScore);

        let technicalDir = "WAIT";
        let technicalScore =
            Math.max(callScore, putScore);

        // Require meaningful separation
        if (
            callScore >= 62 &&
            callScore - putScore >= 15
        ) {
            technicalDir = "CALL";
        } else if (
            putScore >= 62 &&
            putScore - callScore >= 15
        ) {
            technicalDir = "PUT";
        } else {
            technicalDir = "WAIT";
        }

        // Very low volatility / tiny ATR = avoid
        if (
            atr !== null &&
            atr <= 0
        ) {
            technicalDir = "WAIT";
        }

        return {
            price: current,

            rsi:
                rsi === null
                    ? null
                    : round(rsi, 2),

            atr:
                atr === null
                    ? null
                    : round(atr, 6),

            macd: {
                value:
                    macd.macd === null
                        ? null
                        : round(macd.macd, 8),

                signal:
                    macd.signal === null
                        ? null
                        : round(macd.signal, 8),

                histogram:
                    macd.histogram === null
                        ? null
                        : round(macd.histogram, 8)
            },

            ema: {
                ema9:
                    structure.ema9 === null
                        ? null
                        : round(structure.ema9, 6),

                ema21:
                    structure.ema21 === null
                        ? null
                        : round(structure.ema21, 6),

                ema50:
                    structure.ema50 === null
                        ? null
                        : round(structure.ema50, 6)
            },

            trend: structure.trend,
            emaSlope: structure.emaSlope,

            support: round(levels.support, 6),
            resistance: round(levels.resistance, 6),

            candle: {
                bullish: candle.bullish,
                bearish: candle.bearish,
                bodyRatio: round(
                    candle.bodyRatio,
                    3
                ),
                upperWick: round(
                    candle.upperWick,
                    6
                ),
                lowerWick: round(
                    candle.lowerWick,
                    6
                )
            },

            callScore,
            putScore,
            difference,

            technicalDir,
            technicalScore,

            reasons: reasons.slice(-8)
        };
    }

    // =========================================================
    // AI CONFIRMATION
    // =========================================================

    async function askGemini(pair, tf, analysis) {
        if (!GEMINI_KEY) {
            return {
                dir: "WAIT",
                confidence: 0,
                reason: "GEMINI_API_KEY missing"
            };
        }

        const prompt = `
You are the confirmation layer of a professional quantitative
price-action trading system.

IMPORTANT:
You do NOT invent missing market data.
You do NOT force a trade.
If evidence conflicts or is weak, return WAIT.

Market:
Pair: ${pair}
Timeframe: ${tf}

Technical engine:
${JSON.stringify(analysis, null, 2)}

Rules:

1. CALL means bullish continuation/reversal has strong confirmation.
2. PUT means bearish continuation/reversal has strong confirmation.
3. WAIT if:
   - trend and momentum conflict
   - price is in the middle of a range
   - support/resistance confirmation is weak
   - RSI is extreme without reversal confirmation
   - technical score is weak
   - evidence is insufficient
4. Never manufacture confidence.
5. Confidence is NOT guaranteed win probability.
6. Prefer WAIT over a low-quality trade.
7. Do not use martingale logic.
8. Do not recommend increasing stake after losses.

Return JSON only.
`;

        const schema = {
            type: "object",
            properties: {
                dir: {
                    type: "string",
                    enum: ["CALL", "PUT", "WAIT"]
                },
                confidence: {
                    type: "integer",
                    minimum: 0,
                    maximum: 100
                },
                reason: {
                    type: "string"
                }
            },
            required: [
                "dir",
                "confidence",
                "reason"
            ]
        };

        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_KEY)}`,
            {
                method: "POST",

                headers: {
                    "Content-Type": "application/json"
                },

                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                {
                                    text: prompt
                                }
                            ]
                        }
                    ],

                    generationConfig: {
                        temperature: 0.1,
                        responseMimeType:
                            "application/json",
                        responseSchema: schema
                    }
                })
            }
        );

        if (!response.ok) {
            const errorText =
                await response.text();

            throw new Error(
                `Gemini HTTP ${response.status}: ${errorText}`
            );
        }

        const data =
            await response.json();

        const text =
            data?.candidates?.[0]
                ?.content?.parts?.[0]
                ?.text;

        if (!text) {
            throw new Error(
                "Gemini returned empty response"
            );
        }

        return JSON.parse(text);
    }

    // =========================================================
    // MAIN
    // =========================================================

    try {
        const body = req.body || {};

        const pair =
            normalizePair(
                body.pair ||
                body.ticker ||
                "EURUSD"
            );

        const timeframe =
            normalizeTimeframe(
                body.timeframe ||
                "1m"
            );

        // -----------------------------------------------------
        // Fetch candles
        // -----------------------------------------------------

        let candles;

        if (isCrypto(pair)) {
            candles =
                await fetchBinanceCandles(
                    pair,
                    timeframe
                );
        } else {
            candles =
                await fetchYahooCandles(
                    pair,
                    timeframe
                );
        }

        if (!candles || candles.length < 80) {
            throw new Error(
                "Not enough market candles"
            );
        }

        // -----------------------------------------------------
        // Technical analysis
        // -----------------------------------------------------

        const analysis =
            analyzeMarket(candles);

        // -----------------------------------------------------
        // Don't trade during weak structure
        // -----------------------------------------------------

        if (
            analysis.technicalDir === "WAIT"
        ) {
            return res.status(200).json({
                dir: "WAIT",

                score:
                    analysis.technicalScore,

                ema:
                    analysis.trend,

                rsi:
                    analysis.rsi === null
                        ? "N/A"
                        : analysis.rsi,

                vol:
                    analysis.atr === null
                        ? "N/A"
                        : analysis.atr,

                trend:
                    analysis.trend,

                support:
                    analysis.support,

                resistance:
                    analysis.resistance,

                technicalScore:
                    analysis.technicalScore,

                aiScore: 0,

                status:
                    "WAIT: No sufficiently confirmed setup.",

                reason:
                    analysis.reasons.join(
                        " | "
                    ),

                pair,
                timeframe,

                price:
                    analysis.price,

                timestamp:
                    new Date().toISOString()
            });
        }

        // -----------------------------------------------------
        // Gemini confirmation
        // -----------------------------------------------------

        let ai;

        try {
            ai =
                await askGemini(
                    pair,
                    timeframe,
                    analysis
                );
        } catch (aiError) {
            console.error(
                "Gemini confirmation failed:",
                aiError
            );

            // NEVER create fake CALL/PUT
            return res.status(200).json({
                dir: "WAIT",

                score:
                    analysis.technicalScore,

                ema:
                    analysis.trend,

                rsi:
                    analysis.rsi,

                vol:
                    analysis.atr,

                trend:
                    analysis.trend,

                support:
                    analysis.support,

                resistance:
                    analysis.resistance,

                technicalScore:
                    analysis.technicalScore,

                aiScore: 0,

                status:
                    "WAIT: AI confirmation unavailable.",

                reason:
                    "Technical setup exists, but confirmation failed.",

                pair,
                timeframe,

                price:
                    analysis.price,

                timestamp:
                    new Date().toISOString()
            });
        }

        // -----------------------------------------------------
        // FINAL CONFIRMATION
        // -----------------------------------------------------

        let finalDir = "WAIT";

        /*
         * AI MUST AGREE WITH THE TECHNICAL ENGINE.
         * No agreement = WAIT.
         */

        if (
            ai.dir === analysis.technicalDir &&
            ai.confidence >= 70 &&
            analysis.technicalScore >= 62
        ) {
            finalDir = ai.dir;
        }

        // -----------------------------------------------------
        // Final confidence
        // -----------------------------------------------------

        let finalScore =
            Math.round(
                analysis.technicalScore * 0.65 +
                ai.confidence * 0.35
            );

        finalScore =
            clamp(
                finalScore,
                0,
                100
            );

        // If no final trade, score shouldn't pretend it's strong.
        if (finalDir === "WAIT") {
            finalScore =
                Math.min(
                    finalScore,
                    69
                );
        }

        let status;

        if (finalDir === "CALL") {
            status =
                `CALL: Multi-confirmation bullish setup. ${ai.reason}`;
        } else if (finalDir === "PUT") {
            status =
                `PUT: Multi-confirmation bearish setup. ${ai.reason}`;
        } else {
            status =
                `WAIT: Confirmation conflict or insufficient strength. ${ai.reason}`;
        }

        return res.status(200).json({
            dir: finalDir,

            score: finalScore,

            ema:
                analysis.trend,

            rsi:
                analysis.rsi === null
                    ? "N/A"
                    : analysis.rsi,

            vol:
                analysis.atr === null
                    ? "N/A"
                    : analysis.atr,

            trend:
                analysis.trend,

            emaSlope:
                analysis.emaSlope,

            support:
                analysis.support,

            resistance:
                analysis.resistance,

            technicalScore:
                analysis.technicalScore,

            callScore:
                analysis.callScore,

            putScore:
                analysis.putScore,

            aiScore:
                ai.confidence,

            status,

            reason:
                analysis.reasons.join(
                    " | "
                ),

            aiReason:
                ai.reason,

            pair,

            timeframe,

            price:
                analysis.price,

            timestamp:
                new Date().toISOString()
        });

    } catch (error) {
        console.error(
            "AK Trader scan error:",
            error
        );

        /*
         * CRITICAL:
         * If market data/API fails, DO NOT fake a signal.
         */
        return res.status(200).json({
            dir: "WAIT",
            score: 0,
            ema: "UNAVAILABLE",
            rsi: "N/A",
            vol: "N/A",
            status:
                "WAIT: Market data unavailable.",
            reason:
                error?.message ||
                "Unknown scanning error",
            timestamp:
                new Date().toISOString()
        });
    }
}
