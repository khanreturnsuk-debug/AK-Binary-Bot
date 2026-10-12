// api/scan.js

export default async function handler(req, res) {
  // =========================
  // CORS
  // =========================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS,POST"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept"
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // =========================
  // ENVIRONMENT
  // =========================
  const GEMINI_API_KEY =
    process.env.GEMINI_API_KEY;

  const GEMINI_MODEL =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-lite";

  const TWELVE_DATA_API_KEY =
    process.env.TWELVE_DATA_API_KEY;

  // =========================
  // CREDIT TRACKER
  // =========================
  const credits = {
    used: 0,
    left: null
  };

  function updateCredits(headers) {
    if (!headers) return;

    const used = Number(
      headers.get("api-credits-used")
    );

    const left = Number(
      headers.get("api-credits-left")
    );

    if (Number.isFinite(used)) {
      credits.used = Math.max(
        credits.used,
        used
      );
    }

    if (Number.isFinite(left)) {
      credits.left =
        credits.left === null
          ? left
          : Math.min(credits.left, left);
    }
  }

  function creditInfo(source) {
    const isTwelve =
      source === "Twelve Data";

    return {
      apiCreditsUsed: isTwelve
        ? credits.used
        : null,

      apiCreditsLeft: isTwelve
        ? credits.left
        : null,

      apiCreditsLimit:
        isTwelve &&
        credits.left !== null
          ? credits.used + credits.left
          : null
    };
  }

  // =========================
  // TIMEFRAMES
  // =========================
  const TF = {
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
  // FOREX PAIRS
  // =========================
  const FOREX_PAIRS = new Set([
    "EURUSD", "GBPUSD", "USDJPY",
    "USDCHF", "AUDUSD", "USDCAD",
    "NZDUSD", "EURGBP", "EURJPY",
    "EURCHF", "EURAUD", "EURCAD",
    "EURNZD", "GBPJPY", "GBPCHF",
    "GBPAUD", "GBPCAD", "GBPNZD",
    "AUDJPY", "AUDCHF", "AUDCAD",
    "AUDNZD", "CADJPY", "CADCHF",
    "CHFJPY", "NZDJPY", "NZDCHF",
    "NZDCAD"
  ]);

  // =========================
  // HELPERS
  // =========================
  function normalizePair(value) {
    return String(value || "EURUSD")
      .toUpperCase()
      .trim()
      .replace(/\(QUOTEX\)/g, "")
      .replace(/QUOTEX/g, "")
      .replace(/\s+/g, "")
      .replace(/[-_/]/g, "");
  }

  function isCrypto(pair) {
    return (
      pair.endsWith("USDT") ||
      pair.endsWith("BUSD") ||
      pair.endsWith("USDC")
    );
  }

  function num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function avg(values) {
    if (!values.length) return 0;

    return values.reduce(
      (a, b) => a + b,
      0
    ) / values.length;
  }

  function clamp(value, min, max) {
    return Math.max(
      min,
      Math.min(max, value)
    );
  }

  function errorMessage(error) {
    return String(
      error?.message || "Unknown error"
    ).slice(0, 400);
  }

  // =========================
  // FETCH WITH TIMEOUT
  // =========================
  async function fetchJson(
    url,
    options = {},
    timeoutMs = 10000,
    withHeaders = false
  ) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      const raw = await response.text();

      let json;

      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(
          `Invalid JSON response (HTTP ${response.status})`
        );
      }

      if (!response.ok) {
        throw new Error(
          json?.message ||
          json?.error?.message ||
          `HTTP ${response.status}`
        );
      }

      if (withHeaders) {
        return {
          json,
          headers: response.headers
        };
      }

      return json;
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Request timed out");
      }

      throw error;
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
        "TWELVE_DATA_API_KEY is missing in Vercel"
      );
    }

    const tf = TF[timeframe];

    if (!tf) {
      throw new Error(
        `Unsupported timeframe: ${timeframe}`
      );
    }

    const symbol =
      `${pair.slice(0, 3)}/${pair.slice(3, 6)}`;

    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", tf.td);
    url.searchParams.set("outputsize", "250");
    url.searchParams.set("timezone", "UTC");
    url.searchParams.set(
      "apikey",
      TWELVE_DATA_API_KEY
    );

    const result = await fetchJson(
      url.toString(),
      {},
      12000,
      true
    );

    updateCredits(result.headers);

    const json = result.json;

    if (
      json?.status === "error" ||
      json?.code ||
      !Array.isArray(json?.values)
    ) {
      throw new Error(
        json?.message ||
        "Twelve Data returned no candle data"
      );
    }

    const candles = json.values
      .map((item) => {
        // Twelve Data requested in UTC.
        const rawTime = String(
          item.datetime || ""
        ).trim();

        const normalizedTime =
          rawTime.includes("T")
            ? rawTime
            : rawTime.replace(" ", "T");

        const time = Date.parse(
          /Z$|[+-]\d{2}:\d{2}$/.test(
            normalizedTime
          )
            ? normalizedTime
            : `${normalizedTime}Z`
        );

        return {
          time,
          open: num(item.open),
          high: num(item.high),
          low: num(item.low),
          close: num(item.close),
          volume: num(item.volume)
        };
      })
      .filter((c) =>
        Number.isFinite(c.time) &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length < 80) {
      throw new Error(
        `Not enough Twelve Data candles: ${candles.length}`
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
    const intervalMap = {
      "1m": "1m",
      "5m": "5m",
      "15m": "15m",
      "30m": "30m",
      "1h": "1h"
    };

    const interval = intervalMap[timeframe];

    if (!interval) {
      throw new Error(
        `Unsupported timeframe: ${timeframe}`
      );
    }

    const url = new URL(
      "https://api.binance.com/api/v3/klines"
    );

    url.searchParams.set("symbol", pair);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", "250");

    const data = await fetchJson(
      url.toString(),
      {},
      10000
    );

    if (!Array.isArray(data)) {
      throw new Error(
        "Binance returned invalid candle data"
      );
    }

    const candles = data
      .map((x) => ({
        time: Number(x[0]),
        open: Number(x[1]),
        high: Number(x[2]),
        low: Number(x[3]),
        close: Number(x[4]),
        volume: Number(x[5]),
        closeTime: Number(x[6])
      }))
      .filter((c) =>
        Number.isFinite(c.time) &&
        c.open > 0 &&
        c.high > 0 &&
        c.low > 0 &&
        c.close > 0
      )
      .sort((a, b) => a.time - b.time);

    if (candles.length < 80) {
      throw new Error(
        `Not enough Binance candles: ${candles.length}`
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
    if (isCrypto(pair)) {
      return {
        candles: await fetchBinance(
          pair,
          timeframe
        ),
        source: "Binance"
      };
    }

    if (FOREX_PAIRS.has(pair)) {
      return {
        candles: await fetchTwelveData(
          pair,
          timeframe
        ),
        source: "Twelve Data"
      };
    }

    throw new Error(
      `Unsupported pair: ${pair}`
    );
  }

  // =========================
  // CLOSED CANDLES
  // =========================
  function closedCandles(
    candles,
    timeframe
  ) {
    const intervalMs =
      TF[timeframe].seconds * 1000;

    const now = Date.now();

    return candles
      .filter((c) => {
        const endTime =
          Number.isFinite(c.closeTime)
            ? c.closeTime
            : c.time + intervalMs;

        return endTime <= now;
      })
      .sort((a, b) => a.time - b.time);
  }

  function candleEnd(candle, timeframe) {
    if (Number.isFinite(candle.closeTime)) {
      return candle.closeTime;
    }

    return (
      candle.time +
      TF[timeframe].seconds * 1000
    );
  }

  // =========================
  // EMA
  // =========================
  function ema(values, period) {
    if (values.length < period) return 0;

    const multiplier = 2 / (period + 1);

    let result = avg(
      values.slice(0, period)
    );

    for (
      let i = period;
      i < values.length;
      i++
    ) {
      result =
        (values[i] - result) * multiplier +
        result;
    }

    return result;
  }

  // =========================
  // RSI
  // =========================
  function rsi(values, period = 14) {
    if (values.length <= period) return 50;

    let gains = 0;
    let losses = 0;

    for (let i = 1; i <= period; i++) {
      const diff = values[i] - values[i - 1];

      if (diff >= 0) {
        gains += diff;
      } else {
        losses += Math.abs(diff);
      }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (
      let i = period + 1;
      i < values.length;
      i++
    ) {
      const diff = values[i] - values[i - 1];

      const gain = Math.max(diff, 0);
      const loss = Math.max(-diff, 0);

      avgGain =
        (avgGain * (period - 1) + gain) /
        period;

      avgLoss =
        (avgLoss * (period - 1) + loss) /
        period;
    }

    if (avgLoss === 0) return 100;

    const rs = avgGain / avgLoss;

    return 100 - 100 / (1 + rs);
  }

  // =========================
  // ATR
  // =========================
  function atr(candles, period = 14) {
    if (candles.length <= period) return 0;

    const ranges = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i];
      const previous = candles[i - 1];

      ranges.push(
        Math.max(
          current.high - current.low,
          Math.abs(
            current.high - previous.close
          ),
          Math.abs(
            current.low - previous.close
          )
        )
      );
    }

    return avg(ranges.slice(-period));
  }

  // =========================
  // MACD
  // =========================
  function macd(values) {
    if (values.length < 35) {
      return {
        macd: 0,
        signal: 0,
        histogram: 0
      };
    }

    const series = [];

    for (let i = 0; i < values.length; i++) {
      const slice = values.slice(0, i + 1);

      if (slice.length < 26) continue;

      series.push(
        ema(slice, 12) - ema(slice, 26)
      );
    }

    if (series.length < 9) {
      return {
        macd: 0,
        signal: 0,
        histogram: 0
      };
    }

    const current = series[series.length - 1];
    const signalLine = ema(series, 9);

    return {
      macd: current,
      signal: signalLine,
      histogram: current - signalLine
    };
  }

  // =========================
  // CANDLE ANALYSIS
  // =========================
  function analyzeCandle(candle) {
    const range = candle.high - candle.low;

    if (range <= 0) {
      return {
        direction: "NEUTRAL",
        bodyPercent: 0,
        upperWick: 0,
        lowerWick: 0
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
      direction:
        candle.close > candle.open
          ? "BULLISH"
          : candle.close < candle.open
          ? "BEARISH"
          : "NEUTRAL",

      bodyPercent: body / range,
      upperWick,
      lowerWick
    };
  }

  // =========================
  // SUPPORT / RESISTANCE
  // =========================
  function supportResistance(candles) {
    const recent = candles.slice(-40);

    return {
      support: Math.min(
        ...recent.map((c) => c.low)
      ),

      resistance: Math.max(
        ...recent.map((c) => c.high)
      )
    };
  }

  // =========================
  // TECHNICAL ENGINE
  // =========================
  function technicalAnalysis(candles) {
    const closes = candles.map((c) => c.close);

    const current = candles[candles.length - 1];

    const e9 = ema(closes, 9);
    const e21 = ema(closes, 21);
    const e50 = ema(closes, 50);

    const rsiValue = rsi(closes, 14);
    const atrValue = atr(candles, 14);
    const macdValue = macd(closes);

    const candle = analyzeCandle(current);
    const levels = supportResistance(candles);

    const trend = atrValue > 0
      ? clamp(
          (
            (
              Math.abs(e9 - e21) +
              Math.abs(e21 - e50)
            ) / atrValue
          ) * 25,
          0,
          100
        )
      : 0;

    let callScore = 50;
    let putScore = 50;

    // EMA structure
    if (e9 > e21 && e21 > e50) {
      callScore += 16;
    }

    if (e9 < e21 && e21 < e50) {
      putScore += 16;
    }

    // Price vs EMA
    if (current.close > e9) {
      callScore += 7;
    } else {
      putScore += 7;
    }

    if (current.close > e21) {
      callScore += 5;
    } else {
      putScore += 5;
    }

    // RSI
    if (rsiValue >= 52 && rsiValue <= 68) {
      callScore += 10;
    }

    if (rsiValue <= 48 && rsiValue >= 32) {
      putScore += 10;
    }

    if (rsiValue > 72) callScore -= 10;
    if (rsiValue < 28) putScore -= 10;

    // MACD
    if (
      macdValue.histogram > 0 &&
      macdValue.macd >= macdValue.signal
    ) {
      callScore += 10;
    }

    if (
      macdValue.histogram < 0 &&
      macdValue.macd <= macdValue.signal
    ) {
      putScore += 10;
    }

    // Candle direction
    if (candle.direction === "BULLISH") {
      callScore += 8;
    }

    if (candle.direction === "BEARISH") {
      putScore += 8;
    }

    // Strong candle body
    if (candle.bodyPercent >= 0.60) {
      if (candle.direction === "BULLISH") {
        callScore += 5;
      }

      if (candle.direction === "BEARISH") {
        putScore += 5;
      }
    }

    // Wick rejection
    if (
      candle.lowerWick >
      candle.upperWick * 1.5
    ) {
      callScore += 5;
    }

    if (
      candle.upperWick >
      candle.lowerWick * 1.5
    ) {
      putScore += 5;
    }

    // Support / resistance
    const price = current.close;

    const distanceToResistance =
      Math.abs(levels.resistance - price);

    const distanceToSupport =
      Math.abs(price - levels.support);

    if (
      atrValue > 0 &&
      distanceToResistance < atrValue * 0.20
    ) {
      callScore -= 15;
    }

    if (
      atrValue > 0 &&
      distanceToSupport < atrValue * 0.20
    ) {
      putScore -= 15;
    }

    if (
      atrValue > 0 &&
      distanceToSupport > atrValue * 0.50 &&
      price > levels.support
    ) {
      callScore += 3;
    }

    if (
      atrValue > 0 &&
      distanceToResistance > atrValue * 0.50 &&
      price < levels.resistance
    ) {
      putScore += 3;
    }

    // Recent momentum
    const recent = candles.slice(-5);

    let bullishCount = 0;
    let bearishCount = 0;

    for (const c of recent) {
      if (c.close > c.open) bullishCount++;
      if (c.close < c.open) bearishCount++;
    }

    if (bullishCount >= 3) callScore += 5;
    if (bearishCount >= 3) putScore += 5;

    // Weak EMA spread
    const emaSpread = atrValue > 0
      ? Math.abs(e9 - e21) / atrValue
      : 0;

    if (emaSpread < 0.12) {
      callScore -= 5;
      putScore -= 5;
    }

    callScore = clamp(callScore, 0, 100);
    putScore = clamp(putScore, 0, 100);

    const signal =
      callScore >= putScore
        ? "CALL"
        : "PUT";

    const edge =
      Math.abs(callScore - putScore);

    let technicalScore = clamp(
      Math.round(55 + edge * 0.55 + trend * 0.10),
      55,
      97
    );

    const quality =
      edge >= 20
        ? "STRONG"
        : edge < 8
        ? "WEAK"
        : "NORMAL";

    const tradeable =
      edge >= 8 &&
      technicalScore >= 62;

    return {
      signal,
      callScore: Math.round(callScore),
      putScore: Math.round(putScore),
      technicalScore,
      tradeable,
      quality,
      price,

      indicators: {
        ema9: e9,
        ema21: e21,
        ema50: e50,
        rsi: rsiValue,
        atr: atrValue,
        macd: macdValue.macd,
        macdSignal: macdValue.signal,
        macdHistogram: macdValue.histogram,
        trendStrength: trend,
        emaSpread
      },

      levels,

      candle: {
        direction: candle.direction,
        bodyPercent: candle.bodyPercent,
        upperWick: candle.upperWick,
        lowerWick: candle.lowerWick
      },

      momentum: {
        bullishCount,
        bearishCount
      }
    };
  }

  // =========================
  // GEMINI REQUEST
  // =========================
  async function callGeminiModel(
    model,
    prompt
  ) {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent`;

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      10000
    );

    try {
      const response = await fetch(url, {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": GEMINI_API_KEY
        },

        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: prompt }]
            }
          ],

          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 256
          }
        }),

        signal: controller.signal
      });

      const raw = await response.text();

      let data = null;

      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }

      if (!response.ok) {
        const error = new Error(
          data?.error?.message ||
          `Gemini HTTP ${response.status}`
        );

        error.status = response.status;
        error.model = model;

        throw error;
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((part) => part.text || "")
          .join("")
          .trim();

      if (!text) {
        throw new Error(
          "Gemini returned an empty response"
        );
      }

      return {
        text,
        model
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // =========================
  // GEMINI CONFIRMATION
  // =========================
  async function geminiConfirm({
    pair,
    timeframe,
    technical,
    mtf
  }) {
    if (!GEMINI_API_KEY) {
      return {
        signal: "WAIT",
        score: 0,
        status: "UNAVAILABLE",
        error: "GEMINI_API_KEY is missing in Vercel",
        reason: "Gemini API key is not configured",
        model: null
      };
    }

    const prompt = `
You are a technical market confirmation engine.

Use ONLY the supplied data.
Do not invent prices or indicators.
Do not promise profit.
Return JSON only.

PAIR: ${pair}
TIMEFRAME: ${timeframe}

TECHNICAL SIGNAL: ${technical.signal}
TECHNICAL SCORE: ${technical.technicalScore}
CALL SCORE: ${technical.callScore}
PUT SCORE: ${technical.putScore}
TRADEABLE: ${technical.tradeable}
QUALITY: ${technical.quality}

INDICATORS:
${JSON.stringify(technical.indicators)}

SUPPORT_RESISTANCE:
${JSON.stringify(technical.levels)}

CANDLE:
${JSON.stringify(technical.candle)}

MOMENTUM:
${JSON.stringify(technical.momentum)}

HIGHER_TIMEFRAME:
${JSON.stringify(mtf)}

Return this structure:
{
  "signal": "CALL",
  "score": 50,
  "reason": "Short reason"
}

signal must be CALL, PUT, or WAIT.
score must be a number from 0 to 100.
`;

    // Try the configured model first.
    // Retry with the alternate model only if the
    // selected model is unavailable.
    const models = [
      GEMINI_MODEL,
      ...(GEMINI_MODEL !== "gemini-2.5-flash-lite"
        ? ["gemini-2.5-flash-lite"]
        : []),
      ...(GEMINI_MODEL !== "gemini-3.5-flash-lite"
        ? ["gemini-3.5-flash-lite"]
        : [])
    ];

    let lastError = null;

    for (const model of [...new Set(models)]) {
      try {
        const result = await callGeminiModel(
          model,
          prompt
        );

        let parsed;

        try {
          parsed = JSON.parse(result.text);
        } catch {
          const cleaned = result.text
            .replace(/```json/gi, "")
            .replace(/```/g, "")
            .trim();

          const match = cleaned.match(
            /\{[\s\S]*\}/
          );

          if (match) {
            parsed = JSON.parse(match[0]);
          }
        }

        if (!parsed) {
          throw new Error(
            "Gemini response was not valid JSON"
          );
        }

        let signal = String(
          parsed.signal || "WAIT"
        ).toUpperCase();

        if (
          !["CALL", "PUT", "WAIT"].includes(signal)
        ) {
          signal = "WAIT";
        }

        return {
          signal,

          score: clamp(
            Math.round(num(parsed.score)),
            0,
            100
          ),

          status: "OK",
          error: null,

          reason: String(
            parsed.reason || "AI confirmation"
          ).slice(0, 300),

          model: result.model
        };
      } catch (error) {
        lastError = error;

        // Do not retry authentication, quota,
        // rate-limit, or timeout failures.
        const status = error?.status;

        if (
          status &&
          status !== 400 &&
          status !== 404
        ) {
          break;
        }

        // Only try the next model for model/request
        // compatibility errors.
        if (
          status !== 400 &&
          status !== 404
        ) {
          break;
        }
      }
    }

    let message = errorMessage(lastError);

    // Never expose the API key.
    if (GEMINI_API_KEY) {
      message = message.replace(
        GEMINI_API_KEY,
        "[REDACTED]"
      );
    }

    return {
      signal: "WAIT",
      score: 0,
      status: "ERROR",
      error: message,
      reason: message,
      model: lastError?.model || GEMINI_MODEL
    };
  }

  // =========================
  // HIGHER TIMEFRAME BIAS
  // =========================
  function getMTFBias(a5, a15) {
    const votes = [
      a5?.signal,
      a15?.signal
    ].filter((x) =>
      x === "CALL" || x === "PUT"
    );

    const calls = votes.filter(
      (x) => x === "CALL"
    ).length;

    const puts = votes.filter(
      (x) => x === "PUT"
    ).length;

    if (calls > puts) {
      return {
        bias: "CALL",
        agreement: calls === votes.length
      };
    }

    if (puts > calls) {
      return {
        bias: "PUT",
        agreement: puts === votes.length
      };
    }

    return {
      bias: "NEUTRAL",
      agreement: false
    };
  }

  // =========================
  // MAIN SCAN
  // =========================
  let responseSource = null;

  try {
    const inputPair =
      req.query?.pair ||
      req.body?.pair ||
      "EURUSD";

    const timeframe = String(
      req.query?.timeframe ||
      req.body?.timeframe ||
      "1m"
    );

    const pair = normalizePair(inputPair);

    if (!TF[timeframe]) {
      return res.status(400).json({
        ok: false,
        signal: "WAIT",
        reason: "Unsupported timeframe",
        ...creditInfo(null)
      });
    }

    if (
      !FOREX_PAIRS.has(pair) &&
      !isCrypto(pair)
    ) {
      return res.status(400).json({
        ok: false,
        signal: "WAIT",
        reason: `Unsupported pair: ${pair}`,
        ...creditInfo(null)
      });
    }

    // Fetch entry + higher timeframes.
    const [entryData, fiveData, fifteenData] =
      await Promise.all([
        getCandles(pair, timeframe),
        getCandles(pair, "5m"),
        getCandles(pair, "15m")
      ]);

    responseSource = entryData.source;

    const entryCandles = closedCandles(
      entryData.candles,
      timeframe
    );

    const fiveCandles = closedCandles(
      fiveData.candles,
      "5m"
    );

    const fifteenCandles = closedCandles(
      fifteenData.candles,
      "15m"
    );

    if (
      entryCandles.length < 80 ||
      fiveCandles.length < 80 ||
      fifteenCandles.length < 80
    ) {
      return res.status(200).json({
        ok: false,
        signal: "WAIT",
        pair,
        timeframe,
        reason: "Not enough closed candles",
        source: responseSource,
        ...creditInfo(responseSource)
      });
    }

    // =========================
    // FEED AGE
    // =========================
    const latest =
      entryCandles[entryCandles.length - 1];

    const entryEnd = candleEnd(
      latest,
      timeframe
    );

    const now = Date.now();

    const feedAgeSeconds = Math.max(
      0,
      Math.floor((now - entryEnd) / 1000)
    );

    const tf = TF[timeframe];

    // Do not generate a signal from stale candles.
    if (feedAgeSeconds > tf.staleLimit) {
      return res.status(200).json({
        ok: false,
        signal: "WAIT",
        pair,
        timeframe,
        price: latest.close,
        feedAgeSeconds,
        staleLimit: tf.staleLimit,
        feedTimestamp: new Date(
          entryEnd
        ).toISOString(),
        source: responseSource,
        reason: "Market feed is stale",
        warning:
          "No trade signal generated from stale market data.",
        ...creditInfo(responseSource)
      });
    }

    // =========================
    // TECHNICAL ANALYSIS
    // =========================
    const technical = technicalAnalysis(
      entryCandles
    );

    const analysis5 = technicalAnalysis(
      fiveCandles
    );

    const analysis15 = technicalAnalysis(
      fifteenCandles
    );

    const mtf = getMTFBias(
      analysis5,
      analysis15
    );

    // =========================
    // GEMINI
    // =========================
    const ai = await geminiConfirm({
      pair,
      timeframe,
      technical,

      mtf: {
        fiveMinute: analysis5.signal,
        fifteenMinute: analysis15.signal,
        bias: mtf.bias
      }
    });

    // =========================
    // FINAL SIGNAL
    // =========================
    let finalSignal = technical.signal;
    let finalScore = technical.technicalScore;

    if (mtf.bias === finalSignal) {
      finalScore += 5;
    } else if (mtf.bias !== "NEUTRAL") {
      finalScore -= 7;
    }

    if (
      ai.status === "OK" &&
      ai.signal === finalSignal
    ) {
      finalScore += Math.min(
        6,
        Math.round(ai.score / 20)
      );
    }

    if (
      ai.status === "OK" &&
      ai.signal !== "WAIT" &&
      ai.signal !== finalSignal
    ) {
      finalScore -= 5;
    }

    finalScore = clamp(
      Math.round(finalScore),
      55,
      98
    );

    // Weak setups remain WAIT.
    if (!technical.tradeable) {
      finalSignal = "WAIT";
      finalScore = Math.min(finalScore, 61);
    }

    // =========================
    // NEXT CANDLE
    // =========================
    const intervalMs = tf.seconds * 1000;

    const nextCandleStart = entryEnd;
    const nextCandleEnd =
      nextCandleStart + intervalMs;

    // =========================
    // RESPONSE
    // =========================
    return res.status(200).json({
      ok: true,

      pair,
      timeframe,

      signal: finalSignal,
      score: finalScore,

      technicalSignal: technical.signal,
      technicalScore: technical.technicalScore,
      callScore: technical.callScore,
      putScore: technical.putScore,

      tradeable: technical.tradeable,
      quality: technical.quality,

      aiSignal: ai.signal,
      aiScore: ai.score,
      aiStatus: ai.status,
      aiReason: ai.reason,
      aiError: ai.error,
      aiModel: ai.model,

      mtf: {
        bias: mtf.bias,
        agreement: mtf.agreement,

        fiveMinute: analysis5.signal,
        fiveMinuteScore: analysis5.technicalScore,

        fifteenMinute: analysis15.signal,
        fifteenMinuteScore: analysis15.technicalScore
      },

      indicators: technical.indicators,
      levels: technical.levels,
      candle: technical.candle,
      momentum: technical.momentum,

      price: technical.price,

      feedAgeSeconds,

      feedTimestamp: new Date(
        entryEnd
      ).toISOString(),

      nextCandleStart: new Date(
        nextCandleStart
      ).toISOString(),

      nextCandleEnd: new Date(
        nextCandleEnd
      ).toISOString(),

      source: responseSource,

      ...creditInfo(responseSource),

      warning:
        "Market-data feed may differ from Quotex execution price. No signal system can guarantee a winning trade."
    });
  } catch (error) {
    console.error("SCAN ERROR:", error);

    return res.status(200).json({
      ok: false,
      signal: "WAIT",
      score: 0,
      reason: errorMessage(error),
      source: responseSource,
      ...creditInfo(responseSource)
    });
  }
}
