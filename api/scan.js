export default async function handler(req, res) {
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

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GEMINI_MODEL =
    process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  const rawPair =
    req.query?.pair ||
    req.body?.pair ||
    "EURUSD";

  const timeframe =
    req.query?.timeframe ||
    req.body?.timeframe ||
    "1m";

  function normalizePair(value) {
    let p = String(value)
      .toUpperCase()
      .replace(/\s+/g, "")
      .replace("/", "")
      .replace("-", "")
      .replace("_", "");

    p = p.replace("(QUOTEX)", "");
    p = p.replace("QUOTEX", "");
    p = p.replace("OTC", "");

    return p;
  }

  const pair = normalizePair(rawPair);

  const FOREX_PAIRS = [
    "EURUSD",
    "GBPUSD",
    "USDJPY",
    "USDCHF",
    "AUDUSD",
    "USDCAD",
    "NZDUSD",

    "EURGBP",
    "EURJPY",
    "EURCHF",
    "EURAUD",
    "EURCAD",
    "EURNZD",

    "GBPJPY",
    "GBPCHF",
    "GBPAUD",
    "GBPCAD",
    "GBPNZD",

    "AUDJPY",
    "AUDCHF",
    "AUDCAD",
    "AUDNZD",

    "CADJPY",
    "CADCHF",

    "CHFJPY",

    "NZDJPY",
    "NZDCHF",
    "NZDCAD"
  ];

  const isCrypto =
    pair.endsWith("USDT") ||
    pair.endsWith("BUSD");

  if (!FOREX_PAIRS.includes(pair) && !isCrypto) {
    return res.status(400).json({
      ok: false,
      signal: "WAIT",
      error: "Unsupported pair",
      pair
    });
  }

  const TF_MAP = {
    "1m": {
      yahoo: "1m",
      interval: 60,
      staleLimit: 180
    },
    "5m": {
      yahoo: "5m",
      interval: 300,
      staleLimit: 600
    },
    "15m": {
      yahoo: "15m",
      interval: 900,
      staleLimit: 1200
    },
    "30m": {
      yahoo: "30m",
      interval: 1800,
      staleLimit: 1800
    },
    "1h": {
      yahoo: "60m",
      interval: 3600,
      staleLimit: 3600
    }
  };

  const tf = TF_MAP[timeframe] || TF_MAP["1m"];

  function yahooSymbol(p) {
    return `${p.slice(0, 3)}${p.slice(3, 6)}=X`;
  }

  function binanceSymbol(p) {
    return p.toUpperCase();
  }

  async function fetchYahoo(p, interval) {
    const symbol = yahooSymbol(p);

    const range =
      interval === "1m"
        ? "1d"
        : interval === "5m"
        ? "5d"
        : interval === "15m"
        ? "10d"
        : interval === "30m"
        ? "30d"
        : "60d";

    const url =
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
      `?range=${range}&interval=${interval}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Yahoo HTTP ${response.status}`);
    }

    const json = await response.json();

    const result = json?.chart?.result?.[0];

    if (!result) {
      throw new Error("No Yahoo market data");
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    const candles = [];

    for (let i = 0; i < timestamps.length; i++) {
      const open = quote.open?.[i];
      const high = quote.high?.[i];
      const low = quote.low?.[i];
      const close = quote.close?.[i];

      if (
        Number.isFinite(open) &&
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close)
      ) {
        candles.push({
          time: timestamps[i] * 1000,
          open,
          high,
          low,
          close,
          volume: Number(quote.volume?.[i] || 0)
        });
      }
    }

    return candles;
  }

  async function fetchBinance(p, interval) {
    const symbol = binanceSymbol(p);

    const url =
      `https://api.binance.com/api/v3/klines` +
      `?symbol=${symbol}&interval=${interval}&limit=500`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Binance HTTP ${response.status}`);
    }

    const data = await response.json();

    return data.map((x) => ({
      time: Number(x[0]),
      open: Number(x[1]),
      high: Number(x[2]),
      low: Number(x[3]),
      close: Number(x[4]),
      volume: Number(x[5])
    }));
  }

  async function getCandles(p, tfKey) {
    const settings = TF_MAP[tfKey];

    if (!settings) {
      throw new Error("Invalid timeframe");
    }

    if (isCrypto) {
      return fetchBinance(p, tfKey);
    }

    return fetchYahoo(p, settings.yahoo);
  }

  function closedCandles(candles, intervalSeconds) {
    if (!candles || candles.length < 10) {
      return [];
    }

    const now = Date.now();

    return candles.filter((c) => {
      return (
        Number.isFinite(c.time) &&
        now - c.time >= intervalSeconds * 1000
      );
    });
  }

  function emaSeries(values, period) {
    if (!values || values.length < period) {
      return [];
    }

    const result = new Array(values.length).fill(null);

    let sum = 0;

    for (let i = 0; i < period; i++) {
      sum += values[i];
    }

    let ema = sum / period;
    result[period - 1] = ema;

    const multiplier = 2 / (period + 1);

    for (let i = period; i < values.length; i++) {
      ema =
        (values[i] - ema) * multiplier +
        ema;

      result[i] = ema;
    }

    return result;
  }

  function ema(values, period) {
    const series = emaSeries(values, period);
    return series[series.length - 1];
  }

  function calculateRSI(closes, period = 14) {
    if (closes.length <= period) {
      return null;
    }

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = closes[i] - closes[i - 1];

      if (diff >= 0) {
        gains += diff;
      } else {
        losses += Math.abs(diff);
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];

      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;

      avgGain =
        (avgGain * (period - 1) + gain) /
        period;

      avgLoss =
        (avgLoss * (period - 1) + loss) /
        period;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);
  }

  function calculateATR(candles, period = 14) {
    if (candles.length <= period) {
      return null;
    }

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

    if (trs.length < period) {
      return null;
    }

    let atr = 0;

    for (let i = 0; i < period; i++) {
      atr += trs[i];
    }

    atr /= period;

    for (let i = period; i < trs.length; i++) {
      atr =
        (atr * (period - 1) + trs[i]) /
        period;
    }

    return atr;
  }

  function calculateMACD(closes) {
    const ema12 = emaSeries(closes, 12);
    const ema26 = emaSeries(closes, 26);

    const macdLine = [];

    for (let i = 0; i < closes.length; i++) {
      if (
        ema12[i] !== null &&
        ema26[i] !== null
      ) {
        macdLine.push(ema12[i] - ema26[i]);
      }
    }

    if (macdLine.length < 9) {
      return {
        macd: null,
        signal: null,
        histogram: null
      };
    }

    const signalSeries = emaSeries(
      macdLine,
      9
    );

    const macd = macdLine[macdLine.length - 1];
    const signal =
      signalSeries[signalSeries.length - 1];

    return {
      macd,
      signal,
      histogram:
        macd !== null && signal !== null
          ? macd - signal
          : null
    };
  }

  function candleAnalysis(candles) {
    const c = candles[candles.length - 1];

    const range = c.high - c.low;

    if (range <= 0) {
      return {
        direction: "NEUTRAL",
        strength: 0,
        bullish: false,
        bearish: false
      };
    }

    const body = Math.abs(c.close - c.open);

    const upperWick =
      c.high - Math.max(c.open, c.close);

    const lowerWick =
      Math.min(c.open, c.close) - c.low;

    const bodyRatio = body / range;

    const bullish =
      c.close > c.open;

    const bearish =
      c.close < c.open;

    let strength = Math.round(
      bodyRatio * 100
    );

    if (strength > 100) {
      strength = 100;
    }

    return {
      direction: bullish
        ? "BULLISH"
        : bearish
        ? "BEARISH"
        : "NEUTRAL",

      strength,

      bullish,
      bearish,

      body,
      range,
      upperWick,
      lowerWick,
      bodyRatio
    };
  }

  function supportResistance(candles, lookback = 50) {
    const recent =
      candles.slice(-lookback);

    const highs = recent.map((c) => c.high);
    const lows = recent.map((c) => c.low);

    return {
      resistance: Math.max(...highs),
      support: Math.min(...lows)
    };
  }

  function analyze(candles) {
    if (candles.length < 80) {
      return {
        signal: "WAIT",
        score: 0,
        callScore: 0,
        putScore: 0
      };
    }

    const closes =
      candles.map((c) => c.close);

    const current =
      candles[candles.length - 1];

    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const ema50 = ema(closes, 50);

    const rsi =
      calculateRSI(closes, 14);

    const atr =
      calculateATR(candles, 14);

    const macd =
      calculateMACD(closes);

    const candle =
      candleAnalysis(candles);

    const levels =
      supportResistance(candles, 50);

    let callScore = 0;
    let putScore = 0;

    // EMA trend
    if (
      ema9 > ema21 &&
      ema21 > ema50
    ) {
      callScore += 25;
    }

    if (
      ema9 < ema21 &&
      ema21 < ema50
    ) {
      putScore += 25;
    }

    // RSI
    if (rsi !== null) {
      if (rsi >= 52 && rsi <= 68) {
        callScore += 15;
      }

      if (rsi <= 48 && rsi >= 32) {
        putScore += 15;
      }

      // Avoid extreme overbought/oversold
      if (rsi > 75) {
        callScore -= 10;
      }

      if (rsi < 25) {
        putScore -= 10;
      }
    }

    // MACD
    if (
      macd.macd !== null &&
      macd.signal !== null
    ) {
      if (
        macd.macd > macd.signal &&
        macd.histogram > 0
      ) {
        callScore += 15;
      }

      if (
        macd.macd < macd.signal &&
        macd.histogram < 0
      ) {
        putScore += 15;
      }
    }

    // Candle
    if (
      candle.bullish &&
      candle.bodyRatio >= 0.55
    ) {
      callScore += 15;
    }

    if (
      candle.bearish &&
      candle.bodyRatio >= 0.55
    ) {
      putScore += 15;
    }

    // Support / resistance
    const distanceToResistance =
      Math.abs(
        levels.resistance -
          current.close
      );

    const distanceToSupport =
      Math.abs(
        current.close -
          levels.support
      );

    if (
      distanceToResistance >
      (atr || 0) * 0.5
    ) {
      if (ema9 > ema21) {
        callScore += 5;
      }
    }

    if (
      distanceToSupport >
      (atr || 0) * 0.5
    ) {
      if (ema9 < ema21) {
        putScore += 5;
      }
    }

    // Trend consistency
    if (
      current.close > ema50 &&
      ema21 > ema50
    ) {
      callScore += 10;
    }

    if (
      current.close < ema50 &&
      ema21 < ema50
    ) {
      putScore += 10;
    }

    callScore = Math.max(
      0,
      Math.min(100, callScore)
    );

    putScore = Math.max(
      0,
      Math.min(100, putScore)
    );

    let signal = "WAIT";
    let score = Math.max(
      callScore,
      putScore
    );

    if (
      callScore >= 64 &&
      callScore - putScore >= 18
    ) {
      signal = "CALL";
    } else if (
      putScore >= 64 &&
      putScore - callScore >= 18
    ) {
      signal = "PUT";
    } else {
      signal = "WAIT";
      score = Math.min(score, 69);
    }

    return {
      signal,
      score,

      callScore,
      putScore,

      ema9,
      ema21,
      ema50,

      rsi,
      atr,

      macd,

      candle,

      support:
        levels.support,

      resistance:
        levels.resistance,

      price:
        current.close,

      lastCandleTime:
        current.time
    };
  }

  function higherTimeframeBias(
    analysis5,
    analysis15
  ) {
    let call = 0;
    let put = 0;

    if (
      analysis5.signal === "CALL"
    ) {
      call += 2;
    }

    if (
      analysis15.signal === "CALL"
    ) {
      call += 2;
    }

    if (
      analysis5.signal === "PUT"
    ) {
      put += 2;
    }

    if (
      analysis15.signal === "PUT"
    ) {
      put += 2;
    }

    if (call >= 3 && call > put) {
      return "CALL";
    }

    if (put >= 3 && put > call) {
      return "PUT";
    }

    return "NEUTRAL";
  }

  async function askGemini(data) {
    if (!GEMINI_API_KEY) {
      return {
        signal: "WAIT",
        score: 0,
        reason:
          "Gemini API key not configured"
      };
    }

    const prompt = `
You are a strict market-analysis confirmation engine.

DO NOT invent market data.
DO NOT force a trade.
If conditions are unclear, return WAIT.

Analyze the supplied technical data only.

PAIR:
${pair}

ENTRY TIMEFRAME:
${timeframe}

ENTRY ANALYSIS:
${JSON.stringify(data.entry)}

5 MINUTE ANALYSIS:
${JSON.stringify(data.five)}

15 MINUTE ANALYSIS:
${JSON.stringify(data.fifteen)}

HIGHER TIMEFRAME BIAS:
${data.bias}

Rules:

1. CALL only when the entry trend is bullish.
2. PUT only when the entry trend is bearish.
3. Higher timeframes should support the direction.
4. Avoid weak/choppy conditions.
5. Avoid extreme RSI conditions.
6. Do not manufacture confidence.
7. If technical analysis conflicts, return WAIT.
8. Score must represent analysis confidence, NOT guaranteed win probability.
9. Prefer WAIT over a weak signal.

Return ONLY valid JSON:

{
  "signal": "CALL" | "PUT" | "WAIT",
  "score": number,
  "reason": "short explanation"
}
`;

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            "x-goog-api-key": GEMINI_API_KEY
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
                "application/json"
            }
          })
        }
      );

      if (!response.ok) {
        throw new Error(
          `Gemini HTTP ${response.status}`
        );
      }

      const json =
        await response.json();

      const text =
        json?.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!text) {
        throw new Error(
          "Empty Gemini response"
        );
      }

      const cleaned =
        text
          .replace(/```json/g, "")
          .replace(/```/g, "")
          .trim();

      const result =
        JSON.parse(cleaned);

      if (
        !["CALL", "PUT", "WAIT"].includes(
          result.signal
        )
      ) {
        return {
          signal: "WAIT",
          score: 0,
          reason:
            "Invalid AI signal"
        };
      }

      return {
        signal: result.signal,
        score: Number(result.score) || 0,
        reason:
          String(result.reason || "")
      };
    } catch (error) {
      return {
        signal: "WAIT",
        score: 0,
        reason:
          "AI confirmation unavailable"
      };
    }
  }

  try {
    const [
      entryRaw,
      fiveRaw,
      fifteenRaw
    ] = await Promise.all([
      getCandles(pair, timeframe),
      getCandles(pair, "5m"),
      getCandles(pair, "15m")
    ]);

    const entry =
      closedCandles(
        entryRaw,
        tf.interval
      );

    const five =
      closedCandles(
        fiveRaw,
        300
      );

    const fifteen =
      closedCandles(
        fifteenRaw,
        900
      );

    if (
      entry.length < 80 ||
      five.length < 80 ||
      fifteen.length < 80
    ) {
      return res.status(200).json({
        ok: true,
        signal: "WAIT",
        score: 0,
        reason:
          "Not enough closed candles",
        pair,
        timeframe
      });
    }

    const entryAnalysis =
      analyze(entry);

    const fiveAnalysis =
      analyze(five);

    const fifteenAnalysis =
      analyze(fifteen);

    const bias =
      higherTimeframeBias(
        fiveAnalysis,
        fifteenAnalysis
      );

    const latestEntry =
      entry[entry.length - 1];

    const feedAgeSeconds =
      Math.round(
        (Date.now() -
          latestEntry.time) /
          1000
      );

    if (
      feedAgeSeconds >
      tf.staleLimit
    ) {
      return res.status(200).json({
        ok: true,
        signal: "WAIT",
        score: 0,
        reason:
          "Market data is stale",
        pair,
        timeframe,
        feedAgeSeconds
      });
    }

    const ai =
      await askGemini({
        entry: entryAnalysis,
        five: fiveAnalysis,
        fifteen: fifteenAnalysis,
        bias
      });

    let finalSignal = "WAIT";
    let finalScore = 0;

    const technicalSignal =
      entryAnalysis.signal;

    const technicalScore =
      entryAnalysis.score;

    // Strict confirmation
    if (
      technicalSignal === "CALL" &&
      bias === "CALL" &&
      ai.signal === "CALL" &&
      ai.score >= 72
    ) {
      finalSignal = "CALL";

      finalScore =
        Math.min(
          98,
          Math.round(
            technicalScore * 0.55 +
            ai.score * 0.45
          )
        );
    }

    if (
      technicalSignal === "PUT" &&
      bias === "PUT" &&
      ai.signal === "PUT" &&
      ai.score >= 72
    ) {
      finalSignal = "PUT";

      finalScore =
        Math.min(
          98,
          Math.round(
            technicalScore * 0.55 +
            ai.score * 0.45
          )
        );
    }

    if (
      finalSignal === "WAIT"
    ) {
      finalScore = Math.min(
        69,
        Math.round(
          Math.max(
            technicalScore,
            ai.score
          )
        )
      );
    }

    return res.status(200).json({
      ok: true,

      pair,
      timeframe,

      signal: finalSignal,
      score: finalScore,

      technicalSignal,
      technicalScore,

      callScore:
        entryAnalysis.callScore,

      putScore:
        entryAnalysis.putScore,

      aiSignal:
        ai.signal,

      aiScore:
        ai.score,

      aiReason:
        ai.reason,

      higherTimeframeBias:
        bias,

      ema9:
        entryAnalysis.ema9,

      ema21:
        entryAnalysis.ema21,

      ema50:
        entryAnalysis.ema50,

      rsi:
        entryAnalysis.rsi,

      atr:
        entryAnalysis.atr,

      macd:
        entryAnalysis.macd,

      support:
        entryAnalysis.support,

      resistance:
        entryAnalysis.resistance,

      price:
        entryAnalysis.price,

      feedAgeSeconds,

      candlesUsed:
        entry.length,

      dataSource:
        isCrypto
          ? "Binance"
          : "Yahoo Finance FX",

      warning:
        !isCrypto
          ? "Forex feed is not guaranteed to match Quotex execution feed."
          : null
    });
  } catch (error) {
    return res.status(200).json({
      ok: false,
      signal: "WAIT",
      score: 0,
      pair,
      timeframe,
      error:
        error?.message ||
        "Market data error"
    });
  }
}
