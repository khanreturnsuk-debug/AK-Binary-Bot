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

  // =========================================================
  // NORMALIZE PAIR
  // =========================================================

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

  // =========================================================
  // TIMEFRAME
  // =========================================================

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

  const tf =
    TF_MAP[timeframe] ||
    TF_MAP["1m"];

  // =========================================================
  // SYMBOLS
  // =========================================================

  function yahooSymbol(p) {
    return `${p.slice(0, 3)}${p.slice(3, 6)}=X`;
  }

  function binanceSymbol(p) {
    return p.toUpperCase();
  }

  // =========================================================
  // YAHOO DATA
  // =========================================================

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
      throw new Error(
        `Yahoo HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    const result =
      json?.chart?.result?.[0];

    if (!result) {
      throw new Error(
        "No Yahoo market data"
      );
    }

    const timestamps =
      result.timestamp || [];

    const quote =
      result.indicators?.quote?.[0] || {};

    const candles = [];

    for (
      let i = 0;
      i < timestamps.length;
      i++
    ) {
      const open =
        quote.open?.[i];

      const high =
        quote.high?.[i];

      const low =
        quote.low?.[i];

      const close =
        quote.close?.[i];

      if (
        Number.isFinite(open) &&
        Number.isFinite(high) &&
        Number.isFinite(low) &&
        Number.isFinite(close)
      ) {
        candles.push({
          time:
            timestamps[i] * 1000,
          open,
          high,
          low,
          close,
          volume:
            Number(
              quote.volume?.[i] || 0
            )
        });
      }
    }

    return candles;
  }

  // =========================================================
  // BINANCE DATA
  // =========================================================

  async function fetchBinance(
    p,
    interval
  ) {
    const symbol =
      binanceSymbol(p);

    const url =
      `https://api.binance.com/api/v3/klines` +
      `?symbol=${symbol}` +
      `&interval=${interval}` +
      `&limit=500`;

    const response =
      await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Binance HTTP ${response.status}`
      );
    }

    const data =
      await response.json();

    return data.map((x) => ({
      time: Number(x[0]),
      open: Number(x[1]),
      high: Number(x[2]),
      low: Number(x[3]),
      close: Number(x[4]),
      volume: Number(x[5])
    }));
  }

  // =========================================================
  // GET CANDLES
  // =========================================================

  async function getCandles(
    p,
    tfKey
  ) {
    const settings =
      TF_MAP[tfKey];

    if (!settings) {
      throw new Error(
        "Invalid timeframe"
      );
    }

    if (isCrypto) {
      return fetchBinance(
        p,
        tfKey
      );
    }

    return fetchYahoo(
      p,
      settings.yahoo
    );
  }

  // =========================================================
  // CLOSED CANDLES
  // =========================================================

  function closedCandles(
    candles,
    intervalSeconds
  ) {
    if (
      !candles ||
      candles.length < 10
    ) {
      return [];
    }

    const now =
      Date.now();

    return candles.filter(
      (c) => {
        return (
          Number.isFinite(c.time) &&
          now - c.time >=
            intervalSeconds * 1000
        );
      }
    );
  }

  // =========================================================
  // EMA
  // =========================================================

  function emaSeries(
    values,
    period
  ) {
    if (
      !values ||
      values.length < period
    ) {
      return [];
    }

    const result =
      new Array(values.length)
        .fill(null);

    let sum = 0;

    for (
      let i = 0;
      i < period;
      i++
    ) {
      sum += values[i];
    }

    let currentEMA =
      sum / period;

    result[period - 1] =
      currentEMA;

    const multiplier =
      2 / (period + 1);

    for (
      let i = period;
      i < values.length;
      i++
    ) {
      currentEMA =
        (values[i] -
          currentEMA) *
          multiplier +
        currentEMA;

      result[i] =
        currentEMA;
    }

    return result;
  }

  function ema(
    values,
    period
  ) {
    const series =
      emaSeries(
        values,
        period
      );

    return series[
      series.length - 1
    ];
  }

  // =========================================================
  // RSI
  // =========================================================

  function calculateRSI(
    closes,
    period = 14
  ) {
    if (
      closes.length <= period
    ) {
      return null;
    }

    let gains = 0;
    let losses = 0;

    for (
      let i = 1;
      i <= period;
      i++
    ) {
      const diff =
        closes[i] -
        closes[i - 1];

      if (diff >= 0) {
        gains += diff;
      } else {
        losses +=
          Math.abs(diff);
      }
    }

    let avgGain =
      gains / period;

    let avgLoss =
      losses / period;

    for (
      let i = period + 1;
      i < closes.length;
      i++
    ) {
      const diff =
        closes[i] -
        closes[i - 1];

      const gain =
        diff > 0
          ? diff
          : 0;

      const loss =
        diff < 0
          ? Math.abs(diff)
          : 0;

      avgGain =
        (avgGain *
          (period - 1) +
          gain) /
        period;

      avgLoss =
        (avgLoss *
          (period - 1) +
          loss) /
        period;
    }

    if (avgLoss === 0) {
      return 100;
    }

    const rs =
      avgGain / avgLoss;

    return (
      100 -
      100 / (1 + rs)
    );
  }

  // =========================================================
  // ATR
  // =========================================================

  function calculateATR(
    candles,
    period = 14
  ) {
    if (
      candles.length <= period
    ) {
      return null;
    }

    const trs = [];

    for (
      let i = 1;
      i < candles.length;
      i++
    ) {
      const current =
        candles[i];

      const previous =
        candles[i - 1];

      const tr =
        Math.max(
          current.high -
            current.low,

          Math.abs(
            current.high -
              previous.close
          ),

          Math.abs(
            current.low -
              previous.close
          )
        );

      trs.push(tr);
    }

    if (
      trs.length < period
    ) {
      return null;
    }

    let atr = 0;

    for (
      let i = 0;
      i < period;
      i++
    ) {
      atr += trs[i];
    }

    atr /= period;

    for (
      let i = period;
      i < trs.length;
      i++
    ) {
      atr =
        (atr *
          (period - 1) +
          trs[i]) /
        period;
    }

    return atr;
  }

  // =========================================================
  // MACD
  // =========================================================

  function calculateMACD(
    closes
  ) {
    const ema12 =
      emaSeries(
        closes,
        12
      );

    const ema26 =
      emaSeries(
        closes,
        26
      );

    const macdLine = [];

    for (
      let i = 0;
      i < closes.length;
      i++
    ) {
      if (
        ema12[i] !== null &&
        ema26[i] !== null
      ) {
        macdLine.push(
          ema12[i] -
            ema26[i]
        );
      }
    }

    if (
      macdLine.length < 9
    ) {
      return {
        macd: null,
        signal: null,
        histogram: null
      };
    }

    const signalSeries =
      emaSeries(
        macdLine,
        9
      );

    const macd =
      macdLine[
        macdLine.length - 1
      ];

    const signal =
      signalSeries[
        signalSeries.length - 1
      ];

    return {
      macd,
      signal,
      histogram:
        macd !== null &&
        signal !== null
          ? macd - signal
          : null
    };
  }

  // =========================================================
  // CANDLE ANALYSIS
  // =========================================================

  function candleAnalysis(
    candles
  ) {
    const c =
      candles[
        candles.length - 1
      ];

    const previous =
      candles[
        candles.length - 2
      ];

    const range =
      c.high - c.low;

    if (range <= 0) {
      return {
        direction: "NEUTRAL",
        strength: 0,
        bullish: false,
        bearish: false
      };
    }

    const body =
      Math.abs(
        c.close - c.open
      );

    const upperWick =
      c.high -
      Math.max(
        c.open,
        c.close
      );

    const lowerWick =
      Math.min(
        c.open,
        c.close
      ) - c.low;

    const bodyRatio =
      body / range;

    const bullish =
      c.close > c.open;

    const bearish =
      c.close < c.open;

    const previousBullish =
      previous &&
      previous.close >
        previous.open;

    const previousBearish =
      previous &&
      previous.close <
        previous.open;

    // Momentum
    const momentum =
      previous
        ? c.close -
          previous.close
        : 0;

    return {
      direction: bullish
        ? "BULLISH"
        : bearish
        ? "BEARISH"
        : "NEUTRAL",

      strength: Math.min(
        100,
        Math.round(
          bodyRatio * 100
        )
      ),

      bullish,
      bearish,

      previousBullish,
      previousBearish,

      momentum,

      body,
      range,
      upperWick,
      lowerWick,
      bodyRatio
    };
  }

  // =========================================================
  // SUPPORT / RESISTANCE
  // =========================================================

  function supportResistance(
    candles,
    lookback = 60
  ) {
    const recent =
      candles.slice(
        -lookback
      );

    const highs =
      recent.map(
        (c) => c.high
      );

    const lows =
      recent.map(
        (c) => c.low
      );

    return {
      resistance:
        Math.max(...highs),

      support:
        Math.min(...lows)
    };
  }

  // =========================================================
  // TREND STRENGTH
  // =========================================================

  function trendStrength(
    ema9,
    ema21,
    ema50,
    price
  ) {
    let bullish = 0;
    let bearish = 0;

    if (ema9 > ema21) {
      bullish += 1;
    } else {
      bearish += 1;
    }

    if (ema21 > ema50) {
      bullish += 1;
    } else {
      bearish += 1;
    }

    if (price > ema50) {
      bullish += 1;
    } else {
      bearish += 1;
    }

    return {
      bullish,
      bearish
    };
  }

  // =========================================================
  // MAIN TECHNICAL ANALYSIS
  // =========================================================

  function analyze(candles) {
    if (
      candles.length < 80
    ) {
      return {
        signal: "WAIT",
        score: 0,
        callScore: 0,
        putScore: 0
      };
    }

    const closes =
      candles.map(
        (c) => c.close
      );

    const current =
      candles[
        candles.length - 1
      ];

    const ema9 =
      ema(closes, 9);

    const ema21 =
      ema(closes, 21);

    const ema50 =
      ema(closes, 50);

    const rsi =
      calculateRSI(
        closes,
        14
      );

    const atr =
      calculateATR(
        candles,
        14
      );

    const macd =
      calculateMACD(
        closes
      );

    const candle =
      candleAnalysis(
        candles
      );

    const levels =
      supportResistance(
        candles,
        60
      );

    let callScore = 0;
    let putScore = 0;

    // -------------------------------------------------------
    // EMA STRUCTURE
    // -------------------------------------------------------

    if (
      ema9 > ema21
    ) {
      callScore += 18;
    } else {
      putScore += 18;
    }

    if (
      ema21 > ema50
    ) {
      callScore += 14;
    } else {
      putScore += 14;
    }

    if (
      current.close >
      ema50
    ) {
      callScore += 12;
    } else {
      putScore += 12;
    }

    // -------------------------------------------------------
    // RSI
    // -------------------------------------------------------

    if (rsi !== null) {
      if (
        rsi >= 52 &&
        rsi <= 70
      ) {
        callScore += 14;
      }

      if (
        rsi <= 48 &&
        rsi >= 30
      ) {
        putScore += 14;
      }

      // Strong momentum zones
      if (
        rsi > 60 &&
        rsi <= 72
      ) {
        callScore += 4;
      }

      if (
        rsi < 40 &&
        rsi >= 28
      ) {
        putScore += 4;
      }

      // Extreme zones don't completely kill
      // the signal; they reduce confidence.
      if (rsi > 78) {
        callScore -= 5;
      }

      if (rsi < 22) {
        putScore -= 5;
      }
    }

    // -------------------------------------------------------
    // MACD
    // -------------------------------------------------------

    if (
      macd.macd !== null &&
      macd.signal !== null
    ) {
      if (
        macd.macd >
          macd.signal &&
        macd.histogram > 0
      ) {
        callScore += 16;
      }

      if (
        macd.macd <
          macd.signal &&
        macd.histogram < 0
      ) {
        putScore += 16;
      }

      // Histogram direction
      if (
        macd.histogram > 0
      ) {
        callScore += 3;
      }

      if (
        macd.histogram < 0
      ) {
        putScore += 3;
      }
    }

    // -------------------------------------------------------
    // CANDLE MOMENTUM
    // -------------------------------------------------------

    if (
      candle.bullish &&
      candle.bodyRatio >=
        0.45
    ) {
      callScore += 12;
    }

    if (
      candle.bearish &&
      candle.bodyRatio >=
        0.45
    ) {
      putScore += 12;
    }

    // Consecutive directional candle
    if (
      candle.bullish &&
      candle.previousBullish
    ) {
      callScore += 5;
    }

    if (
      candle.bearish &&
      candle.previousBearish
    ) {
      putScore += 5;
    }

    // -------------------------------------------------------
    // WICK REJECTION
    // -------------------------------------------------------

    if (
      candle.lowerWick >
        candle.body * 1.3 &&
      candle.bullish
    ) {
      callScore += 5;
    }

    if (
      candle.upperWick >
        candle.body * 1.3 &&
      candle.bearish
    ) {
      putScore += 5;
    }

    // -------------------------------------------------------
    // SUPPORT / RESISTANCE
    // -------------------------------------------------------

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
      atr &&
      distanceToResistance >
        atr * 0.5
    ) {
      if (
        ema9 > ema21
      ) {
        callScore += 5;
      }
    }

    if (
      atr &&
      distanceToSupport >
        atr * 0.5
    ) {
      if (
        ema9 < ema21
      ) {
        putScore += 5;
      }
    }

    // -------------------------------------------------------
    // TREND CONSISTENCY
    // -------------------------------------------------------

    const trend =
      trendStrength(
        ema9,
        ema21,
        ema50,
        current.close
      );

    if (
      trend.bullish === 3
    ) {
      callScore += 8;
    }

    if (
      trend.bearish === 3
    ) {
      putScore += 8;
    }

    // -------------------------------------------------------
    // VOLATILITY FILTER
    // -------------------------------------------------------

    if (atr) {
      const candleRange =
        candle.range;

      // Very tiny candle = weak momentum.
      // We don't WAIT; we simply slightly
      // reduce both sides.
      if (
        candleRange <
        atr * 0.35
      ) {
        callScore -= 3;
        putScore -= 3;
      }

      // Healthy movement
      if (
        candleRange >=
          atr * 0.7
      ) {
        if (
          candle.bullish
        ) {
          callScore += 3;
        }

        if (
          candle.bearish
        ) {
          putScore += 3;
        }
      }
    }

    // -------------------------------------------------------
    // CLAMP SCORES
    // -------------------------------------------------------

    callScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          callScore
        )
      )
    );

    putScore = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          putScore
        )
      )
    );

    // =======================================================
    // IMPORTANT:
    // NO NORMAL-MARKET WAIT
    // STRONGER DIRECTION ALWAYS WINS
    // =======================================================

    let signal;

    if (
      callScore >
      putScore
    ) {
      signal = "CALL";
    } else if (
      putScore >
      callScore
    ) {
      signal = "PUT";
    } else {
      // Perfect tie:
      // use immediate candle direction.
      signal =
        candle.bullish
          ? "CALL"
          : "PUT";
    }

    const score =
      Math.max(
        callScore,
        putScore
      );

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

  // =========================================================
  // HIGHER TIMEFRAME BIAS
  // =========================================================

  function higherTimeframeBias(
    analysis5,
    analysis15
  ) {
    let call = 0;
    let put = 0;

    if (
      analysis5.signal ===
      "CALL"
    ) {
      call += 2;
    }

    if (
      analysis15.signal ===
      "CALL"
    ) {
      call += 2;
    }

    if (
      analysis5.signal ===
      "PUT"
    ) {
      put += 2;
    }

    if (
      analysis15.signal ===
      "PUT"
    ) {
      put += 2;
    }

    if (
      call > put
    ) {
      return "CALL";
    }

    if (
      put > call
    ) {
      return "PUT";
    }

    // If higher TF ties, use the stronger
    // individual timeframe score.
    if (
      analysis5.callScore >
      analysis5.putScore
    ) {
      return "CALL";
    }

    if (
      analysis5.putScore >
      analysis5.callScore
    ) {
      return "PUT";
    }

    return "NEUTRAL";
  }

  // =========================================================
  // GEMINI CONFIRMATION
  // =========================================================

  async function askGemini(data) {
    if (!GEMINI_API_KEY) {
      return {
        signal: "NEUTRAL",
        score: 0,
        reason:
          "Gemini API key not configured"
      };
    }

    const prompt = `
You are an advanced technical market confirmation engine.

Use ONLY the supplied technical data.
Do NOT invent candles, prices, news or market information.

The system must select the strongest direction:
CALL or PUT.

WAIT should only be returned if there is literally no usable directional
evidence. Do not use WAIT merely because the setup is imperfect.

PAIR:
${pair}

ENTRY TIMEFRAME:
${timeframe}

ENTRY ANALYSIS:
${JSON.stringify(
  data.entry
)}

5 MINUTE:
${JSON.stringify(
  data.five
)}

15 MINUTE:
${JSON.stringify(
  data.fifteen
)}

HIGHER TIMEFRAME BIAS:
${data.bias}

Decision rules:

1. Compare CALL and PUT evidence.
2. Favor EMA structure, MACD, RSI momentum and candle direction.
3. Higher timeframe agreement increases confidence.
4. If higher timeframe conflicts with entry timeframe, reduce confidence,
   but still select the stronger direction.
5. Do not invent data.
6. Score is technical-analysis confidence, NOT guaranteed win probability.
7. Return CALL or PUT whenever directional evidence exists.
8. Only return WAIT if data is unusable.

Return ONLY JSON:

{
  "signal": "CALL" | "PUT" | "WAIT",
  "score": number,
  "reason": "short explanation"
}
`;

    try {
      const response =
        await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY
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
                temperature: 0.05,

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
        json
          ?.candidates?.[0]
          ?.content?.parts?.[0]
          ?.text;

      if (!text) {
        throw new Error(
          "Empty Gemini response"
        );
      }

      const cleaned =
        text
          .replace(
            /```json/g,
            ""
          )
          .replace(
            /```/g,
            ""
          )
          .trim();

      const result =
        JSON.parse(cleaned);

      let signal =
        String(
          result.signal ||
            "WAIT"
        ).toUpperCase();

      if (
        ![
          "CALL",
          "PUT",
          "WAIT"
        ].includes(signal)
      ) {
        signal = "WAIT";
      }

      return {
        signal,

        score: Math.max(
          0,
          Math.min(
            100,
            Number(
              result.score
            ) || 0
          )
        ),

        reason:
          String(
            result.reason ||
              ""
          )
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

  // =========================================================
  // MAIN ENGINE
  // =========================================================

  try {
    const [
      entryRaw,
      fiveRaw,
      fifteenRaw
    ] =
      await Promise.all([
        getCandles(
          pair,
          timeframe
        ),

        getCandles(
          pair,
          "5m"
        ),

        getCandles(
          pair,
          "15m"
        )
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

    // -------------------------------------------------------
    // DATA CHECK
    // -------------------------------------------------------

    if (
      entry.length < 80 ||
      five.length < 80 ||
      fifteen.length < 80
    ) {
      return res.status(200).json({
        ok: false,

        signal: "WAIT",

        score: 0,

        reason:
          "Not enough closed candles",

        pair,
        timeframe
      });
    }

    // -------------------------------------------------------
    // ANALYZE
    // -------------------------------------------------------

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

    // -------------------------------------------------------
    // FEED AGE
    // -------------------------------------------------------

    const latestEntry =
      entry[
        entry.length - 1
      ];

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
        ok: false,

        signal: "WAIT",

        score: 0,

        reason:
          "Market data is stale",

        pair,

        timeframe,

        feedAgeSeconds
      });
    }

    // -------------------------------------------------------
    // GEMINI
    // -------------------------------------------------------

    const ai =
      await askGemini({
        entry:
          entryAnalysis,

        five:
          fiveAnalysis,

        fifteen:
          fifteenAnalysis,

        bias
      });

    // =======================================================
    // FINAL DECISION ENGINE
    // =======================================================

    const technicalSignal =
      entryAnalysis.signal;

    const technicalScore =
      entryAnalysis.score;

    let finalSignal =
      technicalSignal;

    let finalScore =
      technicalScore;

    // -------------------------------------------------------
    // GEMINI SUPPORT
    // -------------------------------------------------------

    if (
      ai.signal ===
      technicalSignal &&
      ai.score > 0
    ) {
      // Agreement bonus
      finalScore =
        Math.round(
          technicalScore *
            0.65 +
            ai.score *
              0.35
        );

      finalScore += 4;
    }

    // -------------------------------------------------------
    // HIGHER TF AGREEMENT
    // -------------------------------------------------------

    if (
      bias ===
      technicalSignal
    ) {
      finalScore += 5;
    }

    // -------------------------------------------------------
    // HIGHER TF CONFLICT
    // -------------------------------------------------------

    if (
      bias !== "NEUTRAL" &&
      bias !==
        technicalSignal
    ) {
      finalScore -= 6;
    }

    // -------------------------------------------------------
    // GEMINI CONFLICT
    // -------------------------------------------------------

    if (
      ai.signal !==
        "WAIT" &&
      ai.signal !==
        technicalSignal
    ) {
      finalScore -= 5;
    }

    // -------------------------------------------------------
    // NEVER LET A NORMAL SETUP BECOME WAIT
    // -------------------------------------------------------

    finalScore =
      Math.max(
        55,
        Math.min(
          98,
          Math.round(
            finalScore
          )
        )
      );

    // =======================================================
    // FINAL RESPONSE
    // =======================================================

    return res.status(200).json({
      ok: true,

      pair,
      timeframe,

      // MAIN SIGNAL
      signal:
        finalSignal,

      score:
        finalScore,

      // TECHNICAL ENGINE
      technicalSignal,

      technicalScore,

      callScore:
        entryAnalysis.callScore,

      putScore:
        entryAnalysis.putScore,

      // AI
      aiSignal:
        ai.signal,

      aiScore:
        ai.score,

      aiReason:
        ai.reason,

      // MTF
      higherTimeframeBias:
        bias,

      // INDICATORS
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

      // LEVELS
      support:
        entryAnalysis.support,

      resistance:
        entryAnalysis.resistance,

      price:
        entryAnalysis.price,

      // CANDLE
      candle:
        entryAnalysis.candle,

      // DATA
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
