// api/scan.js

export default async function handler(req, res) {
  // =========================
  // CORS
  // =========================
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

  // =========================
  // ENV
  // =========================
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  const GEMINI_MODEL =
    process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

  const TWELVE_DATA_API_KEY =
    process.env.TWELVE_DATA_API_KEY;

  // =========================
  // TWELVE DATA CREDIT TRACKER
  // =========================
  // These values are updated from Twelve Data
  // response headers:
  // api-credits-used
  // api-credits-left
  //
  // IMPORTANT:
  // We do NOT call /api_usage because that endpoint
  // itself consumes 1 API credit.
  // =========================

  const twelveCredits = {
    used: 0,
    left: null
  };

  function updateTwelveCredits(headers) {
    if (!headers) return;

    const usedRaw =
      headers.get("api-credits-used");

    const leftRaw =
      headers.get("api-credits-left");

    const used =
      Number(usedRaw);

    const left =
      Number(leftRaw);

    if (Number.isFinite(used)) {
      twelveCredits.used =
        Math.max(
          twelveCredits.used,
          used
        );
    }

    if (Number.isFinite(left)) {
      if (
        twelveCredits.left === null
      ) {
        twelveCredits.left = left;
      } else {
        twelveCredits.left =
          Math.min(
            twelveCredits.left,
            left
          );
      }
    }
  }

  function getCreditInfo() {
    const hasLeft =
      Number.isFinite(
        twelveCredits.left
      );

    return {
      apiCreditsUsed:
        twelveCredits.used,

      apiCreditsLeft:
        hasLeft
          ? twelveCredits.left
          : null,

      apiCreditsLimit:
        hasLeft
          ? twelveCredits.used +
            twelveCredits.left
          : null
    };
  }

  // =========================
  // PAIRS
  // =========================
  const FOREX_PAIRS = new Set([
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
  ]);

  // =========================
  // TIMEFRAMES
  // =========================
  const TF_MAP = {
    "1m": {
      td: "1min",
      seconds: 60,
      staleLimit: 90
    },

    "5m": {
      td: "5min",
      seconds: 300,
      staleLimit: 360
    },

    "15m": {
      td: "15min",
      seconds: 900,
      staleLimit: 900
    },

    "30m": {
      td: "30min",
      seconds: 1800,
      staleLimit: 1800
    },

    "1h": {
      td: "1h",
      seconds: 3600,
      staleLimit: 3600
    }
  };

  // =========================
  // HELPERS
  // =========================
  function normalizePair(value) {
    let p = String(value || "")
      .toUpperCase()
      .trim();

    p = p
      .replace(/\(QUOTEX\)/g, "")
      .replace(/QUOTEX/g, "")
      .replace(/\s+/g, "")
      .replace(/[-_/]/g, "");

    return p;
  }

  function isCryptoPair(pair) {
    return (
      pair.endsWith("USDT") ||
      pair.endsWith("BUSD") ||
      pair.endsWith("USDC")
    );
  }

  function num(v, fallback = 0) {
    const n = Number(v);

    return Number.isFinite(n)
      ? n
      : fallback;
  }

  function average(arr) {
    if (!arr.length) {
      return 0;
    }

    return (
      arr.reduce(
        (a, b) => a + b,
        0
      ) / arr.length
    );
  }

  function clamp(v, min, max) {
    return Math.max(
      min,
      Math.min(max, v)
    );
  }

  // =========================
  // FETCH JSON WITH TIMEOUT
  // =========================
  async function fetchJson(
    url,
    options = {},
    timeoutMs = 8000,
    returnMeta = false
  ) {
    const controller =
      new AbortController();

    const timer =
      setTimeout(() => {
        controller.abort();
      }, timeoutMs);

    try {
      const response =
        await fetch(
          url,
          {
            ...options,
            signal:
              controller.signal
          }
        );

      const text =
        await response.text();

      let json;

      try {
        json =
          JSON.parse(text);
      } catch {
        throw new Error(
          `Invalid JSON response (${response.status})`
        );
      }

      if (!response.ok) {
        const msg =
          json?.message ||
          json?.error?.message ||
          `HTTP ${response.status}`;

        throw new Error(msg);
      }

      if (returnMeta) {
        return {
          json,
          headers:
            response.headers
        };
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  // =========================
  // TWELVE DATA FOREX
  // =========================
  async function fetchTwelveData(
    pair,
    timeframe
  ) {
    if (!TWELVE_DATA_API_KEY) {
      throw new Error(
        "TWELVE_DATA_API_KEY is not configured"
      );
    }

    const tf =
      TF_MAP[timeframe];

    if (!tf) {
      throw new Error(
        `Unsupported timeframe: ${timeframe}`
      );
    }

    const symbol =
      `${pair.slice(0, 3)}/${pair.slice(3, 6)}`;

    const url =
      new URL(
        "https://api.twelvedata.com/time_series"
      );

    url.searchParams.set(
      "symbol",
      symbol
    );

    url.searchParams.set(
      "interval",
      tf.td
    );

    url.searchParams.set(
      "outputsize",
      "250"
    );

    url.searchParams.set(
      "timezone",
      "UTC"
    );

    url.searchParams.set(
      "apikey",
      TWELVE_DATA_API_KEY
    );

    // Get both JSON and response headers
    const result =
      await fetchJson(
        url.toString(),
        {},
        10000,
        true
      );

    const json =
      result.json;

    // =========================
    // UPDATE TWELVE DATA CREDITS
    // =========================
    updateTwelveCredits(
      result.headers
    );

    if (
      json?.status === "error"
    ) {
      throw new Error(
        json?.message ||
          "Twelve Data API error"
      );
    }

    if (
      !Array.isArray(
        json?.values
      )
    ) {
      throw new Error(
        "Twelve Data returned no candle data"
      );
    }

    const candles =
      json.values
        .map((x) => {
          const time =
            Date.parse(
              String(
                x.datetime
              ).replace(
                " ",
                "T"
              ) + "Z"
            );

          return {
            time,

            open:
              num(x.open),

            high:
              num(x.high),

            low:
              num(x.low),

            close:
              num(x.close),

            volume:
              num(x.volume)
          };
        })
        .filter(
          (c) =>
            Number.isFinite(
              c.time
            ) &&
            c.open > 0 &&
            c.high > 0 &&
            c.low > 0 &&
            c.close > 0
        )
        .sort(
          (a, b) =>
            a.time - b.time
        );

    if (
      candles.length < 80
    ) {
      throw new Error(
        `Insufficient Twelve Data candles: ${candles.length}`
      );
    }

    return candles;
  }

  // =========================
  // BINANCE CRYPTO
  // =========================
  async function fetchBinance(
    pair,
    timeframe
  ) {
    const tf =
      TF_MAP[timeframe];

    if (!tf) {
      throw new Error(
        `Unsupported timeframe: ${timeframe}`
      );
    }

    const symbol =
      pair;

    const url =
      new URL(
        "https://api.binance.com/api/v3/klines"
      );

    url.searchParams.set(
      "symbol",
      symbol
    );

    url.searchParams.set(
      "interval",
      timeframe === "1m"
        ? "1m"
        : timeframe === "5m"
        ? "5m"
        : timeframe === "15m"
        ? "15m"
        : timeframe === "30m"
        ? "30m"
        : "1h"
    );

    url.searchParams.set(
      "limit",
      "250"
    );

    const data =
      await fetchJson(
        url.toString(),
        {},
        8000
      );

    if (
      !Array.isArray(data)
    ) {
      throw new Error(
        "Binance returned invalid candle data"
      );
    }

    const candles =
      data
        .map((x) => ({
          time:
            Number(x[0]),

          open:
            Number(x[1]),

          high:
            Number(x[2]),

          low:
            Number(x[3]),

          close:
            Number(x[4]),

          volume:
            Number(x[5]),

          closeTime:
            Number(x[6])
        }))
        .filter(
          (c) =>
            Number.isFinite(
              c.time
            ) &&
            c.open > 0 &&
            c.high > 0 &&
            c.low > 0 &&
            c.close > 0
        )
        .sort(
          (a, b) =>
            a.time - b.time
        );

    if (
      candles.length < 80
    ) {
      throw new Error(
        `Insufficient Binance candles: ${candles.length}`
      );
    }

    return candles;
  }

  // =========================
  // GET CANDLES
  // =========================
  async function getCandles(
    pair,
    timeframe
  ) {
    if (
      isCryptoPair(pair)
    ) {
      return {
        candles:
          await fetchBinance(
            pair,
            timeframe
          ),

        source:
          "Binance"
      };
    }

    if (
      FOREX_PAIRS.has(pair)
    ) {
      return {
        candles:
          await fetchTwelveData(
            pair,
            timeframe
          ),

        source:
          "Twelve Data"
      };
    }

    throw new Error(
      `Unsupported pair: ${pair}`
    );
  }

  // =========================
  // CLOSED CANDLES ONLY
  // =========================
  function closedCandles(
    candles,
    timeframe
  ) {
    const tf =
      TF_MAP[timeframe];

    const intervalMs =
      tf.seconds * 1000;

    const now =
      Date.now();

    return candles
      .filter((c) => {
        const endTime =
          c.closeTime ||
          c.time +
            intervalMs;

        return (
          endTime <= now
        );
      })
      .sort(
        (a, b) =>
          a.time - b.time
      );
  }

  // =========================
  // EMA
  // =========================
  function ema(
    values,
    period
  ) {
    if (
      values.length <
      period
    ) {
      return 0;
    }

    const multiplier =
      2 /
      (period + 1);

    let result =
      average(
        values.slice(
          0,
          period
        )
      );

    for (
      let i = period;
      i < values.length;
      i++
    ) {
      result =
        (values[i] -
          result) *
          multiplier +
        result;
    }

    return result;
  }

  // =========================
  // RSI
  // =========================
  function rsi(
    values,
    period = 14
  ) {
    if (
      values.length <=
      period
    ) {
      return 50;
    }

    let gains = 0;
    let losses = 0;

    for (
      let i = 1;
      i <= period;
      i++
    ) {
      const diff =
        values[i] -
        values[i - 1];

      if (
        diff >= 0
      ) {
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
      let i =
        period + 1;
      i < values.length;
      i++
    ) {
      const diff =
        values[i] -
        values[i - 1];

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

    if (
      avgLoss === 0
    ) {
      return 100;
    }

    const rs =
      avgGain /
      avgLoss;

    return (
      100 -
      100 /
        (1 + rs)
    );
  }

  // =========================
  // ATR
  // =========================
  function atr(
    candles,
    period = 14
  ) {
    if (
      candles.length <=
      period
    ) {
      return 0;
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

    return average(
      trs.slice(-period)
    );
  }

  // =========================
  // MACD
  // =========================
  function macd(values) {
    if (
      values.length <
      35
    ) {
      return {
        macd: 0,
        signal: 0,
        histogram: 0
      };
    }

    const macdSeries = [];

    for (
      let i = 0;
      i < values.length;
      i++
    ) {
      const slice =
        values.slice(
          0,
          i + 1
        );

      if (
        slice.length < 26
      ) {
        continue;
      }

      const fast =
        ema(
          slice,
          12
        );

      const slow =
        ema(
          slice,
          26
        );

      macdSeries.push(
        fast - slow
      );
    }

    if (
      macdSeries.length <
      9
    ) {
      return {
        macd: 0,
        signal: 0,
        histogram: 0
      };
    }

    const currentMacd =
      macdSeries[
        macdSeries.length - 1
      ];

    const signalLine =
      ema(
        macdSeries,
        9
      );

    return {
      macd:
        currentMacd,

      signal:
        signalLine,

      histogram:
        currentMacd -
        signalLine
    };
  }

  // =========================
  // CANDLE ANALYSIS
  // =========================
  function analyzeCandle(
    candle
  ) {
    const range =
      candle.high -
      candle.low;

    if (
      range <= 0
    ) {
      return {
        direction:
          "NEUTRAL",

        bodyPercent:
          0,

        upperWick:
          0,

        lowerWick:
          0
      };
    }

    const body =
      Math.abs(
        candle.close -
          candle.open
      );

    const bodyPercent =
      body / range;

    const upperWick =
      candle.high -
      Math.max(
        candle.open,
        candle.close
      );

    const lowerWick =
      Math.min(
        candle.open,
        candle.close
      ) -
      candle.low;

    let direction =
      "NEUTRAL";

    if (
      candle.close >
      candle.open
    ) {
      direction =
        "BULLISH";
    } else if (
      candle.close <
      candle.open
    ) {
      direction =
        "BEARISH";
    }

    return {
      direction,

      bodyPercent,

      upperWick,

      lowerWick
    };
  }

  // =========================
  // SUPPORT / RESISTANCE
  // =========================
  function supportResistance(
    candles
  ) {
    const recent =
      candles.slice(-40);

    const highs =
      recent.map(
        (c) => c.high
      );

    const lows =
      recent.map(
        (c) => c.low
      );

    const resistance =
      Math.max(
        ...highs
      );

    const support =
      Math.min(
        ...lows
      );

    return {
      support,
      resistance
    };
  }

  // =========================
  // TREND STRENGTH
  // =========================
  function trendStrength(
    candles,
    e9,
    e21,
    e50,
    atrValue
  ) {
    if (
      !atrValue
    ) {
      return 0;
    }

    const spread =
      Math.abs(
        e9 - e21
      );

    const longSpread =
      Math.abs(
        e21 - e50
      );

    const raw =
      ((spread +
        longSpread) /
        atrValue) *
      25;

    return clamp(
      raw,
      0,
      100
    );
  }

  // =========================
  // TECHNICAL ENGINE
  // =========================
  function technicalAnalysis(
    candles
  ) {
    const closes =
      candles.map(
        (c) => c.close
      );

    const current =
      candles[
        candles.length - 1
      ];

    const previous =
      candles[
        candles.length - 2
      ];

    const e9 =
      ema(
        closes,
        9
      );

    const e21 =
      ema(
        closes,
        21
      );

    const e50 =
      ema(
        closes,
        50
      );

    const rsiValue =
      rsi(
        closes,
        14
      );

    const atrValue =
      atr(
        candles,
        14
      );

    const macdValue =
      macd(
        closes
      );

    const candle =
      analyzeCandle(
        current
      );

    const levels =
      supportResistance(
        candles
      );

    const trend =
      trendStrength(
        candles,
        e9,
        e21,
        e50,
        atrValue
      );

    let callScore =
      50;

    let putScore =
      50;

    // =========================
    // EMA STRUCTURE
    // =========================
    if (
      e9 > e21 &&
      e21 > e50
    ) {
      callScore +=
        16;
    }

    if (
      e9 < e21 &&
      e21 < e50
    ) {
      putScore +=
        16;
    }

    // =========================
    // PRICE VS EMA
    // =========================
    if (
      current.close >
      e9
    ) {
      callScore +=
        7;
    } else {
      putScore +=
        7;
    }

    if (
      current.close >
      e21
    ) {
      callScore +=
        5;
    } else {
      putScore +=
        5;
    }

    // =========================
    // RSI
    // =========================
    if (
      rsiValue >= 52 &&
      rsiValue <= 68
    ) {
      callScore +=
        10;
    }

    if (
      rsiValue <= 48 &&
      rsiValue >= 32
    ) {
      putScore +=
        10;
    }

    if (
      rsiValue > 72
    ) {
      callScore -=
        10;
    }

    if (
      rsiValue < 28
    ) {
      putScore -=
        10;
    }

    // =========================
    // MACD
    // =========================
    if (
      macdValue.histogram >
        0 &&
      macdValue.macd >=
        macdValue.signal
    ) {
      callScore +=
        10;
    }

    if (
      macdValue.histogram <
        0 &&
      macdValue.macd <=
        macdValue.signal
    ) {
      putScore +=
        10;
    }

    // =========================
    // CANDLE
    // =========================
    if (
      candle.direction ===
      "BULLISH"
    ) {
      callScore +=
        8;
    }

    if (
      candle.direction ===
      "BEARISH"
    ) {
      putScore +=
        8;
    }

    // =========================
    // STRONG BODY
    // =========================
    if (
      candle.bodyPercent >=
      0.60
    ) {
      if (
        candle.direction ===
        "BULLISH"
      ) {
        callScore +=
          5;
      }

      if (
        candle.direction ===
        "BEARISH"
      ) {
        putScore +=
          5;
      }
    }

    // =========================
    // WICK REJECTION
    // =========================
    if (
      candle.lowerWick >
      candle.upperWick *
        1.5
    ) {
      callScore +=
        5;
    }

    if (
      candle.upperWick >
      candle.lowerWick *
        1.5
    ) {
      putScore +=
        5;
    }

    // =========================
    // SUPPORT / RESISTANCE
    // =========================
    const price =
      current.close;

    const distanceToResistance =
      Math.abs(
        levels.resistance -
          price
      );

    const distanceToSupport =
      Math.abs(
        price -
          levels.support
      );

    if (
      atrValue > 0 &&
      distanceToResistance <
        atrValue * 0.20
    ) {
      callScore -=
        15;
    }

    if (
      atrValue > 0 &&
      distanceToSupport <
        atrValue * 0.20
    ) {
      putScore -=
        15;
    }

    if (
      distanceToSupport >
        atrValue * 0.50 &&
      price >
        levels.support
    ) {
      callScore +=
        3;
    }

    if (
      distanceToResistance >
        atrValue * 0.50 &&
      price <
        levels.resistance
    ) {
      putScore +=
        3;
    }

    // =========================
    // MOMENTUM CONSISTENCY
    // =========================
    const recent =
      candles.slice(-5);

    let bullishCount =
      0;

    let bearishCount =
      0;

    for (
      const c of recent
    ) {
      if (
        c.close >
        c.open
      ) {
        bullishCount++;
      } else if (
        c.close <
        c.open
      ) {
        bearishCount++;
      }
    }

    if (
      bullishCount >=
      3
    ) {
      callScore +=
        5;
    }

    if (
      bearishCount >=
      3
    ) {
      putScore +=
        5;
    }

    // =========================
    // EMA SPREAD QUALITY
    // =========================
    const emaSpread =
      atrValue > 0
        ? Math.abs(
            e9 - e21
          ) /
          atrValue
        : 0;

    if (
      emaSpread < 0.12
    ) {
      callScore -=
        5;

      putScore -=
        5;
    }

    callScore =
      clamp(
        callScore,
        0,
        100
      );

    putScore =
      clamp(
        putScore,
        0,
        100
      );

    const signal =
      callScore >=
      putScore
        ? "CALL"
        : "PUT";

    const winner =
      Math.max(
        callScore,
        putScore
      );

    const loser =
      Math.min(
        callScore,
        putScore
      );

    const edge =
      winner -
      loser;

    let technicalScore =
      55 +
      edge * 0.55;

    technicalScore +=
      trend * 0.10;

    technicalScore =
      clamp(
        Math.round(
          technicalScore
        ),
        55,
        97
      );

    // =========================
    // TRADE QUALITY
    // =========================
    let quality =
      "NORMAL";

    if (
      edge >= 20
    ) {
      quality =
        "STRONG";
    }

    if (
      edge < 8
    ) {
      quality =
        "WEAK";
    }

    const tradeable =
      edge >= 8 &&
      technicalScore >=
        62;

    return {
      signal,

      callScore:
        Math.round(
          callScore
        ),

      putScore:
        Math.round(
          putScore
        ),

      technicalScore,

      tradeable,

      quality,

      price,

      indicators: {
        ema9:
          e9,

        ema21:
          e21,

        ema50:
          e50,

        rsi:
          rsiValue,

        atr:
          atrValue,

        macd:
          macdValue.macd,

        macdSignal:
          macdValue.signal,

        macdHistogram:
          macdValue.histogram,

        trendStrength:
          trend,

        emaSpread
      },

      levels,

      candle: {
        direction:
          candle.direction,

        bodyPercent:
          candle.bodyPercent,

        upperWick:
          candle.upperWick,

        lowerWick:
          candle.lowerWick
      },

      momentum: {
        bullishCount,

        bearishCount
      }
    };
  }

  // =========================
  // GEMINI AI
  // =========================
  async function geminiConfirm({
    pair,
    timeframe,
    technical,
    mtf
  }) {
    if (
      !GEMINI_API_KEY
    ) {
      return {
        signal:
          "WAIT",

        score:
          0,

        status:
          "UNAVAILABLE",

        error:
          "GEMINI_API_KEY is not configured",

        reason:
          "AI key missing"
      };
    }

    const prompt = `
You are a strict financial market confirmation engine.

IMPORTANT:
- Do not invent market data.
- Use ONLY the supplied technical data.
- You are a confirmation layer, not the primary signal engine.
- Return exactly one of CALL, PUT, WAIT.
- WAIT is appropriate if the technical evidence is clearly mixed or unusable.
- Do not claim guaranteed profit or guaranteed accuracy.

PAIR: ${pair}
TIMEFRAME: ${timeframe}

TECHNICAL SIGNAL:
${technical.signal}

TECHNICAL SCORE:
${technical.technicalScore}

CALL SCORE:
${technical.callScore}

PUT SCORE:
${technical.putScore}

TRADEABLE:
${technical.tradeable}

QUALITY:
${technical.quality}

INDICATORS:
${JSON.stringify(
  technical.indicators
)}

SUPPORT/RESISTANCE:
${JSON.stringify(
  technical.levels
)}

CANDLE:
${JSON.stringify(
  technical.candle
)}

MOMENTUM:
${JSON.stringify(
  technical.momentum
)}

HIGHER TIMEFRAME:
${JSON.stringify(
  mtf
)}

Return JSON only:

{
  "signal": "CALL",
  "score": 0,
  "reason": "short technical reason"
}

Score must be 0-100.
`;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        GEMINI_MODEL
      )}:generateContent`;

    try {
      const response =
        await fetch(
          url,
          {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json",

              "x-goog-api-key":
                GEMINI_API_KEY
            },

            body:
              JSON.stringify({
                contents: [
                  {
                    role:
                      "user",

                    parts: [
                      {
                        text:
                          prompt
                      }
                    ]
                  }
                ],

                generationConfig: {
                  temperature:
                    0,

                  responseMimeType:
                    "application/json"
                }
              }),

            signal:
              AbortSignal.timeout(
                8000
              )
          }
        );

      const raw =
        await response.text();

      let data =
        null;

      try {
        data =
          JSON.parse(
            raw
          );
      } catch {
        data =
          null;
      }

      if (
        !response.ok
      ) {
        let message =
          data?.error?.message ||
          `Gemini HTTP ${response.status}`;

        message =
          String(
            message
          ).replace(
            GEMINI_API_KEY,
            "[REDACTED]"
          );

        return {
          signal:
            "WAIT",

          score:
            0,

          status:
            "ERROR",

          error:
            message,

          reason:
            "Gemini API request failed"
        };
      }

      const text =
        data
          ?.candidates?.[0]
          ?.content
          ?.parts?.[0]
          ?.text;

      if (!text) {
        return {
          signal:
            "WAIT",

          score:
            0,

          status:
            "ERROR",

          error:
            "Gemini returned empty response",

          reason:
            "No AI response"
        };
      }

      let parsed;

      try {
        parsed =
          JSON.parse(
            text
          );
      } catch {
        const cleaned =
          text
            .replace(
              /```json/gi,
              ""
            )
            .replace(
              /```/g,
              ""
            )
            .trim();

        try {
          parsed =
            JSON.parse(
              cleaned
            );
        } catch {
          const match =
            cleaned.match(
              /\{[\s\S]*\}/
            );

          if (
            match
          ) {
            parsed =
              JSON.parse(
                match[0]
              );
          }
        }
      }

      if (
        !parsed
      ) {
        return {
          signal:
            "WAIT",

          score:
            0,

          status:
            "ERROR",

          error:
            "Could not parse Gemini JSON",

          reason:
            "Invalid AI JSON"
        };
      }

      let signal =
        String(
          parsed.signal ||
            "WAIT"
        ).toUpperCase();

      if (
        ![
          "CALL",
          "PUT",
          "WAIT"
        ].includes(
          signal
        )
      ) {
        signal =
          "WAIT";
      }

      return {
        signal,

        score:
          clamp(
            Math.round(
              num(
                parsed.score
              )
            ),
            0,
            100
          ),

        status:
          "OK",

        error:
          null,

        reason:
          String(
            parsed.reason ||
              "AI confirmation"
          ).slice(
            0,
            300
          )
      };
    } catch (
      error
    ) {
      return {
        signal:
          "WAIT",

        score:
          0,

        status:
          "ERROR",

        error:
          error?.name ===
          "TimeoutError"
            ? "Gemini request timeout"
            : String(
                error?.message ||
                  "Gemini request failed"
              ),

        reason:
          "AI confirmation unavailable"
      };
    }
  }

  // =========================
  // MTF ANALYSIS
  // =========================
  function getMTFBias(
    analysis5,
    analysis15
  ) {
    const votes = [
      analysis5?.signal,
      analysis15?.signal
    ].filter(
      (x) =>
        x === "CALL" ||
        x === "PUT"
    );

    if (
      !votes.length
    ) {
      return {
        bias:
          "NEUTRAL",

        agreement:
          false
      };
    }

    const callVotes =
      votes.filter(
        (x) =>
          x === "CALL"
      ).length;

    const putVotes =
      votes.filter(
        (x) =>
          x === "PUT"
      ).length;

    if (
      callVotes >
      putVotes
    ) {
      return {
        bias:
          "CALL",

        agreement:
          callVotes ===
          votes.length
      };
    }

    if (
      putVotes >
      callVotes
    ) {
      return {
        bias:
          "PUT",

        agreement:
          putVotes ===
          votes.length
      };
    }

    return {
      bias:
        "NEUTRAL",

      agreement:
        false
    };
  }

  // =========================
  // MAIN
  // =========================
  try {
    const inputPair =
      req.query?.pair ||
      req.body?.pair ||
      "EURUSD";

    const timeframe =
      String(
        req.query?.timeframe ||
          req.body?.timeframe ||
          "1m"
      );

    const pair =
      normalizePair(
        inputPair
      );

    if (
      !TF_MAP[timeframe]
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          signal:
            "WAIT",

          reason:
            "Unsupported timeframe",

          ...getCreditInfo()
        });
    }

    // =========================
    // PAIR VALIDATION
    // =========================
    if (
      !FOREX_PAIRS.has(
        pair
      ) &&
      !isCryptoPair(
        pair
      )
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          signal:
            "WAIT",

          reason:
            `Unsupported pair: ${pair}`,

          ...getCreditInfo()
        });
    }

    // =========================
    // LOAD ENTRY + MTF
    // =========================
    const [
      entryData,
      fiveData,
      fifteenData
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

    const entryCandles =
      closedCandles(
        entryData.candles,
        timeframe
      );

    const fiveCandles =
      closedCandles(
        fiveData.candles,
        "5m"
      );

    const fifteenCandles =
      closedCandles(
        fifteenData.candles,
        "15m"
      );

    if (
      entryCandles.length <
        80 ||
      fiveCandles.length <
        80 ||
      fifteenCandles.length <
        80
    ) {
      return res
        .status(200)
        .json({
          ok:
            false,

          signal:
            "WAIT",

          reason:
            "Not enough closed candles",

          pair,

          timeframe,

          ...getCreditInfo()
        });
    }

    // =========================
    // FEED AGE
    // =========================
    const now =
      Date.now();

    const entryLatest =
      entryCandles[
        entryCandles.length - 1
      ];

    const entryTf =
      TF_MAP[
        timeframe
      ];

    const entryEnd =
      entryLatest.closeTime ||
      entryLatest.time +
        entryTf.seconds *
          1000;

    const feedAgeSeconds =
      Math.max(
        0,
        Math.floor(
          (now -
            entryEnd) /
            1000
        )
      );

    // =========================
    // STRICT STALE CHECK
    // =========================
    if (
      feedAgeSeconds >
      entryTf.staleLimit
    ) {
      return res
        .status(200)
        .json({
          ok:
            false,

          signal:
            "WAIT",

          reason:
            "Market feed is stale",

          pair,

          timeframe,

          price:
            entryLatest.close,

          feedAgeSeconds,

          staleLimit:
            entryTf.staleLimit,

          source:
            entryData.source,

          ...getCreditInfo(),

          warning:
            "No trade signal generated from stale market data."
        });
    }

    // =========================
    // TECHNICAL ANALYSIS
    // =========================
    const technical =
      technicalAnalysis(
        entryCandles
      );

    const analysis5 =
      technicalAnalysis(
        fiveCandles
      );

    const analysis15 =
      technicalAnalysis(
        fifteenCandles
      );

    const mtf =
      getMTFBias(
        analysis5,
        analysis15
      );

    // =========================
    // GEMINI
    // =========================
    const ai =
      await geminiConfirm({
        pair,

        timeframe,

        technical,

        mtf: {
          fiveMinute:
            analysis5.signal,

          fifteenMinute:
            analysis15.signal,

          bias:
            mtf.bias
        }
      });

    // =========================
    // FINAL SIGNAL
    // =========================
    let finalSignal =
      technical.signal;

    let finalScore =
      technical.technicalScore;

    // =========================
    // HIGHER TIMEFRAME AGREEMENT
    // =========================
    if (
      mtf.bias ===
      finalSignal
    ) {
      finalScore +=
        5;
    }

    // =========================
    // MTF CONFLICT
    // =========================
    if (
      mtf.bias !==
        "NEUTRAL" &&
      mtf.bias !==
        finalSignal
    ) {
      finalScore -=
        7;
    }

    // =========================
    // AI AGREEMENT
    // =========================
    if (
      ai.status ===
        "OK" &&
      ai.signal ===
        finalSignal
    ) {
      finalScore +=
        Math.min(
          6,
          Math.round(
            ai.score /
              20
          )
        );
    }

    // =========================
    // AI CONFLICT
    // =========================
    if (
      ai.status ===
        "OK" &&
      ai.signal !==
        "WAIT" &&
      ai.signal !==
        finalSignal
    ) {
      finalScore -=
        5;
    }

    finalScore =
      clamp(
        Math.round(
          finalScore
        ),
        55,
        98
      );

    // =========================
    // WEAK SETUP
    // =========================
    if (
      !technical.tradeable
    ) {
      finalSignal =
        "WAIT";

      finalScore =
        Math.min(
          finalScore,
          61
        );
    }

    // =========================
    // ENTRY CANDLE
    // =========================
    const intervalMs =
      entryTf.seconds *
      1000;

    const nextCandleStart =
      entryEnd;

    const nextCandleEnd =
      nextCandleStart +
      intervalMs;

    // =========================
    // RESPONSE
    // =========================
    return res
      .status(200)
      .json({
        ok:
          true,

        pair,

        timeframe,

        signal:
          finalSignal,

        score:
          finalScore,

        technicalSignal:
          technical.signal,

        technicalScore:
          technical.technicalScore,

        callScore:
          technical.callScore,

        putScore:
          technical.putScore,

        tradeable:
          technical.tradeable,

        quality:
          technical.quality,

        aiSignal:
          ai.signal,

        aiScore:
          ai.score,

        aiStatus:
          ai.status,

        aiReason:
          ai.reason,

        aiError:
          ai.error,

        mtf: {
          bias:
            mtf.bias,

          agreement:
            mtf.agreement,

          fiveMinute:
            analysis5.signal,

          fiveMinuteScore:
            analysis5.technicalScore,

          fifteenMinute:
            analysis15.signal,

          fifteenMinuteScore:
            analysis15.technicalScore
        },

        indicators:
          technical.indicators,

        levels:
          technical.levels,

        candle:
          technical.candle,

        momentum:
          technical.momentum,

        price:
          technical.price,

        feedAgeSeconds,

        feedTimestamp:
          new Date(
            entryEnd
          ).toISOString(),

        nextCandleStart:
          new Date(
            nextCandleStart
          ).toISOString(),

        nextCandleEnd:
          new Date(
            nextCandleEnd
          ).toISOString(),

        source:
          entryData.source,

        // =========================
        // TWELVE DATA CREDITS
        // =========================
        apiCreditsUsed:
          entryData.source ===
          "Twelve Data"
            ? twelveCredits.used
            : null,

        apiCreditsLeft:
          entryData.source ===
          "Twelve Data"
            ? twelveCredits.left
            : null,

        apiCreditsLimit:
          entryData.source ===
            "Twelve Data" &&
          twelveCredits.left !==
            null
            ? twelveCredits.used +
              twelveCredits.left
            : null,

        warning:
          "Market-data feed may differ from Quotex execution price. No signal system can guarantee a winning trade."
      });
  } catch (
    error
  ) {
    console.error(
      "SCAN ERROR:",
      error
    );

    return res
      .status(200)
      .json({
        ok:
          false,

        signal:
          "WAIT",

        score:
          0,

        reason:
          String(
            error?.message ||
              "Scan failed"
          ).slice(
            0,
            300
          ),

        // =========================
        // CREDITS EVEN ON ERROR
        // =========================
        ...getCreditInfo()
      });
  }
}
